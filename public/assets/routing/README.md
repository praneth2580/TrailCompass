# Offline routing data

TrailCompass routes **offline** against local road-network data. Map tiles (PMTiles) are separate from routing graphs.

## Bundled demo network

`demo-network.geojson` is a small OpenStreetMap extract around Paris Trocadéro
(bbox ≈ `2.294–2.305 E`, `48.856–48.8625 N`), used by the built-in graph engine.

Attribution: © OpenStreetMap contributors (ODbL).

## Valhalla tiles (optional)

When a Valhalla tile archive is present at
`public/assets/routing/valhalla-tiles.tar` (or loaded from device storage),
the app prefers the Valhalla WASM engine for that region.

Build tiles yourself (example):

```bash
# Requires Docker + an OSM PBF for your region
docker run --rm -v "$PWD:/data" ghcr.io/valhalla/valhalla:latest \
  valhalla_build_tiles -c /data/valhalla.json /data/region.osm.pbf
tar -cf public/assets/routing/valhalla-tiles.tar -C /path/to/valhalla_tiles .
```

Do not call online routing APIs as a silent fallback.
