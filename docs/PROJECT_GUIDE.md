# TrailCompass — Project Guide

This guide explains how TrailCompass works, one part at a time. It covers what each folder and file does, how data moves between them, and the main design decisions. It also lists known gaps. Read it before changing the routing, navigation or map code.

It describes the working tree as of **2026-10-23** (app version `1.1.0`, Android `versionCode 6`), including the uncommitted `src/routing/abort.ts` and `src/routing/overpass-scheduler.ts`.

> The top-level `README.md` describes the original plan. Several parts are out of date: it says offline routing is not started, and its repository layout is missing about half of today's files. Where the two disagree, this guide follows the code.

---

## Contents

1. [What the app is](#1-what-the-app-is)
2. [Tech stack](#2-tech-stack)
3. [Repository map](#3-repository-map)
4. [Architecture](#4-architecture)
5. [App shell (`src/app`, `src/main.tsx`)](#5-app-shell)
6. [Screens and components (`src/components`)](#6-screens-and-components)
7. [Services (`src/services`)](#7-services)
8. [Routing subsystem (`src/routing`)](#8-routing-subsystem)
9. [Navigation lifecycle end to end](#9-navigation-lifecycle-end-to-end)
10. [Persistence (`src/database`, storage keys)](#10-persistence)
11. [Offline map subsystem (`src/offline`) — stubs](#11-offline-map-subsystem)
12. [Types (`src/types`)](#12-types)
13. [Hooks (`src/hooks`)](#13-hooks)
14. [Styling (`src/index.css`)](#14-styling)
15. [Public assets](#15-public-assets)
16. [Android project and build scripts](#16-android-project-and-build-scripts)
17. [What needs a network connection](#17-what-needs-a-network-connection)
18. [Unused and stub code](#18-unused-and-stub-code)
19. [Known issues and gaps](#19-known-issues-and-gaps)
20. [Developer workflow cheat sheet](#20-developer-workflow-cheat-sheet)

---

## 1. What the app is

TrailCompass is an Android navigation app for motorcycle touring. It is a React web app packaged with Capacitor. It provides:

- A live map with your GPS position, speed and accuracy.
- A compass based on the phone's orientation sensors.
- Trip planning: a destination, plus ordered stops (fuel, food or custom) along the way.
- Route calculation on the phone, with three route types (Fastest, Shortest, Less traffic) and up to three alternative routes.
- Turn-by-turn navigation with off-route detection and automatic rerouting.
- Fuel stop suggestions based on tank range, and food stop suggestions based on meal times.
- A route library: save routes, open them later, and share or import them as `.trailcompass.json` files.
- An automatic cache of downloaded road data ("road packs"), so later plans in the same area skip the download.

**Current status:**

| Capability | Status |
|---|---|
| Map display | Works. Uses **online** tiles (OpenFreeMap). |
| Offline map tiles (PMTiles) | Not built. Interfaces exist; the bridge is a stub. |
| GPS and compass | Work. |
| Route calculation | Works. Runs on the phone (A\*), but downloads road data from Overpass unless it is already cached. |
| Valhalla WASM routing | Optional. Turns on only if a tile archive is bundled. None is shipped. |
| Turn-by-turn and rerouting | Works, with known accuracy limits (see §19). |
| Region map downloads | Stub. Always ends in an error state. |
| Trip history | A repository exists but nothing uses it. |

---

## 2. Tech stack

| Layer | Technology | Notes |
|---|---|---|
| UI | React 19, TypeScript 6 | Function components and hooks. No state library: services hold state and components subscribe to them. |
| Build | Vite 8 | `base: './'` so asset paths resolve inside the Android WebView. Source maps are on. |
| Lint | oxlint | `.oxlintrc.json`: react, typescript and oxc plugins; rules-of-hooks is an error. |
| Tests | Vitest 4 | Unit tests for the routing code, next to it as `src/routing/*.test.ts`. Node environment. |
| Native shell | Capacitor 7 | Plugins: Geolocation, Filesystem, Preferences, Share. |
| Map | MapLibre GL JS 6 | Vector style from OpenFreeMap. The worker URL is set explicitly for Vite. |
| Tiles (future) | `pmtiles` 4 | Installed, but not used yet. |
| Routing (optional) | `@jansoft/mbujkanji-valhalla-wasm` | Loaded with a dynamic import, only if tiles exist. |
| Road data | Overpass API (OSM) | Downloaded per route corridor and turned into a graph in memory. |
| Geocoding | Nominatim (OSM) | Free-text place search. |
| Android build | Gradle, JDK 21, SDK 35 | Driven by the Node scripts in `scripts/`. |

---

## 3. Repository map

```text
trailcompass/
├── index.html                  Web entry; loads Google Fonts, mounts #root
├── vite.config.ts              base './', outDir dist, sourcemaps
├── capacitor.config.ts         appId com.example.trailcompass, webDir dist, https scheme
├── tsconfig*.json              Strict-ish TS (noUnused*, verbatimModuleSyntax, erasableSyntaxOnly)
├── .oxlintrc.json              Lint config
├── package.json                Scripts for dev / build / Android / release / icons
│
├── src/
│   ├── main.tsx                React root (StrictMode)
│   ├── index.css               All styling (~2.4k lines, design tokens in :root)
│   ├── app/
│   │   ├── App.tsx             The app shell: global state, wiring, screen switch
│   │   └── routes.tsx          Tab table: map / plan / library / downloads
│   ├── components/             Screens, sheets, banners, widgets
│   ├── services/               Singletons: location, compass, map, navigation, trip, search…
│   ├── routing/                Routing engine, OSM loader, geometry, file format
│   ├── database/               JSON key-value repositories on Capacitor Preferences
│   ├── offline/                Map-package plumbing (mostly stubs)
│   ├── hooks/                  useRideFullscreen
│   └── types/                  Shared domain types
│
├── public/
│   ├── assets/map-styles/      Online style descriptor + README
│   ├── assets/routing/         demo-network.geojson (Paris Trocadéro) + README
│   └── favicon / icons
│
├── resources/                  Master icon (png/svg) for tooling
├── scripts/                    Android build/run, release, icon generation
└── android/                    Capacitor-generated Android Studio project
```

---

## 4. Architecture

### 4.1 Layers

```text
┌──────────────────────────────────────────────────────────────────┐
│ React UI  (App.tsx + components/)                                │
│  Map tab · Plan tab · Library tab · Offline tab · sheets/banners  │
└───────────────┬──────────────────────────────────────────────────┘
                │ subscribe(listener) / method calls
┌───────────────▼──────────────────────────────────────────────────┐
│ Services (singletons)                                            │
│  locationService  compassService  navigationService  tripPlanner │
│  mapService       routeLibrary    roadPackService                │
│  place-search     poi-search      stop-suggest                   │
└───────┬───────────────────────┬───────────────────────┬──────────┘
        │                       │                       │
┌───────▼───────────┐  ┌────────▼─────────────────┐  ┌──▼─────────────────┐
│ MapLibre GL       │  │ Routing                  │  │ Persistence         │
│ (map.service)     │  │ OfflineRoutingAdapter    │  │ JsonDatabase        │
│ OpenFreeMap style │  │  ├ Valhalla WASM (opt.)  │  │  (Preferences)      │
│                   │  │  └ OfflineGraphEngine A* │  │ StorageManager      │
│                   │  │ osm-network-loader ──────┼──┼─▶ road packs on disk │
└───────────────────┘  └──────────┬───────────────┘  └─────────────────────┘
                                  │ HTTPS
                       Overpass API mirrors (OSM road data)
```

### 4.2 Patterns used throughout

- **Module-level singletons.** Each service file ends with `export const xService = new XService()`. All callers share one instance. The React tree never creates services.
- **Observer pattern instead of a store.** Stateful services have `subscribe(listener) → unsubscribe` and call listeners from `setState`. Most `subscribe` calls fire the listener once right away with the current state. `App.tsx` subscribes once on mount and copies each service's state into React state.
- **Immutable state objects.** Services replace their `state` object (`{ ...this.state, ... }`) instead of changing it in place, so React sees a new reference.
- **Coordinates are `[longitude, latitude]` everywhere** (GeoJSON order). The `Coordinate` type is defined in `routing/routing-adapter.ts`. Only Nominatim, Overpass and Valhalla requests use `lat, lon` order, and the conversion happens at those boundaries.
- **No fake progress.** `RoutingProgress.percent` is `null` unless a real total is known, such as `Content-Length` or a leg count. The UI shows a spinner in that case.
- **Cancellation by token and AbortSignal.** Every plan or reroute increments a token. Results from an old token are ignored, and its network requests are aborted (§9.4).
- **No silent online routing fallback.** This is a deliberate rule, stated in several comments. Routes are always computed on the phone. The only network calls are for raw road data.

---

## 5. App shell

### 5.1 `src/main.tsx`

Mounts `<App />` inside `StrictMode` and imports `index.css`. That is all it does.

### 5.2 `src/app/routes.tsx`

A small, hand-written tab table:

| id | Label | Screen component |
|---|---|---|
| `map` | Map | `MapView` + HUD + dock (inline in `App.tsx`) |
| `plan` | Plan | `PlanScreen` |
| `library` | Library | `LibraryScreen` |
| `downloads` | Offline | `OfflineScreen` |

`resolveScreen(path)` maps a URL path to a tab, but nothing calls it. The app does not use URL routing; the screen is plain React state.

### 5.3 `src/app/App.tsx` — the shell

`App` is the only component that knows about every service. It owns cross-screen state and turns UI events into service calls.

#### React state it holds

| State | Source | Purpose |
|---|---|---|
| `screen` | local | Active tab |
| `fix`, `locationError` | `locationService` | Latest GPS fix, or the reason there is none |
| `compass` | `compassService` | Heading reading |
| `nav` | `navigationService` | Full `NavigationState` |
| `engine` | `offlineRoutingAdapter` | Routing engine status (kind, ready, message) |
| `itinerary` | `tripPlanner` | Destination, stops, and the map-pick request |
| `followGps` | local | Whether the camera follows the rider |
| `now` | 2 s interval | Re-renders so the "stale GPS" check stays current |
| `toast` | local | `{message, tone}`. Non-loading toasts disappear after 3.2 s. |
| `sheetMode`, `sheetBusy`, `sheetError` | local | Save/Share sheet |
| `planBusy` | local | A Plan-tab preview is running (waiting for GPS or routing) |
| `libraryTick` | local | Incremented after a save, so the Library reloads |

Refs: `previewToken` (cancels a stale preview), `planTripKey` (a JSON snapshot of destination, waypoints and profile at plan time), and `screenRef`.

#### Effects

1. **Mount:** subscribe to all services; start GPS (`locationService.startWatching`), the compass, and the routing engine (`navigationService.ensureEngine`). There is also a `mapService.subscribeStatus` listener. Whenever the map finishes loading (including after you come back to the Map tab), it redraws the destination marker, stop markers and the current route via `navigationService.redrawMap()`. **This is needed because `MapView` unmounts when you leave the Map tab, and that destroys the MapLibre instance.**
2. **On every fix:** `navigationService.updatePosition([lon, lat], accuracyMeters)` drives navigation.
3. **Ride mode:** asks for browser fullscreen while in ride mode on the Map tab.
4. **Trip-change guard:** while planning, if the itinerary or profile no longer matches `planTripKey`, the in-flight plan is cancelled. This stops a slow download from finishing for a trip the rider has already changed.
5. **Toast auto-dismiss.**

#### Event handlers

| Handler | Trigger | What it does |
|---|---|---|
| `handleMapClick` | Map tap | In ride mode, the tap only leaves ride mode. During navigation, it does nothing. In map-pick mode, it finishes the pick and returns to Plan. Otherwise it sets the tapped point as the destination on the map, in navigation, and in the trip planner. |
| `handlePlanRoute` | "Plan route" on the Map banner | Plans from `resolveStart()` (GPS, then last fix, then map centre) to the destination plus waypoints. |
| `handlePreviewFromPlan` | "Preview on map" on Plan | The full preview flow (§9.2): switches to the Map tab, waits up to 8 s for GPS, plans, and shows a toast. If it fails, it goes back to Plan. |
| `handleClearTrip` | "Clear trip" | Cancels any preview and clears both the trip planner and navigation. |
| `handleRequestMapPick` | "Pick on map" in a sheet | Starts map-pick mode, switches to the Map tab, and shows a loading toast. |
| `handleStartNavigation(i?)` | Start / Go | `navigationService.startNavigation(i)`, then the camera follows at zoom 16.5. |
| `handleRecenterNavigation`, `handleGoToMyLocation` | Map buttons | Turn camera-follow back on. |
| `handleProfileChange` | Route-type selector | Sets the profile. If a destination exists and the app is idle, choosing or in error, it plans again straight away. |
| `handleStop` | Stop | Leaves ride mode and fullscreen; `navigationService.stop()`. |
| `openSaveShareSheet`, `handleSheetConfirm` | Save / Share chips | Save: `navigationService.saveActiveRoute`, then go to Library. Share: `buildSavedSnapshot`, then `routeLibrary.exportAndShare`. |
| `handleOpenSavedRoute` | Library "Open" | Loads the route into the trip planner and navigation, then switches to the Map tab. |

#### Derived flags

- `navMode` = status is `navigating` or `rerouting`.
- `immersive` = `navMode || rideMode`. Hides the "locate me" button.
- `showRouteOptions` = a destination exists, status is idle, choosing, error or arrived, and the app is not navigating or picking on the map.
- `canSaveRoute` = there are alternatives or navigation is active, and status is choosing, navigating or rerouting.

#### Rendered layout

`<div class="tc-app">` has `data-screen`, `data-nav`, `data-ride` and `data-map-pick` attributes. The CSS uses these to hide and show UI (§14). It contains the active screen and the bottom tab bar. On the Map tab:

- `MapView` (full bleed)
- A map-pick banner with Cancel, when picking
- The **Recenter** button (navigating and not following) or the **Locate** button (not immersive)
- A HUD with the GPS chip (accuracy, stale flag, km/h) and the `CompassWidget`
- A dock with `RouteOptionsPanel` above `NavigationBanner`
- `SaveShareRouteSheet` and `StatusToast`

---

## 6. Screens and components

All components are presentational. They receive props, and where they need data they call services directly.

### 6.1 Map tab

#### `MapView.tsx`
- Creates the MapLibre map on mount (`mapService.initialize(container)`) and destroys it on unmount (`mapService.dispose()`).
- Keeps the latest callback props in refs, so the map subscriptions are set up only once.
- Forwards map events to props: click → `onMapClick`, tap on a route line → `onRoutePick(index)`, the user panning or zooming → `onFollowBreak`.
- On every `fix`, moves the position marker. The camera moves only if `followGps` is on. While navigating, zoom is fixed at `NAVIGATION_FOLLOW_ZOOM` (16.5).
- Switches the marker between **dot** (idle) and **arrow** (navigating, rotated to the GPS course).
- Shows a status badge while the online style is loading or has failed.

#### `CompassWidget.tsx`
A dial with N/E/S/W labels and a rotating needle, plus the heading in degrees and an accuracy label. It shows an **Enable** button when there is no reading yet or the error mentions permission (iOS-style `requestPermission`).

#### `NavigationBanner.tsx`
The main status and action strip at the bottom of the Map tab.
- **Text:** while planning or rerouting, the progress label. During navigation, the instruction formatted as `"350 m — Turn right"`. Otherwise, `state.message`.
- **Progress bar:** shown only when `percent` and `bytesTotal` are both known (a real byte count).
- **Remaining:** distance and ETA when choosing or navigating.
- **Off route** flag.
- **Save / Share** chips when `canSaveRoute` is true and ride mode is off.
- **Actions:** idle, error or arrived → **Plan route**. Choosing → **Start**. Navigating → **Stop**, plus **Exit** in ride mode.

#### `RouteOptionsPanel.tsx`
A collapsible bottom sheet with two sections:
- **Route type:** a radio group for Fastest, Shortest and Less traffic, each with an icon, hint and description.
- **Routes:** one card per alternative, with a colour swatch that matches the map line, distance and ETA, a "Best" badge on the first, and a **Go** button. A "Show all on map" toggle makes every alternative bold on the map.
- The panel opens by itself when a new set of alternatives arrives. It tracks `routesSeen` during render to do this, instead of using an effect.
- Swatch colours (`#5b8def`, `#9b7bff`, `#3dbea5`) must match `ALT_COLORS` in `map.service.ts`.

#### `SaveShareRouteSheet.tsx`
A modal sheet that asks for a route name. The default name comes from `suggestRouteName`, for example `Fastest · 42.3 km · 58 min · Oct 23, 14:05`. When the sheet opens for a new route, the name is reset by comparing an `openKey` during render. The sheet shows a route summary, error text and a busy spinner. Enter submits and Escape closes.

#### `StatusToast.tsx`
A small pill with a tone of `info`, `loading` (spinner), `success` (✓) or `error` (!).

### 6.2 Plan tab

#### `PlanScreen.tsx`
A list-first trip builder.
- **Itinerary card:** **A** = My location (live coordinates), then each stop row (fuel F, food E, custom +) with ↑, ↓ and ✕ controls, then **B** = Destination (tap to edit).
- **"Along the way"** buttons: **Fuel** and **Food** open `StopSuggestSheet`. **Custom** opens `StopPickerSheet` in manual mode.
- **Summary line:** planning status, or the route's distance, ETA and stop count, or a hint.
- **Actions:** **Preview on map** (needs a destination and a ready engine), **Start navigation** (needs a calculated route), **Clear trip**.
- Stops added from suggestion or POI sheets go through `tripPlanner.addStop(stop, activeRoute.coordinates)`. They are **inserted in order of position along the current route**, not just added to the end.

#### `StopPickerSheet.tsx`
A search sheet for the destination or a custom stop.
- Searches Nominatim only when the rider submits (Enter or the **Search** button; minimum 2 characters), biased towards the GPS position. Nominatim's usage policy forbids search-as-you-type, and `place-search.service.ts` also limits requests to one per second.
- **Use my location** and **Pick on map** shortcuts.
- Resets its fields when it opens, using a session-key comparison during render.

#### `StopSuggestSheet.tsx`
Automatic stop suggestions. A previewed route is required.
- **Fuel:** enter your tank range in km (40–1200). Stations are suggested every ≈ 70 % of the range.
- **Food:** enter a departure time and choose meals (Breakfast, Lunch, Dinner). Places are suggested where you are expected to be during each meal window.
- Settings are saved in `localStorage` (`tc.tankRangeKm`, `tc.departTime`, `tc.mealKinds`).
- Each suggestion shows its reason and its distance off the route. **Add** adds it as a trip stop with the reason as notes.
- **Browse list** switches to `PoiFinderSheet`.

#### `PoiFinderSheet.tsx`
A manual list of fuel or food places, with two scopes:
- **Along trip:** 8 sample points along the route, 2 km radius, sorted by distance from the route.
- **Near me:** 3.5 km around the GPS position, sorted by distance.

### 6.3 Library tab

#### `LibraryScreen.tsx`
A header plus `SavedRoutesPanel`.

#### `SavedRoutesPanel.tsx`
- Lists saved routes, newest `updatedAt` first, with distance, ETA and date.
- Each row has **Open**, **Share** and **Delete**. Share downloads a file on the web or opens the share sheet on Android.
- **Import file** accepts `.json`, `.geojson` and `.trailcompass.json` (§8.12).
- Reloads when `refreshKey` changes (App increments it after a save).

### 6.4 Offline tab

#### `OfflineScreen.tsx`
- Shows the routing engine's kind, message and attribution.
- Lists the **saved road packs** (label, size, date) with a total, plus **Delete** and **Delete all**.
- Shows engine cards: the in-memory network label, and whether Valhalla tiles are active.
- It does **not** download map regions. That flow is still a stub (§11).

### 6.5 Unused component

- `DownloadProgress.tsx`: a region-download progress bar. Nothing renders it yet.

---

## 7. Services

### 7.1 `location.service.ts` — GPS

- `startWatching()`: checks and requests location permission through Capacitor, then calls `Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20 s, maximumAge: 5 s })`. Each position becomes a `GpsFix`. If the Capacitor plugin throws **on the web**, it falls back to `navigator.geolocation.watchPosition`.
- `ensureFix(timeoutMs = 8 s)`: returns a fix that is fresh (≤ 15 s old) or recent (≤ 60 s old) straight away. Otherwise it waits for the next fix. It rejects early if permission is denied. Used by Plan → Preview.
- `subscribe(listener)`: sends the last fix right away if one exists.
- Helpers: `isFixStale` (older than 15 s), `formatAccuracy` (`±12 m`), and `formatGpsChipLabel`, which turns browser error strings into short chip labels (Permission denied, Unavailable, Timed out, Needs HTTPS, Acquiring…).

### 7.2 `compass.service.ts` — heading

- Listens to `deviceorientation`. On iOS it calls `DeviceOrientationEvent.requestPermission()` first.
- Heading source, in order: `webkitCompassHeading` (iOS), then `360 − alpha`.
- Smoothing: an exponential moving average (α = 0.2) that handles the 359° → 0° wrap correctly (`smoothAngle`).
- Accuracy is `medium` when `event.absolute` is true, otherwise `low` (and flagged as needing calibration).
- Limitation: Android Chrome and WebView usually report **relative** orientation on `deviceorientation`. True north needs `deviceorientationabsolute`, which this service does not listen to yet. See §19.

### 7.3 `map.service.ts` — MapLibre adapter (`MapLibreAdapter`)

Wraps every map operation so the UI never touches MapLibre directly.

- **Setup:** calls `setWorkerUrl` with the worker URL from Vite's `?url` import, so the bundled worker loads. Style: `https://tiles.openfreemap.org/styles/liberty`. Starts with a world view (zoom 1.5). The first GPS fix zooms to 15.
- **Status:** `subscribeStatus` reports `{ok, message}`. It is ok after `load`, and an error if the style fails before loading.
- **Clicks:** a tap is first checked against the route layers with `queryRenderedFeatures`. If it hits a route alternative, `routePick` listeners fire. Otherwise `click` listeners get the coordinate.
- **Camera follow:** user drag, zoom, rotate or pitch gestures (events with `originalEvent`) turn follow off and notify `cameraBreak` listeners.
- **Markers:** the position marker (dot, or arrow rotated to the heading), a destination pin (orange), and stop pins (fuel teal **F**, food coral **E**, custom violet **+**).
- **Route layers**, bottom to top:

  | Source / layer | Look | Purpose |
  |---|---|---|
  | `…route-ghost` | grey dashed | Previous route kept visible while rerouting |
  | `…recalc-link` | red dashed straight line | Rider → destination while a plan is in progress |
  | `…route-alts-hit` | 28 px, transparent | Large tap target for picking a route |
  | `…route-alts` | blue / violet / teal dashed | Alternative routes |
  | `…route` | orange `#F5A623`, 5 px | The selected route. While recalculating it becomes faded, dashed and dark amber. |

- Key methods: `drawRoute`, `drawAlternatives(routes, selected, showAll)`, `drawGhostRoute`, `drawRecalcLink`, `setRouteRecalculating`, `fitRoute`, `centerOn`, `resumeNavigationFollow`, `setDestination`, `setItineraryStops`, `clearRoute`, `clearItinerary`.
- Stubs: `switchToRegion` always returns "not implemented". `registerTileProtocol()` is called with no arguments, so it does nothing.

### 7.4 `navigation.service.ts` — the navigation orchestrator

This is the core of the app. It owns `NavigationState` (§12) and the active route and alternatives, and runs the state machine described in §9. The main public API:

| Method | Purpose |
|---|---|
| `ensureEngine()` | Starts the routing adapter once and updates the idle message |
| `setDestination`, `setWaypoints`, `setProfile` | Update the trip inputs |
| `planRoute(start, end, waypoints)` → `'ready' \| 'cancelled' \| 'error'` | Calculates alternatives and enters `choosing` |
| `cancelPlanning()` | Aborts a running plan and restores the previous route if there was one |
| `showPlanning(msg)` | Shows the planning state before routing starts (for example "Getting GPS…") |
| `selectAlternative(i)`, `setShowAllRoutes(b)` | Route selection while choosing |
| `startNavigation(i?)` | Enters `navigating` |
| `updatePosition(coord)` | Called on every GPS fix; runs the follow loop |
| `stop()`, `pause()`, `resume()` | Lifecycle controls (`pause` and `resume` have no UI yet) |
| `loadSavedRoute(saved)` | Puts a library route into `choosing` without calculating it again |
| `saveActiveRoute(name)`, `buildSavedSnapshot(name)` | Turn the active route into a `SavedRoute` |
| `redrawMap()` | Draws the current state again after the map is recreated |
| `clearItinerary()` | Full reset |

Constants: arrive threshold 25 m; reroute cooldown 8 s.

### 7.5 `trip-planner.service.ts` — itinerary

State: `{ destination: TripStop | null, stops: TripStop[], mapPick: MapPickRequest | null }`.

- `setDestination`, `setDestinationFromCoordinate`, `clearDestination`
- `addStop(stop, routeGuide?)`: if a route polyline is given, inserts the stop by its distance along that route (`insertByRouteProgress`). Otherwise adds it to the end.
- `updateStop`, `removeStop`, `moveStop(id, ±1)`, `clear`
- **Map-pick flow:** `beginMapPick({kind, mode, replaceStopId?})`, then the next map tap calls `completeMapPick(coord)`, which sets the destination, replaces a stop, or adds a stop. `cancelMapPick` cancels.
- `getWaypoints()` returns the stop coordinates in order; `getDestinationCoordinate()` returns the end.
- `loadFromSaved(end, waypoints)` rebuilds the trip from a saved route. Stops become "Stop 1", "Stop 2" and so on, of kind `manual`.

### 7.6 `route-library.service.ts` — saved routes

- `list`, `get`, `delete` are thin wrappers over `routeRepository`.
- `saveFromCalculated(route, name, extras)` → `SavedRoute` → repository.
- `saveImported(route)`: if the ID already exists, assigns a new UUID, so an import never overwrites a route.
- `exportAndShare(route, kind)`: serialises the route as a `.trailcompass.json` file (or GeoJSON). On the web, it downloads the file with a Blob link. On Android, it writes the file to `Directory.Cache/shared-routes/` and calls `Share.share({files: [uri]})`, falling back to `url` if that fails.
- `importFromText`, `importFromFile` use `parseRouteFile` (§8.12).

### 7.7 `road-pack.service.ts` — road-data cache

Saves OSM road extracts so later plans can skip Overpass.

- **Index:** Preferences key `road-pack-index` (array of IDs, newest first). **Metadata:** `road-pack-meta:<id>`. **Body:** `road-packs/<id>.json`, written through `storageManager`.
- `findCoveringPack(points)` returns the first pack whose bounding box contains every point (with about 0.002° of padding) **and** whose recorded `coverage` has roads there. A corridor pack only counts if every point is within 80 % of the corridor radius of one of its sample points (`routing/network-coverage.ts`). Packs saved before coverage was recorded are treated as full-bbox packs.
- `saveFromCollection` is called after every new Overpass download. It skips collections over about 7.2 M characters and keeps at most **40 packs** (the oldest are deleted).
- The label looks like `Roads · 48.86°, 2.30° · ~12 km · 834 ways`.

### 7.8 `place-search.service.ts` — Nominatim

`searchPlaces(query, near?, limit = 8)` calls `nominatim.openstreetmap.org/search` (jsonv2). If a `near` point is given, it adds a ±0.6° viewbox (biased, not bounded) and sorts the results by distance.

### 7.9 `poi-search.service.ts` — fuel and food POIs via Overpass

`findPois({kind, near?, route?, radiusMeters, limit})`
- `fuel` → `amenity=fuel`. `food` → `amenity ∈ {restaurant, cafe, fast_food, food_court}`.
- With a route: 8 evenly spaced sample points, with an `around:` query on nodes and ways at each. Otherwise a single `around:` query at `near`.
- Removes duplicates by coordinate, names each place from `name`, then `brand`, then `operator`, then a default, and sorts by distance (from the route or from you).
- Sends its query through the shared `fetchOverpass` client (§8.3), so it gets the same scheduler, mirror switching and backoff as road downloads.

### 7.10 `stop-suggest.service.ts` — smart stop suggestions

**Fuel (`suggestFuelStops`)**
1. Interval = `max(25 km, tankRange × 0.7)`.
2. Checkpoints are placed every interval along the route (`pointsAlongPolylineEveryMeters`).
3. At each checkpoint, find fuel within 5 km and choose the best with `pickBestAlongRoute`. The score is `distance off route + 0.15 × distance from checkpoint`. Stations already used or already in the trip are skipped.
4. The Overpass query for each checkpoint runs one after another.

**Food (`suggestFoodStops`)**
1. Meal windows: Breakfast 07:00–10:00 (target 08:30), Lunch 12:00–14:30 (13:00), Dinner 18:30–21:00 (19:30).
2. Arrival time = departure time + the route's estimated duration. For each chosen meal, `mealTargetDuringTrip` finds a target time inside both the window and the trip. It also checks the next day, for long rides.
3. The target time becomes a distance along the route, assuming **constant speed**: `elapsed / duration × length`, clamped to 5–95 % of the route.
4. Find food within 4 km of that point and pick the best.

---

## 8. Routing subsystem

This is the largest and most complex part of the code. The pieces:

```text
NavigationService.planRoute
   │
   ▼
OfflineRoutingAdapter.calculateRoutes      (offline-adapter.ts)
   ├─ Valhalla ready? ──▶ ValhallaOfflineAdapter.calculateRoute   (valhalla-adapter.ts)
   │
   ├─ needsRouteChunking? (any hop > 55 km OR any waypoint)
   │     └─▶ calculateChainedRoute
   │            expandRouteChain  (route-chunking.ts)
   │            per leg: loadOsmNetworkForRoute ─▶ OfflineGraphEngine.calculateRoute
   │            mergeRoutes
   │
   └─ single hop:
         ensureRoadGraph ─▶ loadOsmNetworkForRoute   (osm-network-loader.ts)
         snapRoutingEndpoints
         OfflineGraphEngine.calculateRoutes (≤ 3 alternatives)      (graph-engine.ts)

loadOsmNetworkForRoute:
   memory cache ─▶ road pack on disk ─▶ Overpass (via overpassScheduler) ─▶ save road pack
```

### 8.1 `routing-adapter.ts` — the contract

```ts
type Coordinate = [longitude, latitude];
interface TurnInstruction { text; distanceMeters; maneuver? }
interface CalculatedRoute {
  coordinates; distanceMeters; durationSeconds; instructions;
  id?; profile?; label?; meta?: { edgeCount? }
}
interface RouteRequestOptions { waypoints?; profile?; alternatives?; signal? }
interface RoutingAdapter {
  calculateRoute(start, end, waypointsOrOptions?): Promise<CalculatedRoute>;
  calculateRoutes?(start, end, options?): Promise<CalculatedRoute[]>;
}
```

It re-exports `offlineRoutingAdapter` as `defaultRoutingAdapter`. `NavigationService` takes an adapter in its constructor, so you can pass a different one in tests.

**What `TurnInstruction.distanceMeters` means:** the distance travelled *before* this maneuver, from the previous one. The running total of these distances is the maneuver's position along the route. `selectNextInstruction` depends on this.

### 8.2 `offline-adapter.ts` — `OfflineRoutingAdapter`

**Startup (`initialize`)**
1. Checks for `/assets/routing/valhalla-tiles.tar` with a 64-byte `Range` request. A response with `text/html` counts as missing, because the dev server's single-page fallback would otherwise look like a hit.
2. If the file exists and Valhalla starts, the engine kind is `valhalla`.
3. Otherwise, it loads the bundled **demo network** (Paris Trocadéro, 107 ways) into the graph engine. This is optional; failure is ignored. The kind is then `graph`, and the engine is ready.

**`calculateRoutes(start, end, {waypoints, profile, alternatives = 3, signal})`**
- **Valhalla path:** one route, labelled "Best match".
- **Chained path:** used when `needsRouteChunking` is true: any hop is longer than 55 km, **or there are any waypoints**. Returns one merged route.
- **Single-hop path:** `ensureRoadGraph` (download only if the current graph does not already cover both points within 350 m), then snap both ends to the nearest road (within 2.5 km), then the graph engine returns up to 3 alternatives.
- Progress events go to `subscribeProgress` listeners. 400 ms after a job finishes, it emits `idle`, but only if no newer job has started (`jobEpoch`).

**Chained routing (`calculateChainedRoute`)**
1. `expandRouteChain` builds `start → [synthetic vias] → waypoint → … → end`, with each hop ≤ 55 km. Synthetic vias are points on the great circle between two user points.
2. **Prefetching:** legs 1 and 2 start downloading at once. While leg *i* is being routed, leg *i + 1* is already downloading. This keeps the Overpass mirror busy during the A\* search.
3. For each leg:
   - `loadPrefetchedCorridor`: if the current graph already covers the leg, use it. Otherwise wait for the prefetched download. If the previous leg's snapped end (the cursor) is not where the prefetch started, and the prefetched corridor does not reach the cursor, download again from the cursor.
   - Snap both ends, allowing up to **12 km** for synthetic vias (so they can move onto a real road) and **2.5 km** for user points.
   - Run the graph engine for the best route only. The next leg starts at this leg's **snapped** end.
4. `mergeRoutes` joins the coordinates (dropping a duplicate joint point) and sums the instructions, distance and duration.

> Note: `offlineGraphEngine.loadFeatureCollection` **replaces** the graph each time. Only one leg's corridor is in memory at any moment.

### 8.3 `osm-network-loader.ts` — downloading road data

`loadOsmNetworkForRoute(start, end, waypoints, onProgress, signal)`

1. **Size limit:** throws if any two points are more than **80 km** apart. Chaining keeps legs at or below 55 km.
2. **Query shape:**
   - Span < 25 km: a **bounding-box** query (points' bbox + 0.025° padding).
   - Span ≥ 25 km: a **corridor** query, made of `around:4000` circles at sample points every 12 km along the great circle (at most 12 circles). This avoids downloading a huge diagonal box for a long thin leg.
   - Road classes: `motorway` to `service`, plus `*_link`, excluding `area=yes`.
3. **Cache layers:** an in-memory `Map` (24 entries; the key is the bbox or the corridor points), then `roadPackService.findCoveringPack` (disk), then Overpass.
4. **`fetchOverpass`** (in `overpass-client.ts`, shared with the POI search): up to 4 attempts, alternating between `overpass-api.de` and `overpass.kumi.systems`. Each attempt first gets a slot from `overpassScheduler`.
   - HTTP 429, 502, 503 or 504: marks the mirror as overloaded and waits for `Retry-After` (at most 30 s) or the backoff.
   - Other HTTP errors, bad JSON, or network errors: back off and switch mirror.
   - Backoff: 2 s, 4 s, 8 s (maximum 8 s). The wait can be aborted.
5. **Download progress:** if `Content-Length` is present, the body is read as a stream and real byte progress is reported. Otherwise the progress is indeterminate.
6. **Conversion (`overpassToNetwork`):** ways with geometry become GeoJSON `LineString` features with `highway`, `oneway`, `name` and `osm_id`. Ways tagged `access=no` or `private`, `motor_vehicle=no` or `motorcycle=no` are dropped. The collection's `region.coverage` records what was really downloaded: `{kind: 'bbox'}`, or `{kind: 'corridor', samples, radiusMeters}` for corridor queries.
7. The result is cached and saved as a road pack in the background.

### 8.4 `overpass-scheduler.ts` — limiting concurrent requests (uncommitted)

A small semaphore for Overpass requests:
- Starts with **1** request at a time.
- A successful response within 4 s raises the limit to **2** (the maximum).
- Any 429, 5xx or network failure drops it back to **1**.
- `acquire(signal)` waits in a FIFO queue, can be aborted, and returns a `release()` function that is safe to call more than once.

This lets the chained-leg prefetch run two requests at once when a mirror is healthy, without flooding public servers.

### 8.5 `abort.ts` — cancellation helpers (uncommitted)

- `abortError()` creates a `DOMException('Route planning cancelled', 'AbortError')`.
- `isAbortError(e)` checks for that error.
- `throwIfAborted(signal)`.

These are used throughout the loader, the adapter and the navigation service, so a cancelled plan stops quietly instead of showing an error.

### 8.6 `graph-engine.ts` — `OfflineGraphEngine` (A\*)

**Building the graph (`loadFeatureCollection`)**
- Each consecutive coordinate pair in a `LineString` becomes an edge. Nodes are keyed by the coordinate rounded to 6 decimal places (`keyForCoordinate`), so ways that share an OSM node connect automatically.
- One-way handling: `oneway=yes|true|1` creates only the forward edge. `oneway=-1` creates only the reverse edge. `motorway`, `motorway_link` and `trunk_link` are treated as one-way when they have no tag.
- Edge IDs are `${osm_id}:${segmentIndex}:fwd|rev`.

**Snapping:** nodes are also bucketed in a grid of 0.005° cells. `snapToNearestNode(point, maxMeters)` searches rings of cells outward from the point's cell and stops once no farther ring can hold a closer node, or the ring is beyond `maxMeters`. `coversPoints` requires both ends to be within 350 m of a road. `nearestRoadCoordinate(point, max)` is used for the wider 2.5 km and 12 km snaps.

**Search (`aStar`)**
- The heuristic is the straight-line distance to the goal multiplied by `minCostPerMeter(profile)`, the cheapest cost any edge can have per metre under that profile. This never overestimates, so the first route found is the cheapest. Without the scaling, "fastest" could settle on a slow street over a cheaper motorway.
- The open set is a binary min-heap (`min-heap.ts`). A node can be pushed again with a better score; outdated entries are skipped when popped, and settled nodes are kept in a closed set.
- The edge cost comes from `edgeCostMeters(meters, highway, profile)` multiplied by any penalty on that edge.

**Alternatives (`calculateRoutes`)**
1. Run A\*. Add the result if it does not overlap any accepted route by more than 72 % of its edges (measured against the smaller set), and is not more than 1.55× the best route's length.
2. Multiply the cost of every edge just used by 6, and search again.
3. Repeat up to `want × 3` times or until `want` routes (at most 3) are accepted.

**Building the result:** expands the path into coordinates, adds the original start and end points if they are more than 1 m from the snapped nodes, measures the length, estimates the duration (`estimateDurationSeconds`), and generates instructions (`buildManeuversFromPath`). Labels are "Best match", "Alternative 1", and so on.

### 8.7 `routing-profiles.ts` — route types and costs

| Profile | Edge cost |
|---|---|
| `shortest` | metres |
| `fastest` | `(metres / speed(highway)) × 10`, i.e. time scaled up |
| `less_traffic` | `metres × penalty(highway)`: motorway 4.5, trunk 3.2, primary 2.2, secondary 1.4, tertiary 1.05, residential, living street and unclassified 0.85, service 1.1 |

Assumed motorcycle speeds (m/s): motorway 28 (about 100 km/h), trunk 22, primary 16, secondary 13, tertiary 11, residential and unclassified 9, living street 6, service 5, anything else 10.

`estimateDurationSeconds` divides the length by the **average** assumed speed of the road classes used on the path (minimum 30 s).

"Less traffic" is a guess based on road class. It does **not** use live traffic data.

### 8.8 `maneuver-builder.ts` — instructions from geometry

Walks the route coordinates and measures the change in bearing at each point:
- A change of 35° or more is a turn: right or left, or "sharp" above 120°.
- Turns closer than 12 m to the previous one are merged.
- The first instruction is relabelled `depart` ("Head toward destination"). An `arrive` instruction is added at the end.
- Street names are **not** used, even though the OSM features include `name`.

### 8.9 `turn-instructions.ts` and `route-matcher.ts`

- `selectNextInstruction(instructions, alongMeters)` returns the first instruction whose running-total distance is greater than `alongMeters`.
- `formatInstructionBanner` produces `"1.2 km — Turn left"`.
- `selectNextInstructionIndex(instructions, alongMeters)` returns the instruction's index and where its maneuver sits along the route, so two identical instructions are never confused.
- `matchPositionToRoute(pos, route, {accuracyMeters})` finds the closest point on the route's **segments** (via `projectOntoPolyline`) and sets `offRoute` if the rider is farther than `max(50 m, 1.5 × GPS accuracy)`.
- Route-following helpers in the same file: `waypointPositionsAlong` (where each stop sits along the route, searched in visit order), `countPassedWaypoints`, and `remainingDurationSeconds` (planned duration scaled by the share of distance left).

### 8.10 `geo.ts` — geometry helpers

`haversineMeters`, `bearingDegrees`, `turnAngleDegrees` (−180 to 180), `polylineLengthMeters`, `distanceAlongPolylineMeters` (finds the nearest coordinate and returns the distance along the route up to it), `remainingPolylineMeters`, `pointAlongPolylineMeters` (interpolates a point at a given distance), `pointsAlongPolylineEveryMeters`, and `keyForCoordinate`.

### 8.11 `route-chunking.ts`

- `ROUTE_CHUNK_MAX_M = 55 000`.
- `expandRouteChain` adds synthetic vias between user points so no hop exceeds the maximum. User waypoints are always kept.
- `needsRouteChunking` returns true for any hop longer than the maximum, **or whenever there are waypoints**.
- `interpolateGeodesic(a, b, f)` returns the point at fraction `f` along the great circle from `a` to `b`.

### 8.12 `route-file.ts` — the share and import format

```jsonc
{
  "format": "trailcompass-route",
  "version": 1,
  "exportedAt": "2026-10-23T…Z",
  "app": "trailcompass",
  "route": { /* SavedRoute */ }
}
```

- The file extension is `.trailcompass.json`. File names are built from the route name (lower case, hyphens, at most 48 characters).
- `parseRouteFile` accepts three inputs: **(1)** the envelope above, **(2)** a bare `SavedRoute`, or **(3)** a GeoJSON `Feature` or `LineString`. A GeoJSON import has no instructions. `normalizeSavedRoute` checks there are at least 2 coordinates and fills in defaults.
- `toGeoJson` exports a GeoJSON `Feature`. No screen offers this option yet.

### 8.13 `route-naming.ts`

`suggestRouteName` builds names like `"Fastest · 42.3 km · 58 min · Oct 23, 14:05"`. It also provides the shared formatters `formatDistanceShort` and `formatEtaShort`.

### 8.14 `valhalla-adapter.ts` — optional Valhalla WASM

- Loads `@jansoft/mbujkanji-valhalla-wasm` with a dynamic import, then `createRouter()`, `init()`, and `loadTilesFromUrl()` (or fetches the file and calls `loadTiles()`).
- Requests use `costing: 'motorcycle'` and `directions_type: 'maneuvers'`. Valhalla returns one leg per hop between stops. Each leg's shape is decoded as a **polyline with 6-digit precision**, its distance and time come from the leg summary, and the legs are joined with `mergeRoutes` (`route-merge.ts`).
- Uses Valhalla's own maneuver text when present. Otherwise it generates instructions from the geometry.
- Type declarations are in `src/types/valhalla-wasm.d.ts`.

### 8.15 `routing-progress.ts`

`RoutingPhase` is one of `idle`, `checking-cache`, `downloading-roads`, `building-graph`, `calculating`, `done` or `error`. Progress has `{phase, label, percent | null, bytesReceived?, bytesTotal?}`.

### 8.16 `direct-route.ts` (unused)

`buildDirectRoute` creates a straight-line route split into about 250 m steps, with "Head NE toward destination". It is not imported anywhere today.

---

## 9. Navigation lifecycle end to end

### 9.1 State machine (`NavigationStatus`)

```text
                 setDestination
   ┌──────┐  ─────────────────▶  (still idle, destination set)
   │ idle │
   └──┬───┘
      │ planRoute()                    cancelPlanning() → idle, or choosing if a route existed
      ▼
 ┌──────────┐  error ─────────────▶ ┌───────┐
 │ planning │                       │ error │ ── planRoute() ──▶ planning
 └────┬─────┘                       └───────┘
      │ routes ready
      ▼
 ┌──────────┐  selectAlternative / setShowAllRoutes / profile change (re-plan)
 │ choosing │◀────────────────────────────────────────────┐
 └────┬─────┘                                              │
      │ startNavigation()                                  │
      ▼                                                    │
 ┌────────────┐ off route (> 50 m, 8 s cooldown) ┌───────────┐
 │ navigating │ ───────────────────────────────▶ │ rerouting │
 │            │ ◀─────────────── new route / failure (stays navigating, offRoute=true)
 └──┬───┬─────┘
    │   │ within 25 m and < 50 m remaining
    │   ▼
    │ ┌─────────┐
    │ │ arrived │
    │ └─────────┘
    │ stop() → idle (destination kept)
    ▼
  paused ⇄ navigating   (pause/resume; no UI yet)
```

### 9.2 Plan → Preview → Start (Plan tab)

1. The rider builds the trip in `PlanScreen`. `tripPlanner` state updates, and App draws markers through `syncItineraryMarkers`.
2. **Preview on map** calls `handlePreviewFromPlan`:
   - Increments `previewToken`, saves `planTripKey`, sets `planBusy`.
   - Passes the destination and waypoints to navigation and shows "Getting GPS…" (status `planning`).
   - Switches to the **Map** tab with follow on.
   - `resolveStartForPreview` → `locationService.ensureFix(8 s)`. If that fails, it uses the last fix or the map centre.
   - `navigationService.planRoute(start, end, waypoints)`.
3. `planRoute`:
   - `startRoutingJob()` cancels any earlier job and creates a new token and `AbortController`.
   - Draws the dashed red line from rider to destination and fades the old route.
   - Subscribes to adapter progress and copies each progress label into the banner.
   - Calls `adapter.calculateRoutes` with `alternatives = waypoints ? 1 : 3`.
   - If the token is out of date, returns `'cancelled'`. On success, draws the alternatives and the selected route, then enters `choosing` ("3 routes — pick one, then Start").
4. The rider picks a route (card or map tap) and taps **Start** or **Go**. `startNavigation` sets status `navigating`, switches to the arrow marker, follows at zoom 16.5, and enters ride mode once the bike is moving (§13).

### 9.3 The follow loop (`updatePosition` → `followRoute`)

On every GPS fix while navigating:
1. `matchPositionToRoute` projects the rider onto the closest route segment. This gives the distance from the road, the distance along the route, and the remaining distance (`remainingFromProjectionMeters`).
2. **Arrival:** within 25 m of the route **and** less than 50 m remaining → `arrived`, and the route is cleared.
3. **Off-route counter:** a fix beyond the threshold (§8.9) adds to a counter; a fix on the route resets it. Fixes with accuracy worse than 100 m change neither. Only **2 consecutive** off-route fixes count as off route.
4. **Visited stops:** while on the route, stops the rider is at least 30 m past are dropped from `waypoints`, so a later reroute does not send them back.
5. **Next instruction:** `selectNextInstructionIndex(instructions, along)`; the distance to the turn is that maneuver's position minus the rider's.
6. **Off route** (confirmed): the state is flagged and `tryReroute(position)` is called. While a reroute is running, the status stays `rerouting` so its progress stays visible.
7. Otherwise, the state is updated with the remaining distance and **ETA = planned duration × remaining ÷ route length**.

### 9.4 Rerouting and cancellation

`tryReroute`:
- Skipped if less than 8 s since the last attempt, or a reroute is already running.
- Keeps the old route as a ghost line and draws the line from rider to destination. Status becomes `rerouting`.
- Calculates from the **current position** to the destination with the trip's waypoints.
- Success: status becomes `navigating` with the new route. Failure: status stays `navigating`, `offRoute` stays true, and the message reads "Still off route — …". The ghost line stays visible.

How cancellation works:
- `planToken` is incremented by `invalidateRouting()` (called by each new plan or reroute, `cancelPlanning`, `stop` and `clearItinerary`). It also calls `planAbort.abort()`.
- The abort signal stops the Overpass `fetch`, the scheduler queue, the backoff wait, and the checks between legs.
- Every `await` in `planRoute` and `tryReroute` is followed by a token check, so an old job never writes state.
- In App, `previewToken` does the same for the GPS wait in the Plan preview, and the trip-change guard effect cancels plans for a trip the rider has since changed.

### 9.5 Saved routes

- **Save:** `saveActiveRoute(name)` → `routeLibrary.saveFromCalculated` → Preferences.
- **Open:** `handleOpenSavedRoute` → `tripPlanner.loadFromSaved` + `navigationService.loadSavedRoute`. Status becomes `choosing` with one alternative. Nothing is recalculated and no network is needed.
- **Share / import:** see §7.6 and §8.12.

---

## 10. Persistence

### 10.1 `database/database.ts` — `JsonDatabase`

A JSON key-value wrapper over **Capacitor Preferences** (SharedPreferences on Android, `localStorage` on the web). All keys are prefixed with `trailcompass:`. Methods: `getJson`, `setJson`, `remove`, `listKeys`. It returns `null` for missing or corrupt JSON. The code comment notes that SQLite can replace it later behind the same interface.

### 10.2 Repositories

| Repository | Keys | Used? |
|---|---|---|
| `RouteRepository` (`route-repository.ts`) | `route-index` (ID array), `route:<id>` | Yes, by the route library. `saveRoute` updates `updatedAt`. Lists newest first. |
| `TripRepository` (`trip-repository.ts`) | `trip-index`, `trip:<id>` | **No.** It is ready for recording trip history. |

### 10.3 Where everything is stored

| Data | Native (Android) | Web |
|---|---|---|
| Saved routes | Preferences `trailcompass:route:*` | localStorage (through Preferences) |
| Road pack metadata | Preferences `trailcompass:road-pack-*` | localStorage |
| Road pack bodies | `Directory.Data/map-packages/road-packs/<id>.json` | localStorage `trailcompass:file:road-packs/<id>.json` |
| Region catalogue (stub) | `Directory.Data/map-packages/regions.json` | localStorage `trailcompass:file:regions.json` |
| Shared route files (temporary) | `Directory.Cache/shared-routes/` | Downloaded through the browser |
| Stop-suggestion settings | localStorage `tc.tankRangeKm`, `tc.departTime`, `tc.mealKinds` | same |
| Itinerary and navigation state | **Memory only.** Lost when the app restarts. | same |

---

## 11. Offline map subsystem

These files define the interfaces for downloadable map regions. **None of it is connected to the UI yet.**

| File | What it does today |
|---|---|
| `tile-protocol.ts` | `registerTileProtocol(addProtocol?, handler?)` registers a `pmtiles://` protocol only when both arguments are given. `map.service` calls it with none, so it does nothing. `buildPmtilesStyleUrl` builds a `pmtiles://` URL. |
| `region-manager.ts` | A region catalogue (stored in `regions.json`) with `listRegions`, `upsertRegion` (checked first), `startDownload`, `pauseDownload`, `cancelDownload`, `deleteRegion`, and `onProgress`. `startDownload` **always** ends in an error: "Download not implemented — provide a lawful regional package source." |
| `package-validator.ts` | Checks region metadata: ID, name, a valid `[w, s, e, n]` bounding box, size, attribution, licence, schema version. The comment says checksum checks are not done yet. |
| `storage-manager.ts` | A Filesystem wrapper rooted at `map-packages/` (`Directory.Data`), with a `localStorage` fallback on the web. Reads and writes text files and deletes files. `getStorageInfo().freeBytes` is always `null`. |

The README's design notes still apply: a WebView cannot read local PMTiles on its own, and it needs a range-request bridge. PMTiles files contain map tiles, not routing data.

---

## 12. Types

| File | Contents |
|---|---|
| `types/navigation.ts` | `NavigationStatus`; `GpsFix` (lat, lon, accuracy, altitude, speed in m/s, course, timestamp); `CompassReading` (heading, accuracy level, `needsCalibration`, message); `NavigationState` (status, destination, waypoints, current instruction, distance to next maneuver, remaining distance and time, `offRoute`, message, progress, profile, alternatives, selected index, `showAllRoutes`). |
| `types/route.ts` | `SavedRoute`, `TrailCompassRouteFile`, `Destination`, plus the converters `calculatedToSavedRoute` and `savedToCalculatedRoute`. |
| `types/trip-stop.ts` | `StopKind` (destination, fuel, food, manual), `TripStop`, `PoiKind`, `PlaceHit`, `createTripStop`, label helpers, `formatCoordShort` (`"lat, lon"` to 4 decimal places), `itineraryWaypoints`, `itineraryEnd`. |
| `types/region.ts` | `BoundingBox`, `RegionDownloadState`, `RegionPackage`. Used only by the offline stubs. |
| `types/valhalla-wasm.d.ts` | Type declarations for the Valhalla WASM module. |

---

## 13. Hooks

### `hooks/useRideFullscreen.ts`

Turns on an immersive map view automatically once the bike is clearly moving during navigation.

| Rule | Value |
|---|---|
| Enter | speed ≥ 3.5 m/s (about 12.6 km/h) for at least 2.2 s |
| Exit | speed ≤ 1.2 m/s (about 4.3 km/h) for at least 4.5 s, or navigation ends |
| Manual exit | `dismissRideMode()` (Exit button or any map tap). Stays off until the next sustained movement. |
| Check rate | Every 400 ms. Speed is read from a ref, so GPS updates do not restart the timer. |

`setBrowserFullscreen(active)` calls the Fullscreen API on a best-effort basis. Without a user gesture it fails without an error, and the CSS immersive styles still apply.

---

## 14. Styling

- One stylesheet: `src/index.css` (about 2,400 lines). Class names use a `tc-` prefix.
- **Design tokens** in `:root`: a dark green-black background (`#06100c`), amber accent (`#f0a020`), danger (`#ff6b4a`), ok (`#4fcf84`), 48 px touch targets, 16 px radius, and safe-area insets. The app is **dark only** (`color-scheme: dark`).
- **Fonts** (Google Fonts, loaded in `index.html`): *Chakra Petch* for display text, *DM Sans* for body text, *IBM Plex Mono* for numbers. They fall back to system fonts when offline.
- **Modes through data attributes** on `.tc-app`. `[data-nav='true']` and `[data-ride='true']` hide the bottom tab bar, shrink the HUD and dock, and show the Recenter button.
- **Sections** (marked by comment banners): Map screen, Ride HUD, Compass, Map dock, Navigation banner, Buttons, Bottom nav, Plan screen, Downloads/Offline screen, MapLibre controls, and responsive rules.
- **Responsive rules:** `max-width: 420px` (narrow phones), `orientation: landscape and max-height: 520px` (a phone in a handlebar mount), and `min-width: 800px` (tablet or desktop).

---

## 15. Public assets

| Path | Purpose |
|---|---|
| `public/assets/map-styles/online-style.json` | A descriptor for the OpenFreeMap Liberty style: URL, `requiresNetwork: true`, attribution. The code uses the URL constant directly. |
| `public/assets/map-styles/README.md` | Notes on the online style and its licence. |
| `public/assets/routing/demo-network.geojson` | 107 OSM ways around Paris Trocadéro (bbox 2.294–2.305 E, 48.856–48.8625 N), loaded when the engine starts. |
| `public/assets/routing/README.md` | Explains the demo network and how to build `valhalla-tiles.tar` with Docker. |
| `public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png` | Web icons, generated by `scripts/generate-icons.mjs`. |

---

## 16. Android project and build scripts

### 16.1 Android project (`android/`)

- Generated by Capacitor. `MainActivity` extends `BridgeActivity` and adds nothing.
- `applicationId` / `namespace`: `com.example.trailcompass`. **This is a placeholder and must change before publishing.**
- `minSdk 23`, `compileSdk` and `targetSdk 35`. `versionCode 6`, `versionName "1.1.0"`.
- Permissions: `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`. There is **no** background-location permission and no foreground service, so GPS updates can stop when the screen turns off or the app goes to the background.
- A `FileProvider` (`${applicationId}.fileprovider`, `res/xml/file_paths.xml`) lets the Share plugin send exported route files.
- `capacitor.config.ts`: `webDir: 'dist'`, `androidScheme: 'https'` (needed for geolocation, which requires a secure context), `allowMixedContent: false`.

### 16.2 `package.json` scripts

| Script | What it does |
|---|---|
| `dev` | Vite dev server (`host: true`, so phones on your LAN can reach it) |
| `build` | `tsc -b && vite build` → `dist/` |
| `lint` | oxlint |
| `test` | `vitest run` (unit tests) |
| `preview` | Serves the built `dist/` |
| `cap:sync` | build + `npx cap sync android` |
| `cap:build` | sync + Gradle `assembleDebug` (through `android-build.mjs`) |
| `cap:emulator` | Starts the default emulator and waits for it to boot |
| `cap:install` | Finds or boots a device and installs the debug APK |
| `cap:run` | build, then install and launch |
| `release:minor` / `release:major` | Full release (below) |
| `icons:generate` | Builds all icons and splash screens from code |

### 16.3 `scripts/`

- **`android-env.mjs`:** shared helpers that work on Windows, macOS and Linux. `androidSdk()` reads `ANDROID_HOME` or `ANDROID_SDK_ROOT`, or checks the usual install folders. `resolveJdk21()` looks for a **JDK 21** (`TRAILCOMPASS_JAVA_HOME` or `CAPACITOR_JAVA_HOME` override, then `JAVA_HOME`, then common install paths) and checks that `javac` exists. `runGradle(args)` runs `gradlew` with that JDK forced through `-Dorg.gradle.java.home`, so a different `java.home` in `~/.gradle` cannot override it.
- **`android-build.mjs`:** `runGradle([task || 'assembleDebug'])`.
- **`android-run.mjs`:** modes `start`, `wait`, `install` and `run`. Uses the first connected device, or boots an emulator (`ANDROID_AVD`, default `Pixel_3a_API_34_extension_level_7_x86_64`, otherwise the first AVD) and waits up to 180 s for `sys.boot_completed`. Then runs `adb install -r` and `am start` (with `monkey` as a fallback).
- **`release.mjs`:**
  1. Requires a clean working tree, an `origin` remote, and a working `gh` CLI. It takes a GitHub token from `GH_TOKEN` or `GITHUB_TOKEN`, or from credentials embedded in the `origin` URL.
  2. Runs `npm version <minor|major>`, increments `versionCode` and sets `versionName` in `build.gradle`, and updates `<widget version>` in `res/xml/config.xml`.
  3. Builds, syncs and runs `assembleDebug`, then copies the APK to `trailcompass.<major>.<minor>.0.apk`.
  4. Commits, tags `v<version>`, pushes, and runs `gh release create` with the APK attached. `--notes "…"` and `--draft` are supported.
- **`generate-icons.mjs`:** draws the compass logo as SVG and uses `sharp` to produce web icons, `resources/icon.*`, Android adaptive foreground icons, legacy and round launcher icons, and splash screens for each orientation and density.

---

## 17. What needs a network connection

| Feature | Network needed? | Service |
|---|---|---|
| Basemap tiles | **Always** | OpenFreeMap |
| UI fonts | First load (falls back to system fonts) | Google Fonts |
| Road data for routing | **Yes, unless** the area is in the memory cache or a road pack, or Valhalla tiles are bundled | Overpass (2 mirrors) |
| Place search | Yes | Nominatim |
| Fuel and food POIs, stop suggestions | Yes | Overpass |
| GPS position and compass | No | Device |
| A\* routing on cached roads, follow loop, arrival | No | On the phone |
| Rerouting | Only if the new corridor is not cached | Overpass |
| Saved routes: open, save, share | No (sharing uses the system share sheet) | On the phone |

So today the app runs routing on the phone, but it is **not** a fully offline app. The project's acceptance test (airplane mode) will not pass until the PMTiles bridge and pre-downloaded road data are in place.

---

## 18. Unused and stub code

| Item | Location | Status |
|---|---|---|
| `buildDirectRoute`, `routeLengthOk` | `routing/direct-route.ts` | Not imported anywhere |
| `TripRepository` | `database/trip-repository.ts` | Not used |
| `RegionManager`, `validateRegionPackage`, `DownloadProgress` | `offline/`, `components/` | Not connected to the UI. Download always errors. |
| `registerTileProtocol` | `offline/tile-protocol.ts` | Called with no arguments, so it does nothing |
| `navigationService.pause()` / `resume()` | `navigation.service.ts` | No UI calls them |
| `resolveScreen` | `app/routes.tsx` | Not called |
| GeoJSON export (`kind: 'geojson'`) | `route-library.service.ts` | No UI offers it |
| `MapLibreAdapter.switchToRegion`, `fitBounds`, `alternativeColor` | `map.service.ts` | Stub or not called |
| `pmtiles` dependency | `package.json` | Not imported |

---

## 19. Known issues and gaps

These came up while reading the code for this guide. Each one points to the relevant code. Nothing here has been confirmed on a device.

### Fixed on 2026-10-23

Each fix below is covered by tests in `src/routing/*.test.ts` (`npm test`).

- **Off-route detection** now measures against route segments, not just their points, and allows for GPS accuracy. It needs two consecutive off-route fixes before rerouting (`geo.ts` `projectOntoPolyline`, `route-matcher.ts`).
- **Rerouting no longer sends you back to stops you have passed.** Visited stops are dropped during navigation (`navigation.service.ts` `dropPassedWaypoints`).
- **The navigation ETA** now scales the route's planned duration instead of using a fixed 11 m/s.
- **The next instruction is tracked by index**, so identical instructions are no longer confused (`selectNextInstructionIndex`).
- **Valhalla routes with stops keep every leg** (`valhalla-adapter.ts`, `route-merge.ts`).
- **The A\* heuristic is scaled** so it never overestimates, and the search uses a binary heap and grid-indexed snapping (`graph-engine.ts`, `min-heap.ts`).
- **Corridor road packs record their real coverage**, so they are no longer reused for points far from the corridor (`network-coverage.ts`).
- **POI requests use the shared Overpass client**, with its scheduler and backoff (`overpass-client.ts`).
- **Place search runs on submit only**, at no more than one request per second.

### Still open

1. **Valhalla ignores the route type** and always returns a single route, using `motorcycle` costing.
2. **On Android the compass likely shows relative, not magnetic, heading.** The service listens only to `deviceorientation`. Chrome and WebView provide true-north readings on `deviceorientationabsolute` ([compass.service.ts:76](../src/services/compass.service.ts#L76)).
3. **There is no background location.** Without a foreground service or background permission, the WebView may stop receiving GPS updates when the screen locks.
4. **Trip and navigation state is lost on restart.** Only saved routes and road packs survive.
5. **`sharp` is not a declared dependency.** `generate-icons.mjs` needs it, but today it is installed only indirectly (through `@jansoft/mbujkanji-valhalla-wasm` → `next`). Add it to `devDependencies`.
6. **`release.mjs` needs `android/app/src/main/res/xml/config.xml`, which is gitignored.** It exists only after a `cap sync`, so a fresh clone fails at the version-bump step. The script also supports a token embedded in the `origin` URL, which means storing a credential in `.git/config`.
7. **Placeholder app ID** `com.example.trailcompass` (see §16.1), and releases ship a debug APK.
8. **README is out of date** (milestones, repository layout, "no routing yet").

---

## 20. Developer workflow cheat sheet

```bash
# Install
npm install

# Web dev (UI work; GPS needs https or localhost)
npm run dev

# Type-check + build, lint, unit tests (Vitest)
npm run build
npm run lint
npm test

# Android: build, sync, assemble, install, launch (JDK 21 + Android SDK required)
npm run cap:run
# …or step by step
npm run cap:sync
npm run cap:build
npm run cap:install
npx cap open android   # open in Android Studio

# Release a new GitHub version with the APK attached (clean tree, gh auth)
npm run release:minor -- --notes "What changed"

# Regenerate icons and splash screens
npm run icons:generate
```

**Where to start for common changes:**

| I want to… | Start here |
|---|---|
| Change how routes are calculated or weighted | `routing/routing-profiles.ts`, `routing/graph-engine.ts` |
| Change what road data is downloaded | `routing/osm-network-loader.ts` |
| Change turn instructions | `routing/maneuver-builder.ts` |
| Change off-route, arrival or reroute behaviour | `services/navigation.service.ts` (`followRoute`, `tryReroute`) |
| Change how routes are drawn on the map | `services/map.service.ts` (`ensureRouteLayer`, `drawAlternatives`) |
| Add a stop type or change the Plan tab | `types/trip-stop.ts`, `services/trip-planner.service.ts`, `components/PlanScreen.tsx` |
| Change fuel or food suggestion rules | `services/stop-suggest.service.ts` |
| Change the saved-route file format | `routing/route-file.ts` (increment `ROUTE_FILE_VERSION`) |
| Add offline map tiles | `offline/tile-protocol.ts`, `offline/region-manager.ts`, `services/map.service.ts` |
| Add a new tab | `app/routes.tsx`, `App.tsx` (screen switch and `NavIcon`) |
