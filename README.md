# TrailCompass

**TrailCompass** is a standalone Android navigation app for motorcycle touring, built with **Vite, React, TypeScript, and Capacitor**. Its goal is to provide an offline-capable map, compass, GPS positioning, and turn-by-turn navigation without requiring an internet connection during a ride.

> **Project status:** Architecture / early development. Offline map serving and routing integration must be validated on a real Android device before the app is relied on for navigation.

## Goals

- Display a map while riding.
- Show the current GPS position and movement direction.
- Provide a compass heading, including while stationary when supported by the device sensors.
- Download regional map packages for offline use.
- Calculate routes and provide turn-by-turn instructions offline.
- Detect missed turns and support offline rerouting.
- Keep the interface readable and easy to operate on a motorcycle.
- Store downloaded map files and saved routes locally.

## Planned technology

| Area | Technology | Purpose |
|---|---|---|
| UI | React + TypeScript | Application screens and controls |
| Build tooling | Vite | Development server and production build |
| Android runtime | Capacitor | Package the web app as an Android app |
| Map rendering | MapLibre GL JS | Interactive map display |
| Offline map data | PMTiles or a compatible local tile package | Store regional map tiles |
| GPS | `@capacitor/geolocation` | Location fixes and movement updates |
| Motion / sensors | Capacitor motion APIs or a small native plugin | Device-orientation data, where available |
| Local files | `@capacitor/filesystem` or a dedicated native bridge | Store large map packages |
| Local persistence | Start with JSON/files; add SQLite when needed | Region metadata, saved routes, trip records |
| Routing | `RoutingAdapter` interface with an offline engine behind it | Route calculation and turn instructions |

Exact package versions should be aligned with the selected Capacitor major version. Check plugin compatibility before upgrading.

## Architecture

```text
┌─────────────────────────────────────────────┐
│                  React UI                    │
│ Map · Compass · Navigation · Downloads       │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│                App services                  │
│ Location · Heading · Navigation · Trips     │
└──────────────┬─────────────────┬────────────┘
               │                 │
┌──────────────▼─────────┐  ┌────▼─────────────┐
│       MapAdapter       │  │ RoutingAdapter   │
│ MapLibre GL JS         │  │ Offline engine   │
│ + local tile bridge    │  │ + instructions   │
└──────────────┬─────────┘  └────┬─────────────┘
               │                 │
┌──────────────▼─────────────────▼────────────┐
│           Local Android storage             │
│ Map packages · Region metadata · Routes     │
└─────────────────────────────────────────────┘
```

### Important offline-map design note

MapLibre GL JS renders maps in a WebView, but it does not provide the same built-in offline-region workflow as MapLibre Native. The app therefore needs a reliable way to read local tile data on Android, such as a tested local tile/protocol bridge or a compatible native plugin.

Do not assume that a PMTiles or MBTiles file placed in the app's filesystem will automatically be readable by the WebView. Validate local file access, range requests, memory use, and app restart behavior on the target Android version before building large regional downloads.

**PMTiles contains map tiles, not routing data.** Offline route calculation needs a separate routing engine and compatible road-network data.

## Repository layout

The structure below is the intended direction; files may be added as implementation progresses.

```text
trailcompass/
├── public/
│   └── assets/
│       └── map-styles/
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   └── routes.tsx
│   ├── components/
│   │   ├── MapView.tsx
│   │   ├── CompassWidget.tsx
│   │   ├── NavigationBanner.tsx
│   │   └── DownloadProgress.tsx
│   ├── services/
│   │   ├── location.service.ts
│   │   ├── compass.service.ts
│   │   ├── map.service.ts
│   │   └── navigation.service.ts
│   ├── offline/
│   │   ├── region-manager.ts
│   │   ├── tile-protocol.ts
│   │   ├── package-validator.ts
│   │   └── storage-manager.ts
│   ├── routing/
│   │   ├── routing-adapter.ts
│   │   ├── route-matcher.ts
│   │   └── turn-instructions.ts
│   ├── database/
│   │   ├── database.ts
│   │   └── trip-repository.ts
│   └── types/
│       ├── region.ts
│       ├── route.ts
│       └── navigation.ts
├── android/
├── capacitor.config.ts
├── package.json
└── vite.config.ts
```

## Prerequisites

Install the following before starting:

- Node.js LTS and npm
- Git (recommended)
- Android Studio
- Android SDK and a compatible JDK, as required by the selected Capacitor version
- An Android phone and USB cable for device testing

A physical Android device is strongly recommended for testing compass sensors, GPS behavior, storage access, heat, and power consumption.

## Getting started

### 1. Create the Vite project

```bash
npm create vite@latest trailcompass -- --template react-ts
cd trailcompass
npm install
```

### 2. Install Capacitor

Install matching, compatible versions of the Capacitor core, CLI, and Android packages. These commands use npm's current compatible package resolution; if the project already pins a Capacitor major version, keep all Capacitor packages on that major.

```bash
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli
```

Initialize Capacitor:

```bash
npx cap init
```

Use an app name such as `TrailCompass` and an application ID you control, for example `com.example.trailcompass`. Replace the example ID before publishing.

### 3. Add Android

```bash
npx cap add android
```

### 4. Install initial plugins and map packages

```bash
npm install @capacitor/geolocation @capacitor/filesystem @capacitor/preferences
npm install maplibre-gl pmtiles
```

Motion and SQLite packages can be added after checking compatibility with the selected Capacitor version and confirming the app needs them. Keep the first prototype small so the offline map path can be tested early.

### 5. Add a basic map screen

Import MapLibre's stylesheet in the app entry point or map component:

```ts
import 'maplibre-gl/dist/maplibre-gl.css';
```

Create a map container with a defined width and height, initialize the map only after the container is mounted, and dispose of the map instance when the component unmounts.

The map screen loads OpenFreeMap's Liberty style (`https://tiles.openfreemap.org/styles/liberty`) while a network connection is available. That style is online map data, not an offline package. The local PMTiles bridge is still the next step for downloaded regions. Do not bulk-download tiles from the public OpenStreetMap tile servers.

### 6. Build and sync Android

```bash
npm run build
npx cap sync android
npx cap open android
```

Run the app on a device from Android Studio. Repeat `npm run build` and `npx cap sync android` after web code or native plugin changes.

## Development commands

Typical Vite commands:

```bash
npm run dev       # Run the web development server
npm run build     # Type-check/build according to the Vite template
npm run preview   # Preview the production web build
```

For Android testing, use the build-and-sync workflow above. The Vite development server is useful for UI work, but it does not prove that local map files work in the packaged Android WebView.

## Core interfaces

### Routing adapter

Keep the navigation UI independent from the selected routing engine:

```ts
export type Coordinate = [longitude: number, latitude: number];

export interface TurnInstruction {
  text: string;
  distanceMeters: number;
  maneuver?: string;
}

export interface CalculatedRoute {
  coordinates: Coordinate[];
  distanceMeters: number;
  durationSeconds: number;
  instructions: TurnInstruction[];
}

export interface RoutingAdapter {
  calculateRoute(
    start: Coordinate,
    end: Coordinate,
    waypoints?: Coordinate[],
  ): Promise<CalculatedRoute>;
}
```

This is an application contract, not a working routing implementation. A real offline engine must provide the route geometry, maneuvers, compatible map/road data, and licensing information.

### Map adapter

Keep the UI independent from the tile-storage implementation. The map adapter should expose operations such as:

- Initialize the map.
- Show the current position.
- Fit the viewport to a route.
- Draw and clear a route.
- Switch to a downloaded region.
- Report missing or invalid map data.

This makes it possible to replace the WebView tile bridge or map renderer without rewriting the navigation screens.

## Offline region packages

A region package should eventually include:

- A unique region ID and display name.
- Geographic bounds.
- Package format and schema version.
- File size and checksum.
- Map-data attribution and license details.
- Download state and last validation time.
- Any routing-data package required for offline navigation.

The region manager should support resumable downloads, integrity checks, cancellation, insufficient-storage warnings, deletion, and recovery after the app is closed unexpectedly.

Do not bulk-download tiles from the public OpenStreetMap tile servers. Use a provider that explicitly permits offline downloads, or create and distribute regional packages in accordance with the relevant data and style licenses.

## GPS and compass behavior

- Request location permission clearly and handle denial or revocation.
- Show GPS accuracy and indicate when a fix is stale.
- GPS heading is generally useful only while moving; it is not a reliable stationary compass.
- A stationary compass requires device orientation/magnetic sensor data and may need calibration.
- Sensor readings can be affected by the motorcycle, magnetic mounts, wiring, and nearby metal.
- Smooth heading changes, but do not hide poor accuracy.
- Test portrait/landscape behavior and sensor availability on the actual phone.

## Navigation behavior

The navigation service should eventually handle:

1. Route planning from the current location to a destination, with optional waypoints.
2. Turn-instruction selection based on distance to the next maneuver.
3. Heading-aware map rotation, if enabled.
4. Missed-turn detection.
5. Offline rerouting, when supported by the selected engine and downloaded data.
6. Audio prompts and safe, glanceable visual instructions.
7. Pause/resume and trip recovery after app interruption.

The app should not encourage interaction while the motorcycle is moving. Configure destinations and map downloads while stopped, and use suitable mounting and weather protection.

## Development roadmap

### Milestone 1: Android shell

- [x] Create the Vite + React + TypeScript project.
- [x] Add Capacitor and build an Android APK.
- [ ] Confirm the app launches on the target phone.

### Milestone 2: Position and compass

- [x] Display the current GPS position.
- [x] Show fix age and accuracy.
- [x] Add compass heading and calibration guidance.
- [x] Handle missing permissions and unavailable sensors.

### Milestone 3: Real offline map

- [ ] Select a lawful map-data source and style.
- [ ] Implement the local tile bridge.
- [ ] Load a small regional package.
- [ ] Verify it works in airplane mode and after an app restart.

### Milestone 4: Offline routing

- [ ] Select a compatible offline routing engine.
- [ ] Obtain road-network data for the test region.
- [ ] Implement `RoutingAdapter`.
- [ ] Render route geometry and maneuver instructions.
- [ ] Test missed turns and rerouting without network access.

### Milestone 5: Regional downloads and touring UX

- [ ] Add region selection and download progress.
- [ ] Support pause/resume, checksums, and deletion.
- [ ] Add saved destinations, waypoints, and trip history.
- [ ] Improve riding readability and audio guidance.
- [ ] Test storage limits, power use, heat, and recovery.

## First acceptance test

Do not scale up to state-sized downloads until this test passes:

1. Install the app on the intended Android phone.
2. Download a small, legally sourced map region.
3. Close and reopen the app.
4. Enable airplane mode.
5. Confirm the map still renders and GPS positioning works.
6. Calculate an offline route between two points inside the downloaded region.
7. Follow the route far enough to test at least one maneuver.
8. Confirm the app reports missing data or routing failure clearly instead of silently falling back to the internet.

## Safety and limitations

TrailCompass is an experimental project, not a certified navigation or safety system. GPS, compass sensors, maps, and routing data can be inaccurate or unavailable. Keep a backup navigation method, obey road rules, and never operate the phone while riding.

## Licensing and attribution

Before distributing the app or map packages, review the licenses and attribution requirements for every map provider, style, routing engine, and dataset used. OpenStreetMap data is available under the Open Database License (ODbL); that does not mean every tile server or rendered map style permits bulk downloads or redistribution. Include required attribution in the app and in downloaded packages.

## Contributing

Contributions are welcome. Before proposing a change:

1. Describe the behavior or bug.
2. Test the change in the browser and on Android where relevant.
3. Include reproduction steps for device-specific issues.
4. Document new native plugins, data sources, permissions, and licensing requirements.

## License

No project license has been selected yet. Add a `LICENSE` file before accepting external contributions or distributing the application.
