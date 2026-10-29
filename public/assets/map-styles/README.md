# Map styles

The map uses OpenFreeMap's Liberty style (OpenStreetMap data via
OpenMapTiles), with no API key:

`https://tiles.openfreemap.org/styles/liberty`

A copy is bundled at `src/offline/liberty-style.json`, so the map opens
without a network. `buildMapStyle()` in `src/offline/tile-protocol.ts`
points its tiles, fonts and icons at the app's `tcmap://` protocol. That
reads tiles from the phone's tile store (PMTiles, filled by saved trips and
areas) when it has them, and from OpenFreeMap otherwise. To pick up a newer Liberty style, replace the
copy with the file at the URL above.

Offline maps follow OpenFreeMap's terms for offline use: at most 3,000
tiles or 50 MB per download, 4 requests at a time, with an identifying
User-Agent (`appendUserAgent` in `capacitor.config.ts`). Do not
bulk-download tiles from the public OpenStreetMap tile servers.

Attribution: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap
contributors (ODbL). MapLibre's attribution control shows it, and shared
map files carry it in their metadata. Liberty is based on OSM Liberty
(BSD licence) and Maputnik's OSM Liberty.

`online-style.json` describes the online source and is kept for reference.
