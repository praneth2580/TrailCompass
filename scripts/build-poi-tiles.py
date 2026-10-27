#!/usr/bin/env python3
"""Build the bundled fuel and food tiles in public/assets/poi/ from Overture Maps.

OpenStreetMap maps few fuel stations and places to eat along Indian highways,
so TrailCompass ships Overture Maps places (Meta, Microsoft, AllThePlaces and
others) for the countries it covers. The app loads only the 1-degree tiles a
search touches, and works offline; elsewhere it uses live OpenStreetMap.

Usage (needs Python 3.10+ and network access to Overture's public S3 bucket):

    python3 -m pip install duckdb==1.5.6
    python3 scripts/build-poi-tiles.py [--country IN] [--release 2026-10-21.0]

--country takes ISO 3166-1 alpha-2 codes and can be repeated (default: IN).
A place is kept when it lies inside Overture's boundary for one of those
countries, including territorial waters so coastal places are not lost.
The India scan takes about ten minutes. Without --release, the latest
release is read from https://stac.overturemaps.org/catalog.json.

The weekly GitHub workflow .github/workflows/pages.yml runs this with
--out when Overture publishes a new release, and publishes the result on
GitHub Pages, where the app downloads it (src/services/poi-data.service.ts).
"""

import argparse
import collections
import datetime
import json
import math
import pathlib
import shutil
import urllib.request

import duckdb

OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'assets' / 'poi'
DEFAULT_COUNTRIES = ['IN']
CATEGORIES = {
    'fuel': ('gas_station', 'fueling_station'),
    'food': ('restaurant', 'casual_eatery', 'cafe', 'fast_food_restaurant', 'food_court'),
}
# Overture's own confidence; low scores are often duplicates or closed places.
MIN_CONFIDENCE = {'fuel': 0.4, 'food': 0.6}
TILE_DEG = 1
# Losing more than this share of a kind's places since the last build is more
# likely a broken scan or an Overture schema change than real closures.
MAX_DROP = 0.2


def latest_release() -> str:
    with urllib.request.urlopen('https://stac.overturemaps.org/catalog.json', timeout=30) as r:
        return json.load(r)['latest']


def dropped_kinds(previous: dict | None, countries: list[str], counts: dict[str, int]) -> list[str]:
    """Kinds whose place count fell by more than MAX_DROP since the last build
    for the same countries, as 'kind: before -> after'."""
    if not previous or previous.get('countries') != countries:
        return []
    dropped = []
    for kind, count in counts.items():
        before = previous.get('kinds', {}).get(kind, {}).get('count')
        if before and count < before * (1 - MAX_DROP):
            dropped.append(f'{kind}: {before} -> {count}')
    return dropped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--release', help='Overture release, e.g. 2026-10-21.0')
    parser.add_argument(
        '--country', action='append',
        help='ISO 3166-1 alpha-2 country code; repeat for several (default: IN)',
    )
    parser.add_argument(
        '--allow-drop', action='store_true',
        help=f'replace the data even if a kind lost more than {MAX_DROP:.0%} of its places',
    )
    parser.add_argument(
        '--out', type=pathlib.Path, default=OUT_DIR,
        help='output folder (default: public/assets/poi, the copy bundled in the app)',
    )
    parser.add_argument(
        '--previous', type=pathlib.Path,
        help='manifest of the data being replaced, for the drop check (default: OUT/manifest.json)',
    )
    args = parser.parse_args()
    out_dir: pathlib.Path = args.out
    release = args.release or latest_release()
    countries = sorted({c.upper() for c in (args.country or DEFAULT_COUNTRIES)})
    print(f'Overture release {release}, countries {", ".join(countries)}')

    base = f's3://overturemaps-us-west-2/release/{release}'
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")

    # Land and territorial waters; the land outline alone drops coastal places.
    con.execute(
        f"""
        CREATE TABLE boundary AS
        SELECT geometry, bbox
        FROM read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning=1)
        WHERE subtype = 'country' AND country IN ({','.join('?' * len(countries))})
        """,
        countries,
    )
    xmin, xmax, ymin, ymax = con.execute(
        'SELECT min(bbox.xmin), max(bbox.xmax), min(bbox.ymin), max(bbox.ymax) FROM boundary'
    ).fetchone()
    if xmin is None:
        raise SystemExit(f'No Overture boundary found for {", ".join(countries)}')

    wanted = [c for cats in CATEGORIES.values() for c in cats]
    con.execute(
        f"""
        CREATE TABLE candidates AS
        SELECT basic_category AS category, names.primary AS name, confidence,
               ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
               list_transform(sources, lambda s: s.license) AS licenses
        FROM read_parquet('{base}/theme=places/type=place/*', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?
          AND basic_category IN ({','.join('?' * len(wanted))})
          AND coalesce(operating_status, 'open') = 'open'
        """,
        [xmin, xmax, ymin, ymax, *wanted],
    )

    # Testing every place against the full, detailed boundary takes minutes;
    # against the boundary clipped to each 1-degree square it takes seconds.
    con.execute(
        """
        CREATE TABLE pieces AS
        SELECT tx, ty, ST_Intersection(b.geometry, ST_MakeEnvelope(tx, ty, tx + 1, ty + 1)) AS geometry
        FROM (SELECT DISTINCT floor(lon)::INT AS tx, floor(lat)::INT AS ty FROM candidates) AS t,
             boundary AS b
        WHERE ST_Intersects(b.geometry, ST_MakeEnvelope(tx, ty, tx + 1, ty + 1))
        """
    )
    rows = con.execute(
        """
        SELECT category, name, confidence, lon, lat, licenses
        FROM candidates AS c
        WHERE EXISTS (
          SELECT 1 FROM pieces AS p
          WHERE p.tx = floor(c.lon)::INT AND p.ty = floor(c.lat)::INT
            AND ST_Contains(p.geometry, ST_Point(c.lon, c.lat))
        )
        """
    ).fetchall()
    total = con.execute('SELECT count(*) FROM candidates').fetchone()[0]
    print(f'{len(rows)} of {total} candidate places are inside the boundary')

    kind_of = {cat: kind for kind, cats in CATEGORIES.items() for cat in cats}
    tiles: dict[str, dict[str, list]] = {kind: collections.defaultdict(list) for kind in CATEGORIES}
    licenses: collections.Counter = collections.Counter()
    for category, name, confidence, lon, lat, source_licenses in rows:
        kind = kind_of[category]
        if (confidence or 0) < MIN_CONFIDENCE[kind]:
            continue
        key = f'{math.floor(lon / TILE_DEG)}_{math.floor(lat / TILE_DEG)}'
        tiles[kind][key].append((round(lon * 1e5), round(lat * 1e5), (name or '').strip()))
        licenses.update(set(source_licenses or []))

    manifest_path = out_dir / 'manifest.json'
    previous_path = args.previous or manifest_path
    previous = json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else None
    counts = {kind: sum(len(places) for places in by_tile.values()) for kind, by_tile in tiles.items()}
    dropped = dropped_kinds(previous, countries, counts)
    if dropped and not args.allow_drop:
        raise SystemExit(
            f'Refusing to replace the data: place counts fell by more than {MAX_DROP:.0%} '
            f'({"; ".join(dropped)}). Pass --allow-drop if that is expected.'
        )

    for kind in CATEGORIES:
        shutil.rmtree(out_dir / kind, ignore_errors=True)
    manifest = {
        'version': 1,
        'source': f'Overture Maps Foundation, release {release} (places theme)',
        'release': release,
        'countries': countries,
        'generated': datetime.date.today().isoformat(),
        'tileDegrees': TILE_DEG,
        'licenses': dict(licenses.most_common()),
        'kinds': {},
    }
    for kind, by_tile in tiles.items():
        (out_dir / kind).mkdir(parents=True, exist_ok=True)
        count = 0
        for key, places in sorted(by_tile.items()):
            places.sort()
            names = ['']
            name_index = {'': 0}
            flat = []
            for lon, lat, name in places:
                if name not in name_index:
                    name_index[name] = len(names)
                    names.append(name)
                flat += [lon, lat, name_index[name]]
            body = json.dumps({'v': 1, 'names': names, 'p': flat}, ensure_ascii=False, separators=(',', ':'))
            (out_dir / kind / f'{key}.json').write_text(body, encoding='utf-8')
            count += len(places)
        manifest['kinds'][kind] = {'count': count, 'tiles': sorted(by_tile)}
        print(f'{kind}: {count} places in {len(by_tile)} tiles')

    manifest_path.write_text(json.dumps(manifest, indent=1) + '\n', encoding='utf-8')
    size = sum(f.stat().st_size for f in out_dir.rglob('*.json'))
    print(f'wrote {out_dir} ({size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
