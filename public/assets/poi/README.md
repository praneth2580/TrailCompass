# Bundled fuel and food places

Fuel stations and places to eat for India, used by the Plan tab's fuel and
food suggestions and its Browse list. They ship with the app so
suggestions work offline. Outside India, the app uses live OpenStreetMap
only. They also fill gaps where
OpenStreetMap has few places mapped: along NH66 between Panvel and
Chiplun, OSM had 17 fuel stations and 21 places to eat near the road,
and Overture had 36 and 286.

- `manifest.json`: the source release, the countries covered, the build
  date, the licences seen, and which 1° tiles exist for each kind.
- `fuel/<lon>_<lat>.json`, `food/<lon>_<lat>.json`: one file per 1° tile.
  The format is `{ "v": 1, "names": [...], "p": [lonE5, latE5, nameIndex, ...] }`.
  Name index 0 means the place has no name.

The app loads only the tiles a search touches (`src/services/bundled-pois.service.ts`).
It adds live OpenStreetMap results where the bundled ones are few
(`src/services/poi-search.service.ts`).

## Updates without a new APK

`.github/workflows/pages.yml` runs every Monday. When Overture has
published a new release, the workflow rebuilds the tiles and publishes them
on GitHub Pages, next to the landing page, at
<https://praneth2580.github.io/TrailCompass/poi/>:

- `poi/manifest.json`: the latest release
- `poi/<release>/…`: its tiles

The app checks that address at most once a day when online. If the
release there is newer than the copy it has, it downloads the tiles
(about 3 MB) into its data folder and switches to them once the download
is complete (`src/services/poi-data.service.ts`). The bundled copy stays
as the fallback. The Offline tab shows the version in use and has a
"Check for updates" button.

One-time setup on GitHub:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Actions → Publish site → **Run workflow**, to publish the first copy.

A fork can point the app at its own site by building with
`VITE_POI_DATA_URL=https://<owner>.github.io/<repo>/poi`.

## Rebuilding by hand

This refreshes the copy bundled in the APK:

```bash
python3 -m pip install duckdb==1.5.6
npm run data:poi        # python3 scripts/build-poi-tiles.py; about 10 minutes
```

The script reads the latest Overture release from its public S3 bucket.
It keeps open places with an Overture confidence of at least 0.4 (fuel)
or 0.6 (food).

It keeps places inside Overture's boundary for India: land plus
territorial waters, so coastal places are kept. That boundary follows the
areas India administers. It includes Ladakh, Arunachal Pradesh, the
Andaman and Nicobar Islands and Lakshadweep. It leaves out neighbouring
countries, Pakistan-administered Kashmir and Aksai Chin.

To add countries, pass ISO codes, for example
`python3 scripts/build-poi-tiles.py --country IN --country NP`.

## Source and licences

Data from the [Overture Maps Foundation](https://overturemaps.org) places
theme, which combines several providers, each under its own licence
(see `licenses` in `manifest.json` and
<https://docs.overturemaps.org/attribution/>):

- Meta, Microsoft and most other providers:
  [CDLA Permissive 2.0](https://cdla.dev/permissive-2-0/)
- AllThePlaces: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Foursquare: [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0),
  Copyright 2024 Foursquare Labs, Inc.

The suggestion sheets credit "Overture Maps Foundation" alongside
"© OpenStreetMap contributors" for the live results.
