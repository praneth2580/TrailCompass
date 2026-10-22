# Map styles

The live basemap is OpenFreeMap's Liberty style:

`https://tiles.openfreemap.org/styles/liberty`

It is an online vector style (OpenStreetMap data via OpenMapTiles). The phone needs a network connection to load new areas. MapLibre's attribution control shows the credit that comes with the tiles.

Offline regional packages still go through the local PMTiles bridge (`src/offline/tile-protocol.ts`). This online style is not offline map data. Do not bulk-download tiles from the public OpenStreetMap tile servers.
