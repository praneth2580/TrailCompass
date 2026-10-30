# TrailCompass — Project Guide

This guide explains how TrailCompass works, one part at a time. It covers what each folder and file does, how data moves between them, and the main design decisions. It also lists known gaps. Read it before changing the routing, navigation or map code.

It describes the working tree as of **2026-10-23** (app version `1.1.0`, Android `versionCode 6`), including the uncommitted `src/routing/abort.ts` and `src/routing/overpass-scheduler.ts`.

> `README.md` introduces the app to riders, and `DEVELOPMENT.md` is the quick start for developers: setup, scripts, releases and the website. This guide is the in-depth reference. Where they disagree, this guide follows the code.

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
11. [Offline maps (`src/offline`)](#11-offline-maps)
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
| Map display | Works. OpenFreeMap tiles, from a saved offline map when it has them. Fuel and food places shown on the map. |
| Offline map tiles (PMTiles) | Works for saved trips and for areas (a city, district or state). Tiles are stored once in a shared store and travel in shared files (§11). |
| GPS and compass | Work. |
| Route calculation | Works. Runs on the phone (A\*), but downloads road data from Overpass unless it is already cached. |
| Valhalla WASM routing | Optional. Turns on only if a tile archive is bundled. None is shipped. |
| Turn-by-turn and rerouting | Works, with known accuracy limits (see §19). |
| Area map downloads | Works: **Save an area** in the Offline tab (§11). The older region stubs (`region-manager.ts`) are not used. |
| Ride log | Works. Rides record from the map or while navigating, also with the screen off or the app closed (Android), and are kept with their track and stats (§7.1). Repeated rides are sorted into routes and places, with usual times and traffic (§7.1b). |
| GPS modes | Works. Satellites only, satellites + mobile data & Wi-Fi, or battery saver (§7.1). |

---

## 2. Tech stack

| Layer | Technology | Notes |
|---|---|---|
| UI | React 19, TypeScript 6 | Function components and hooks. No state library: services hold state and components subscribe to them. |
| Build | Vite 8 | `base: './'` so asset paths resolve inside the Android WebView. Source maps are on. |
| Lint | oxlint | `.oxlintrc.json`: react, typescript and oxc plugins; rules-of-hooks is an error. |
| Tests | Vitest 4 | Unit tests for the routing code, next to it as `src/routing/*.test.ts`. Node environment. |
| Native shell | Capacitor 7 | Plugins: Geolocation (permission), Filesystem, Preferences, Share, App (back button), Keep Awake, Text-to-Speech, and the app's own (§16). |
| Map | MapLibre GL JS 6 | Vector style from OpenFreeMap. The worker URL is set explicitly for Vite. |
| Offline tiles | `pmtiles` 4 | Reads the offline maps; `offline/pmtiles-writer.ts` writes them. |
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
│   ├── offline/                Offline maps: tile store, PMTiles, tile planning, tcmap://
│   ├── hooks/                  useRideFullscreen, useKeepAwake, useBackHandler
│   └── types/                  Shared domain types
│
├── public/
│   ├── assets/map-styles/      Online style descriptor + README
│   ├── assets/routing/         demo-network.geojson (Paris Trocadéro) + README
│   ├── assets/poi/             Bundled Overture fuel + food tiles for India + README
│   └── favicon / icons
│
├── resources/                  Master icon (png/svg) for tooling
├── site/                       Landing page for GitHub Pages (see scripts/build-site.mjs)
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
| `handlePlanRoute` | "Plan route" on the Map tab's trip card | Plans from `resolveStart()` (GPS, then last fix, then map centre) to the destination plus waypoints. |
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

`<div class="tc-app">` has `data-screen`, `data-nav`, `data-ride`, `data-map-pick` and `data-zen` attributes. The CSS uses these to hide and show UI (§14). It contains the active screen and the bottom tab bar. On the Map tab:

- `MapView` (full bleed)
- A map-pick banner with Cancel, when picking
- The **Recenter** button (navigating and not following)
- A control column under the zoom buttons: `NorthButton` and **Locate** (not immersive), then map overlays and record
- A HUD with the GPS chip (accuracy, stale flag, km/h) and the `CompassWidget`; tapping the compass opens zen mode
- In zen mode, only the map and the zen layer: an Exit button and a large `CompassWidget`. `data-zen` steps through `entering`, `on` and `leaving`, timed to the fades in `index.css`
- A dock with `MapTripCard`, or `NavigationBanner` while navigating, paused or in ride view
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
An SVG dial (scaled by the CSS variable `--tc-dial`) with a needle that points along the heading, plus the heading in degrees and an accuracy label. The `zen` variant adds 5° ticks, numerals, a north marker, a heading beam and the 8-point direction. The needle angle is unwrapped, so crossing north turns the short way. With `onOpen`, the compass is a button (the HUD opens zen mode with it). It shows an **Enable** button when there is no reading yet or the error mentions permission (iOS-style `requestPermission`).

#### `MapTripCard.tsx`
The Map tab's one card, in the dock, until the ride starts. It keeps the map free: the route on offer is framed in what the card leaves.
- **No destination:** a **Where to?** bar opening `StopPickerSheet`, the same search as the Plan tab. Tapping the map drops a pin instead.
- **Destination:** its name and straight-line distance, **Plan route**, a **+** to the Plan tab for stops, and `RouteOptionsPanel`. An error shows here, with **Try again**. Clearing with the ✕ is only offered with no stops on the trip, so one tap can't lose them.
- **Planning:** the progress label, the bar when bytes are known, **Run in background** on Android, and **Stop**.
- **Choosing:** time, distance and arrival, one button per route when there are several, **Start**, and icons for stops, save and share. Tapping the map doesn't change the trip while a route is on offer or stops are planned (`handleMapClick` says why in a toast).
- **Arrived:** **Done** clears the trip.
- Route button swatches (`#5b8def`, `#9b7bff`, `#3dbea5`) must match `ALT_COLORS` in `map.service.ts`.

#### `NavigationBanner.tsx`
The status and action strip while navigating, paused or in ride view. `RouteProgress` and its icons are shared with `MapTripCard`.
- **Text:** while rerouting, the progress label. During navigation, a turn arrow, the distance to it and the instruction.
- **Progress bar:** shown only when `percent` and `bytesTotal` are both known (a real byte count).
- **Remaining:** distance, ETA and arrival time.
- **Off route** flag, and a GPS warning when the signal is weak or lost.
- **Save / Share** chips when `canSaveRoute` is true and ride mode is off.
- **Actions:** **Stop**, plus **Exit** in ride mode.

#### `RouteOptionsPanel.tsx`
How to route, folded to one line in `MapTripCard`. Unfolded: a radio group for Fastest, Shortest and Less traffic, and switches for expressways and voice prompts.

#### `NorthButton.tsx`
In the map's control column, only while the map is turned and not navigating. The needle shows where north is; tapping puts it back up and flat.

#### `SaveShareRouteSheet.tsx`
A modal sheet that asks for a route name. The default name comes from `suggestRouteName`, for example `Fastest · 42.3 km · 58 min · Oct 23, 14:05`. When the sheet opens for a new route, the name is reset by comparing an `openKey` during render. The sheet shows a route summary, error text and a busy spinner. Enter submits and Escape closes.

#### `StatusToast.tsx`
A small pill with a tone of `info`, `loading` (spinner), `success` (✓) or `error` (!).

### 6.2 Plan tab

#### `PlanScreen.tsx`
A list-first trip builder. A `TripState` (`empty`, `unplanned`, `planning`, `ready`, `riding`, `outdated`, `error`) decides the summary and the buttons.
- **Trip timeline:** My location, each stop, then the destination, joined by a dashed line, with an icon per kind (fuel, food, place, flag). Stops show their full name and note (the suggestion's reason, or the place's address). Tapping a stop shows **Earlier**, **Later** and **Remove**; tapping the destination opens `StopPickerSheet`. With no destination it is a prominent **Where to?**, followed by three short steps on how planning works.
- **Add a stop** (once there is a destination): **Fuel** and **Food** open `StopSuggestSheet`; **Place** opens `StopPickerSheet` in manual mode.
- **Trip summary:** distance, riding time, stops and arrival time once planned (remaining distance and time while riding); planning progress with **Run in background**; or a note when the trip changed or planning failed.
- **Actions** follow the state: **Preview on map**, then **Start navigation** and **Show on map** (`onShowMap`, no re-planning), **Update route** after edits, **Try again** after an error, **Back to the ride** while navigating. **Clear trip** asks first.
- Stops added from any sheet go through `tripPlanner.addStop(stop, activeRoute.coordinates)`. With a route they are **inserted in order of position along it**, not just added to the end.

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
A header and **Trips** / **Rides** tabs: `SavedRoutesPanel` or `RideLogPanel`. `onPlanTrip` takes the rider to the Plan tab from an empty library; `onShowRide` opens the map with a ride drawn on it.

#### `RideLogPanel.tsx`
- Lists recorded rides, newest first, with a thumbnail of the track (`TrackThumbnail.tsx`, shared with trips), distance, moving time, average and top speed, climb, when, and the GPS mode used.
- Tapping a ride shows it on the map. **Export GPX**, **Save as trip** (its path becomes a trip without turn instructions) and **Delete** (with **Undo**) are icon buttons.

#### `RideSheet.tsx`
- Opened from the map's record button or REC chip while a ride records: distance, time recording and average speed, with Pause/Resume, Finish ride, and Discard (asks first).

#### `SavedRoutesPanel.tsx`
- Lists saved trips, newest `updatedAt` first. Each card shows a thumbnail of the route's shape (start, stops and end), distance, time, stops, route type and when it was saved (`formatSavedAt` in `route-naming.ts`).
- Tapping a card opens the trip on the map. **Share** (downloads a file on the web, opens the share sheet on Android) and **Delete** are icon buttons. Delete offers **Undo**, which puts the trip back with its original dates (`RouteRepository.restoreRoute`).
- A search box filters by name once there are six or more trips. Wide screens show two columns.
- **Import** accepts `.json`, `.geojson` and `.trailcompass.json` (§8.12).
- An empty library explains how trips get saved, with **Plan a trip** and **Import a file**.
- Reloads when `refreshKey` changes (App increments it after a save).

### 6.4 Offline tab

#### `OfflineScreen.tsx`
Top to bottom:
- **On this phone:** the road data saved, as a total and a bar split by kind (major roads, route corridors, local streets), and the fuel and food places built in.
- **Downloads:** the Wi-Fi only setting (`download-policy.service.ts`), with the network the phone is on.
- **Updates:** a row each for the app and the fuel and food data, with status, progress and a Check button.
- **Offline maps** (`OfflineMapsList.tsx`): areas and trips with their detail, size, download time and status; **Update** (or **Resume**, **Retry**, **Stop**), share and delete on each; **Save an area** (`SaveAreaSheet.tsx`) and **Import** above the list. The heading shows what all maps take up, shared tiles counted once.
- **Map:** the fuel and restaurant overlay switches.
- **Location:** the GPS mode (with satellites in use, and a "Turn it on" link when the phone's location is off) and **Record rides while navigating**.
- **Saved road data** (`RoadDataList.tsx`): packs grouped by kind (`ROAD_PACK_KINDS` in `road-pack.service.ts`), titled by their main road names (stored on new packs as `roads`) or else their middle point. Each has a delete button; **Delete all** asks first.
- **How routing works:** folded away; the engine, its status and Valhalla. Then the data credits.

### 6.5 Unused component

- `DownloadProgress.tsx`: a region-download progress bar. Nothing renders it yet.

---

## 7. Services

### 7.1 `location.service.ts` — GPS

- `startWatching()` (one start however many callers): checks and requests location permission through `@capacitor/geolocation`. On Android it then watches `RideLocationPlugin` in the chosen GPS mode; in a browser it calls `Geolocation.watchPosition({ enableHighAccuracy, timeout: 20 s, maximumAge: 5 s })`, falling back to `navigator.geolocation.watchPosition` if the plugin throws. Each position becomes a `GpsFix` (with `satellites` on Android).
- **GPS mode** (`getSource`, `setSource`, `subscribeSource`; localStorage `tc.locationSource`; `LOCATION_SOURCES` for the settings): `gps` uses Android's GPS provider only (no data, no Google services, a slower first fix), `assisted` (the default) the GPS and network providers with the GPS preferred while it has a fix in the last 10 s, `saver` the network provider every 5 s. In a browser only `saver` changes anything (`enableHighAccuracy: false`). `status()` says whether the phone's GPS and network location are on and how many satellites the last fix used; `openLocationSettings()` opens Android's location settings. Native side: `LocationHub.java`, `RideLocationPlugin.java`.
- `ensureFix(timeoutMs = 8 s)`: returns a fix that is fresh (≤ 15 s old) or recent (≤ 60 s old) straight away. Otherwise it waits for the next fix. It rejects early if permission is denied. Used by Plan → Preview.
- `subscribe(listener)`: sends the last fix right away if one exists.
- Helpers: `isFixStale` (older than 15 s), `formatAccuracy` (`±12 m`), and `formatGpsChipLabel`, which turns browser error strings into short chip labels (Permission denied, Unavailable, Timed out, Needs HTTPS, Acquiring…).

### 7.1a `ride-log.service.ts` — the ride log

- `start()`, `pause()`, `resume()`, `finish()` (resolves with the kept ride, or null under 50 m), `discard()`. `getLive()` and `activeSeconds()` for the REC chip and the ride sheet; `subscribeSaved` for the "Saved …" toast.
- **Recorders.** Android: `RideRecorderService.java`, a `location` foreground service (`stopWithTask="false"`, so it carries on when the app is swiped away; `START_STICKY`) writes `map-packages/rides/<id>.csv` (`time,lat,lon,accuracy,altitude,speed,bearing,satellites`, and `#pause`, `#resume`, `#end` lines), keeps its state in SharedPreferences `trailcompass-ride` and shows distance and a running clock in a notification with Pause/Resume and Finish. `init()` picks up a ride under way, or keeps one finished from the notification while the app was closed. Browser: the page records its own fixes, saved every 15 s (localStorage `tc.webRide`, `rides/<id>.csv`).
- **Auto record** (localStorage `tc.autoRecordRides`, default on): navigation starting records a ride named after the trip's destination; arriving or stopping finishes it. Rides started by hand aren't finished by navigation.
- **Track maths** (`ride-track.ts`, tests in `ride-track.test.ts`): `DistanceCounter` (the native notification uses the same rule), `summarizeTrack`, Douglas–Peucker `simplify` (3 m, and 25 m in timing, so stops on straight roads survive; rides kept before this have coarser timing on straights), `encodeTrack`/`decodeTrack` (polyline-style numbers for positions, seconds and heights), `toGpx`, `rideName` ("Morning ride"…).
- **Storage** (`database/ride-repository.ts`): summaries in Preferences `ride-index`, `ride:<id>`; tracks in `map-packages/rides/<id>.json`.
- **Map:** the ride being recorded draws as a red line, a past ride from Library as a purple one (`mapService.setRideLine`), with a chip to hide it.

### 7.1b `ride-insights.service.ts` — routes and places of the ride log

- **Trips** (`ride-groups.ts`, `rideTrip`): a ride with waiting at either end cut off and breaks cut out (within 50 m for 5 minutes or more), its path resampled every 50 m or so (at most 400 points). Worked out once per ride and kept in `rides/trips.json`; bump `TRIP_FILE_VERSION` when that changes, and they're worked out again.
- **Routes** (`groupRoutes`, `sameRoute`): rides are the same route when at least 80% of each lies along the other, they're within 1.4× of each other's length, and they go the same way. A ride is compared with each route's first ride, so routes can't creep into each other. The way back is its own route, since its traffic differs.
- **Places** (`clusterPlaces`): starts and ends within 400 m gather into a place. Places the rider named stay where they are, under `ride-places`.
- **Names:** the rider's, else the trip navigation went to, else a saved trip ending there, else Nominatim (`nominatimReverse`, one request a second, position rounded to about 100 m, answers kept in `place-lookups`). Places ridden to or from only once aren't looked up. In Mumbai, Nominatim's `suburb` is often a municipal ward, so wards give way to any other area name. Roads with no name fall back to the neighbourhood.
- **Analysis** (`ride-insights.ts`, `analyzeRoute`): the route is cut into stretches of 100 m to 1 km; each ride's fixes are placed along it and their time spent on the stretches. A stretch's typical speed is the middle of its rides'. Runs of stretches under 20 km/h, or under 45% of the route's cruising speed, are slow spots, ranked by the time they lose against that cruising speed. `compareByPeriod` sets ways side by side at the same time of day only.
- **Map:** `showTraffic` draws the route by usual speed (`mapService.setTrafficLines`), with a key in the HUD, framed between the panels (`fitBetweenPanels`).

### 7.2 `compass.service.ts` — heading

- Listens to `deviceorientation`. On iOS it calls `DeviceOrientationEvent.requestPermission()` first.
- Heading source, in order: `webkitCompassHeading` (iOS), then `360 − alpha`.
- Smoothing: an exponential moving average (α = 0.2) that handles the 359° → 0° wrap correctly (`smoothAngle`).
- Accuracy is `medium` when `event.absolute` is true, otherwise `low` (and flagged as needing calibration).
- Limitation: Android Chrome and WebView usually report **relative** orientation on `deviceorientation`. True north needs `deviceorientationabsolute`, which this service does not listen to yet. See §19.

### 7.3 `map.service.ts` — MapLibre adapter (`MapLibreAdapter`)

Wraps every map operation so the UI never touches MapLibre directly.

- **Setup:** calls `setWorkerUrl` with the worker URL from Vite's `?url` import, so the bundled worker loads. Style: `buildMapStyle()`, the bundled copy of OpenFreeMap's Liberty style read through the `tcmap://` protocol (§11). Starts with a world view (zoom 1.5). The first GPS fix zooms to 15.
- **Status:** `subscribeStatus` reports `{ok, message}`. It is ok after `load`, and an error if the style fails before loading.
- **Clicks:** a tap on a fuel or food icon (14 px of slack) opens a popup with its name and the buttons `setPoiActions` allows (**Go here**, **Add stop**, or **Use this place** while the Plan tab waits for a tap); they fire `poiAction` listeners. Otherwise the tap is checked against the route layers. If it hits a route alternative, `routePick` listeners fire. Otherwise `click` listeners get the coordinate.
- **Fuel & food layer:** `trailcompass-pois` holds the bundled Overture places in view (`bundledPoisInBounds`, loaded on `moveend`). Fuel shows from zoom 10, food from 13, names from 15. Where the bundled data has no tiles (outside India), OSM's `fuel`, `restaurant`, `fast_food` and `cafe` places from the vector tiles show instead. Liberty's own icons for those classes are filtered out so nothing doubles up. Fuel and restaurants are separate overlays (`MAP_OVERLAYS`), switched on and off in the Offline tab's **Map** section (`setOverlay`). The layers button under "my location" shows or hides every overlay at once (`setOverlaysShown`). Both are remembered in localStorage `tc.mapOverlays`.
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

- **Index:** Preferences key `road-pack-index` for corridor packs and `road-pack-index-backbone` for backbone tiles and connector areas (arrays of IDs, newest first). **Metadata:** `road-pack-meta:<id>`. **Body:** `road-packs/<id>.json`, written through `storageManager`.
- **Kinds:** `corridor` packs hold every road class across their area. `backbone` tiles (major roads only) and `connector` areas (full detail only near the centre) are reused only by exact `cacheKey` (`findByCacheKey`).
- **Schema:** packs record `schema: 2` (way tags, junction controls and turn restrictions). Older packs are ignored, so they are downloaded again.
- `findCoveringPack(points)` returns the first current-schema `corridor` pack whose bounding box contains every point (with about 0.002° of padding) **and** whose recorded `coverage` has roads there. A corridor pack only counts if every point is within 80 % of the corridor radius of one of its sample points (`routing/network-coverage.ts`).
- `saveFromCollection` is called after every new Overpass download. It skips collections over about 7.2 M characters and keeps at most **40 corridor packs** and **60 backbone/connector packs** (the oldest are deleted).
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
   ├─ single hop ≤ 55 km, no waypoints:
   │     calculateDirectRoutes
   │        ensureRoadGraph ─▶ loadOsmNetworkForRoute   (osm-network-loader.ts)
   │        snapRoutingEndpoints
   │        OfflineGraphEngine.calculateRoutes (≤ 3 alternatives)      (graph-engine.ts)
   │
   ├─ waypoints, every hop ≤ 55 km:
   │     calculateChainedRoute — stop to stop, one corridor per hop, mergeRoutes
   │
   └─ any hop > 55 km, or either path above hit NoRoadPathError:
         calculateTwoPassRoute
            pass 1: loadBackboneNetwork (backbone-loader.ts) + loadLocalArea per stop
                    ─▶ A* per user leg on major roads
            pass 2: splitPolyline(backbone path, 50 km)
                    per slice: loadOsmNetworkForRoute({ guide }) + clipped backbone ─▶ A*
                    (a slice that fails keeps its backbone path)
            mergeRoutes

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
interface RouteRequestOptions { waypoints?; profile?; alternatives?; allowExpressways?; signal? }
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

**`calculateRoutes(start, end, {waypoints, profile, alternatives = 3, allowExpressways = false, signal})`**
- **Valhalla path:** one route, labelled "Best match".
- **Direct path:** a single hop of 55 km or less with no waypoints. `ensureRoadGraph` (download only if the current graph does not already cover both points within 350 m), then snap both ends to the nearest road (within 2.5 km), then the graph engine returns up to 3 alternatives.
- **Chained path:** waypoints where every hop is 55 km or less. Returns one merged route.
- **Two-pass path:** any hop over 55 km, or when the direct or chained path throws `NoRoadPathError` (the road left the small download). Returns one merged route.
- Progress events go to `subscribeProgress` listeners. 400 ms after a job finishes, it emits `idle`, but only if no newer job has started (`jobEpoch`).

**Chained routing (`calculateChainedRoute`)**
1. The chain is `start → waypoint → … → end`; there are no synthetic vias.
2. **Prefetching:** legs 1 and 2 start downloading at once. While leg *i* is being routed, leg *i + 1* is already downloading. This keeps the Overpass mirror busy during the A\* search.
3. For each leg:
   - `loadPrefetchedCorridor`: if the current graph already covers the leg, use it. Otherwise wait for the prefetched download. If the previous leg's snapped end (the cursor) is not where the prefetch started, and the prefetched corridor does not reach the cursor, download again from the cursor.
   - Snap both ends (within 2.5 km) and run the graph engine for the best route only. The next leg starts at this leg's **snapped** end.
4. `mergeRoutes` joins the coordinates (dropping a duplicate joint point) and sums the instructions, distance and duration.

**Two-pass routing (`calculateTwoPassRoute`)**

The straight line between two far-apart places often crosses water or hills that the real road goes around. For example, Goregaon → Ganpatipule crosses Mumbai harbour and the Konkan creeks, while NH66 runs ~30 km inland. So the route is found in two passes:
1. **Backbone pass (`routeOnBackbone`):** load `motorway | trunk | primary` (+ links) in 0.5° tiles within `backboneRadiusMeters` of the trip (20 % of its length, 20–60 km). Also load `loadLocalArea` around every stop: every class within 6 km, plus secondary/tertiary within 20 km, so a small town reaches the highways. Merge everything and run A\* per user leg. If a leg finds no path, the radius is doubled once.
2. **Refine pass:** cut each backbone leg into ~50 km slices at path vertices (`splitPolyline`). For each slice, download full detail along it (`loadOsmNetworkForRoute` with `guide`), merge it with the backbone clipped to the slice (+5 km), and run A\*. The next slice's download starts while the current one is routed.
3. **Fallback:** a slice whose detail download or search fails keeps its backbone path. Once pass 1 succeeds, the trip always gets a route.

> Note: `offlineGraphEngine.loadFeatureCollection` **replaces** the graph each time. `mergeNetworks` (osm-network-loader.ts) combines downloads first, keeping each OSM way once.

### 8.3 `osm-network-loader.ts` — downloading road data

`loadOsmNetworkForRoute(start, end, waypoints, onProgress, signal, { guide? })`

1. **Size limit:** without a `guide`, throws if any two points are more than **80 km** apart.
2. **Query shape:**
   - Span < 25 km: a **bounding-box** query (points' bbox + 0.025° padding).
   - Span ≥ 25 km: a **corridor** query, made of `around:4000` circles at sample points every 12 km along the great circle (at most 12 circles). This avoids downloading a huge diagonal box for a long thin leg.
   - With a `guide` (a known road path from the backbone pass): `around:3000` circles every 4 km **along the path** (at most 20).
   - Road classes: `motorway` to `service`, plus `*_link`, excluding `area=yes`.
   - Every query (`buildNetworkQuery`) also returns the junction controls on those ways (`traffic_signals`, `stop`, `give_way`, `railway=level_crossing`, `barrier=toll_booth`) and via-node turn restrictions (`rel(bw)[type=restriction]`). Ways use `out tags geom` to keep the response small.
3. **Cache layers:** an in-memory `Map` (24 entries; the key is the bbox or the corridor points), then `roadPackService.findCoveringPack` (disk), then Overpass.
4. **`fetchOverpass`** (in `overpass-client.ts`, shared with the POI search): up to 6 attempts, rotating through `overpass-api.de`, `overpass.kumi.systems` and `maps.mail.ru`. Each attempt first gets a slot from `overpassScheduler`, and is abandoned (and the next mirror tried) if it hasn't finished 15 s after the query's own `[timeout:N]`.
   - HTTP 429, 502, 503 or 504: marks the mirror as overloaded and waits for `Retry-After` (at most 30 s) or the backoff.
   - Other HTTP errors, bad JSON, or network errors: back off and switch mirror.
   - Backoff: 2 s, 4 s, 8 s (maximum 8 s). The wait can be aborted.
5. **Download progress:** if `Content-Length` is present, the body is read as a stream and real byte progress is reported. Otherwise the progress is indeterminate.
6. **Conversion (`overpassToNetwork`):** ways with geometry become GeoJSON `LineString` features with `highway`, `oneway`, `name`, `osm_id` and a `tags` subset (`ROAD_TAG_KEYS` in `road-attributes.ts`: lanes, maxspeed, surface, access keys, junction, …). Control nodes become `controls`, and restriction relations become `restrictions`. Access rules are applied by the graph engine, not here. The collection's `region.coverage` records what was really downloaded: `{kind: 'bbox'}`, or `{kind: 'corridor', samples, radiusMeters}` for corridor queries.
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
- Way tags are read by `roadAttributes` (`road-attributes.ts`):
  - **Access** for two-wheelers, most specific first: `motorcycle` > `motor_vehicle` > `vehicle` > `access`. `no`, `private`, `agricultural`, … drop the way; `destination` / `customers` make its edges cost ×5 (fine to start or end on, avoided as a through route).
  - **One-way:** `oneway:motorcycle` overrides `oneway`. `oneway=yes|true|1` creates only the forward edge and `oneway=-1` only the reverse edge. Roundabouts (`junction=roundabout|circular`), `motorway`, `motorway_link` and `trunk_link` are one-way when they have no tag. `reversible` / `alternating` ways are dropped.
  - **Expressway:** `motorway`, `motorway_link`, `motorroad=yes` or `expressway=yes`, unless `motorcycle=yes`. The search skips these edges unless `allowExpressways` is set (the rider's "Expressways" toggle, off by default), and snapping skips nodes that only expressways touch.
  - **Speed:** class speed (§8.7), then a numeric `maxspeed` → `min(limit × 0.9, class × 1.2)`; 3+ lanes per direction ×1.15, 2 ×1.05, a single-lane two-way road ×0.75; unpaved ×0.55; bad smoothness ×0.7. Clamped to 3–30 m/s.
- **Junction delays** are added to the time of edges *entering* a control node: signals 25 s, stop 8 s, give way 4 s, level crossing 25 s, toll booth 15 s. `traffic_signals:direction` / `direction` limit a control to one direction. Signals within 50 m of each other are one cluster, and an edge only pays when it enters a cluster from outside it, so a dual-carriageway junction counts once.
- Each edge stores `meters`, `seconds` (ride time + delay), `delaySeconds`, `wayId`, `expressway` and `destinationOnly`. Edge IDs are `${osm_id}:${segmentIndex}:fwd|rev`.

**Snapping:** nodes are also bucketed in a grid of 0.005° cells. `snapToNearestNode(point, maxMeters)` searches rings of cells outward from the point's cell and stops once no farther ring can hold a closer node, or the ring is beyond `maxMeters`. `coversPoints` requires both ends to be within 350 m of a road. `nearestRoadCoordinate(point, max)` is used for the wider 2.5 km and 12 km snaps.

**Search (`aStar`)**
- The heuristic is the straight-line distance to the goal multiplied by `minCostPerMeter(profile)`, the cheapest cost any edge can have per metre under that profile. This never overestimates, so the first route found is the cheapest. Without the scaling, "fastest" could settle on a slow street over a cheaper motorway.
- The open set is a binary min-heap (`min-heap.ts`). A state can be pushed again with a better score; outdated entries are skipped when popped, and settled states are kept in a closed set.
- **Turn restrictions:** a search state is a node key, except at via nodes of a restriction, where it is `node|fromWay`. From such a state a `no_*` rule removes the exit onto the `to` way and an `only_*` rule keeps only that exit. `restriction:motorcycle` beats `restriction`, and restrictions with `except=motorcycle` are ignored.
- The edge cost comes from `edgeCost(edge, profile)`, multiplied by any alternative penalty on that edge.

**Alternatives (`calculateRoutes`)**
1. Run A\*. Add the result if it does not overlap any accepted route by more than 72 % of its edges (measured against the smaller set), and is not more than 1.55× the best route's length.
2. Multiply the cost of every edge just used by 6, and search again.
3. Repeat up to `want × 3` times or until `want` routes (at most 3) are accepted.

**Building the result:** expands the path's edges into coordinates, adds the original start and end points if they are more than 1 m from the snapped nodes (ridden at 5 m/s), measures the length, sums edge `seconds` for the duration, and generates instructions (`buildManeuversFromPath`). Labels are "Best match", "Alternative 1", and so on. Failures to connect throw `NoRoadPathError`.

### 8.7 `routing-profiles.ts` — route types and costs

| Profile | Edge cost |
|---|---|
| `shortest` | metres |
| `fastest` | `edge seconds × 10` (ride time including junction delays, scaled up) |
| `less_traffic` | `metres × penalty(highway) + delaySeconds × 10`: motorway 4.5, trunk 3.2, primary 2.2, secondary 1.4, tertiary 1.05, residential, living street and unclassified 0.85, service 1.1 |

Base motorcycle speeds by class (m/s), before the tag adjustments in §8.6: motorway 28 (about 100 km/h), trunk 22, primary 16, secondary 13, tertiary 11, residential and unclassified 9, living street 6, service 5, anything else 10. `MAX_SPEED_MPS` (30) caps every edge, and `minCostPerMeter('fastest')` is `10 / 30`.

`loadAllowExpressways` / `saveAllowExpressways` keep the "Expressways" toggle in `localStorage` (`tc.allowExpressways`, default off).

"Less traffic" and the signal delays are estimates based on road class and OSM tags. They do **not** use live traffic data.

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
- `route.places` (optional) names the destination and each stop, so a reopened or imported trip shows "Chiplun" rather than "Stop 1". `parseRouteFile` keeps the stop names only if there is one per waypoint, with a known kind.
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
| `RideRepository` (`ride-repository.ts`) | `ride-index`, `ride:<id>`; tracks in `map-packages/rides/<id>.json` | Yes: the ride log. |
| `RideInsightsService` (`ride-insights.service.ts`) | `ride-places` (names the rider gave), `place-lookups` (names found online); `map-packages/rides/trips.json` (each ride's trip, worked out again if lost) | Yes: routes and places of the ride log. |

### 10.3 Where everything is stored

| Data | Native (Android) | Web |
|---|---|---|
| Saved routes | Preferences `trailcompass:route:*` | localStorage (through Preferences) |
| Road pack metadata | Preferences `trailcompass:road-pack-*` | localStorage |
| Road pack bodies | `Directory.Data/map-packages/road-packs/<id>.json` | localStorage `trailcompass:file:road-packs/<id>.json` |
| Region catalogue (stub) | `Directory.Data/map-packages/regions.json` | localStorage `trailcompass:file:regions.json` |
| Offline maps (trips and areas) | Preferences `trailcompass:offline-maps` | localStorage (through Preferences) |
| Map tiles (the tile store) | `Directory.Data/map-packages/tiles/<time>-<id>.pmtiles` | IndexedDB `trailcompass-map-files` |
| Map fonts and icons | `Directory.Data/map-packages/assets/` | IndexedDB `trailcompass-map-files` |
| Shared route files (temporary) | `Directory.Cache/shared-routes/` | Downloaded through the browser |
| Shared map files (temporary) | `Directory.Cache/shared-maps/` | Downloaded through the browser |
| Stop-suggestion settings | localStorage `tc.tankRangeKm`, `tc.departTime`, `tc.mealKinds` | same |
| Itinerary and navigation state | **Memory only.** Lost when the app restarts. | same |

---

## 11. Offline maps

A saved trip keeps the map along its route, and an area (a city, district or state) can be saved from the Offline tab. Both are lists of tiles; the tiles themselves are kept once, in the tile store. Everything the map loads goes through the `tcmap://` protocol, so saved tiles are used automatically, online or not.

| File | What it does |
|---|---|
| `tile-protocol.ts` | Registers `tcmap://` with MapLibre. `tcmap://tiles/z/x/y`: the tile store's copy (`readOfflineTile`), else OpenFreeMap. Offline, a missing tile errors and MapLibre keeps stretching the lower zoom it has. `tcmap://fonts/…` and `tcmap://sprites/…`: from `map-packages/assets/` when kept, else downloaded and kept. `tcmap://ne2/…`: the low-zoom relief, online only. `buildMapStyle()` rewrites the bundled `liberty-style.json` to use these. `planetTilesTemplate()` reads OpenFreeMap's current planet build from its TileJSON and remembers it in localStorage `tc.ofmPlanetTiles`. `prefetchMapAssets()` saves the icons and the font ranges for Latin, Indian scripts and Urdu. |
| `tile-plan.ts` | `planRouteTiles(route)`: every tile of the route's area (+10 km) up to zoom 8, then bands along the road up to zoom 14 (30 km wide at zoom 9 down to ±2.5 km at zoom 14). Narrower bands are tried until it fits OpenFreeMap's 3,000-tile limit. `planAreaTiles(area)`: every tile touching the area's outline (`areaTiles`: the tiles its edges cross plus those inside, row by row), zoom by zoom up to the closest zoom that fits the limit. A city keeps zoom 14; Maharashtra stops at zoom 11. |
| `tile-store.ts` | The tile store: every saved tile once, in PMTiles files ("segments") under `map-packages/tiles/`, each tile with its download time and OpenFreeMap build (`trailcompass.times` in the file's metadata, tiles grouped by time). `init` reads every segment's directories into an index; a file the app closed mid-write is deleted. `writer()` writes new segments of up to 500 tiles or 8 MB, so a download cut short keeps what arrived. A tile saved again keeps the newer download (equal times: the later file). `collect(live)` forgets tiles no map lists, deletes files nothing uses and rewrites files over half garbage (at least 1 MB). `encodeTileIds`/`decodeTileIds` store tile lists compactly (sorted delta varints, base64). |
| `pmtiles-writer.ts` | Writes PMTiles v3. Tile data is appended as it arrives; the header and root directory go in the first 16 KiB at the end, with leaf directories when the root wouldn't fit. Identical tiles are stored once. `readArchive` lists every tile entry of a file with its metadata; `readRanges` reads many byte ranges in a few large reads. |
| `pack-files.ts` | Binary files. Android: `Directory.Data/map-packages/`, appended in 1 MB batches through Filesystem, with `readRange` and `writeAt` from `MapFilesPlugin.java` (the web view's local server ignores where a Range starts); share files go to `Directory.Cache/shared-maps/`. Web: Blobs in IndexedDB `trailcompass-map-files`; share files are Blobs to download. |
| `services/map-pack.service.ts` | Offline maps: `route:<route id>` and `area:<OpenStreetMap id>` records in Preferences `trailcompass:offline-maps`, each with its tile list, `downloadedAt` and OpenFreeMap build. `downloadRoute(route)`, `downloadArea(area)` and `update(id)` queue a download: one at a time, 4 tiles at a time, gzipped, skipping tiles already saved from the current build, stopping at 48 MB (the map then keeps the tiles that arrived, `trimmed`); waits for Wi-Fi with that setting. Each tile gets 3 attempts of up to 30 s; a tile that still fails is tried again once the rest are in (the progress shows `retrying`), and if it fails again the download ends with "N map tiles didn't download" and Retry fetches only those. Eight failures in a row, or the phone going offline, stop it as a lost connection. `buildShareFile(id, route?)` writes the map's tiles to a share file. `openSharedFile` and `importSharedFile` merge one in (below). `pruneOrphans`: at start-up, removes maps of deleted trips (so Undo keeps the map). Tiles are collected once nothing is downloading, importing or sharing. Maps saved in the older one-file-per-trip format are deleted at start-up. |
| `services/place-search.service.ts` | `searchAreas(query)`: Nominatim with `layer=address` and outlines simplified to about 500 m, for **Save an area**. |
| `region-manager.ts`, `package-validator.ts` | The earlier region-download stubs, not connected. |
| `storage-manager.ts` | A Filesystem wrapper rooted at `map-packages/` (`Directory.Data`), with a `localStorage` fallback on the web, for text files (road packs). |

**When maps download.** Saving a trip with **Offline map** ticked (the default) downloads its map in the background; Library shows the progress, with Stop, Retry and Resume. Trips saved without one show **Save map**. Sharing with **Offline map** ticked downloads the map first (only what the store lacks), with progress and Cancel, then deletes the map when the sheet closes; tiles other maps use stay. **Save an area** shows the detail that fits and how many of its tiles the phone already has, then downloads in the background. **Update** fetches a map's missing tiles and those from an older OpenFreeMap build.

**Share file.** `<name>.trailcompass.pmtiles` is a standard PMTiles archive (MVT, gzip, OpenMapTiles schema) with the map's saved tiles. Its metadata has `trailcompass: {format: "trailcompass-map", version: 2, pack, route?, times}`: `pack` is the map's record without `createdAt` (its tile list included), `route` the `.trailcompass.json` envelope (§8.12) for a trip, and `times` each tile's download time and build. Import recognises it by name or by the `PMTiles` magic bytes. The file picker also offers `application/octet-stream`, because Android lists only file types it knows.

**Import.** A shared file joins what's on the phone as if downloaded there. The trip is the same trip as one with its id: the copy with the later `updatedAt` is kept, with its own dates (`saveImported`). The map's record is replaced when the file's `downloadedAt` is later. Each tile the map lists is taken when the phone lacks it or holds an older download; the rest are skipped. Nothing is saved twice, and importing the same file again changes nothing.

**Limits.** OpenFreeMap allows offline downloads of at most 3,000 tiles or 50 MB, 4 requests at a time, from an app with its own User-Agent (`appendUserAgent: 'TrailCompass'`). A long trip or a big area loses street detail first; save a city inside a state for its streets. Downloads run in the web view and stop if the app is closed; **Resume** carries on.

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

- Generated by Capacitor. `MainActivity` extends `BridgeActivity` and registers the app's own plugins: `AppUpdaterPlugin` (in-app updates), `DownloadsPlugin` (background planning and network type), `MapFilesPlugin` (byte ranges of offline map files) and `RideLocationPlugin` (the chosen GPS mode and ride recording).
- `applicationId` / `namespace`: `com.example.trailcompass`. **This is a placeholder and must change before publishing.**
- `minSdk 23`, `compileSdk` and `targetSdk 35`. `release.mjs` bumps `versionCode` and `versionName`.
- Permissions: `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `REQUEST_INSTALL_PACKAGES`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` and `ACCESS_NETWORK_STATE`.
- `DownloadService` is a `dataSync` foreground service that runs only while a route plans in the background. `RideRecorderService` is a `location` foreground service that runs while a ride records; it is started from the app on screen, so it needs no background-location permission. Without a ride recording, GPS updates stop when the app goes to the background.
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
| Basemap tiles | **No** along saved trips and in saved areas; elsewhere yes | OpenFreeMap |
| UI fonts | First load (falls back to system fonts) | Google Fonts |
| Road data for routing | **Yes, unless** the area is in the memory cache or a road pack, or Valhalla tiles are bundled. With Downloads set to Wi-Fi only, planning waits for Wi-Fi; rerouting mid-ride never waits | Overpass (5 mirrors) |
| Place search | Yes | Nominatim |
| Fuel and food POIs, stop suggestions | No for India (bundled Overture tiles); live results added where those are few | Nominatim, then Overpass |
| Fuel and food on the map | No for India (bundled); elsewhere from the map tiles | OpenFreeMap |
| Offline map downloads | Yes, once per trip or area (updates fetch only newer builds); waits for Wi-Fi with that setting | OpenFreeMap |
| Area search | Yes | Nominatim |
| Names of ride log places and roads | Only for places ridden to or from twice or more, with no name from the rider, navigation or a saved trip, and for telling routes and slow spots apart. Without a connection they show as coordinates or distances. Positions are rounded to about 100 m and answers kept | Nominatim |
| Fuel and food data updates | Optional; checked daily, the app keeps working on its current copy | GitHub Pages |
| GPS position and compass | No, in Satellites only mode. The default mode uses mobile data and Wi-Fi when there are some, for a quicker fix; Battery saver needs them | Device (network location: the phone's provider) |
| A\* routing on cached roads, follow loop, arrival | No | On the phone |
| Rerouting | Only if the new corridor is not cached | Overpass |
| Saved routes: open, save, share | No (sharing uses the system share sheet) | On the phone |

So a saved trip runs without signal: its roads, its map and the fuel and food data are on the phone. Planning a new trip, and the map away from saved trips, still need a network.

---

## 18. Unused and stub code

| Item | Location | Status |
|---|---|---|
| `buildDirectRoute`, `routeLengthOk` | `routing/direct-route.ts` | Not imported anywhere |
| `RegionManager`, `validateRegionPackage`, `DownloadProgress` | `offline/`, `components/` | Not connected to the UI. Area downloads use `map-pack.service.ts` instead. |
| `navigationService.pause()` / `resume()` | `navigation.service.ts` | No UI calls them |
| `resolveScreen` | `app/routes.tsx` | Not called |
| GeoJSON export (`kind: 'geojson'`) | `route-library.service.ts` | No UI offers it |
| `MapLibreAdapter.fitBounds`, `alternativeColor` | `map.service.ts` | Not called |

---

## 19. Known issues and gaps

These came up while reading the code for this guide. Each one points to the relevant code. Nothing here has been confirmed on a device.

### Fixed on 2026-10-27

- **Zen mode.** Tapping the compass leaves only the map, the route and a large compass, with an Exit button. The map still pans and zooms; taps never change the trip. Entering and leaving fade and slide; reduced-motion settings switch it instantly.
- **The compass needle and the map's position arrow turn the short way across north**, instead of spinning almost a full turn.
- **Route planning shows a persistent notification** as soon as it starts, with its progress and Pause, Resume and Stop, so it carries on if you leave the app (`background-planning.service.ts`, `DownloadsPlugin.java`, `DownloadService.java`). Pausing keeps the roads downloaded so far, so Resume carries on from there.
- **A Wi-Fi only setting for downloads** (Offline → Downloads, `download-policy.service.ts`). On mobile data, road downloads for planning wait for Wi-Fi and say so; fuel and food data and app updates wait too. Rerouting during a ride always downloads.
- **Road packs are saved on Android.** `storage-manager.ts` now writes with `recursive: true`; before, writes into the missing `road-packs/` folder failed silently.
- **Road downloads no longer stall on a dead Overpass server.** `overpass-client.ts` also tries `lz4.` and `z.overpass-api.de`, the two servers behind overpass-api.de, which often answer when its front door returns 502. A server that sends nothing within 75 s is dropped and skipped for 10 minutes, and a busy one for 1 minute. While a retry is under way, the progress line reads "map server busy, trying another". If an area still fails, the error says how many loaded; they stay cached, so planning again continues.
- **Overpass replies with a `runtime error` remark** (HTTP 200 with a cut-off element list) are treated as a failure and retried on the next mirror instead of being cached (`overpass-client.ts`).
- **The screen stays on while navigating** (`hooks/useKeepAwake.ts`).
- **Start no longer follows an out-of-date route.** If stops or the destination change after planning, Start is replaced by Plan / Preview again (`NavigationService.isPlannedFor`).
- **`ensureFix` waits for a fresh GPS fix** instead of throwing when the last fix is over 60 s old.
- **The Android back button** closes the open sheet, then map-pick or ride view, then returns to the Map tab. During navigation, leaving the app needs a second press (`hooks/useBackHandler.ts`, `App.tsx`).
- **Spoken turn prompts** for a helmet headset, with an on/off toggle in Route options (`voice-guidance.service.ts`).
- **Fuel and food suggestions work again.** OSM maps few pumps and eateries along Indian highways, and the public Overpass servers often answer 504. The app now ships Overture Maps places for India in 1° tiles (`bundled-pois.service.ts`, built by `npm run data:poi`) and adds live OSM results only where those are few. Small areas use Nominatim; long stretches use one Overpass query (`poi-search.service.ts`). Fuel is searched over the last part of each tank leg, and each leg starts from the pump picked. A trip that fits in one tank says so instead of "no stations" (`stop-suggest.service.ts`).
- **Fuel and food data updates itself without a new APK.** A weekly workflow (`.github/workflows/pages.yml`) publishes each new Overture release on GitHub Pages. The app downloads it about once a day when online (`poi-data.service.ts`), and the Offline tab shows the version in use. One-time setup: Settings → Pages → Source: GitHub Actions. See `public/assets/poi/README.md`.
- **Downloads come from the website.** GitHub's own release downloads stall on many mobile networks. The Pages workflow now also runs when a release is published, and copies its APK to `download/` on the site, with `download/latest.json`. The landing page's download button and the in-app updater use that copy, falling back to GitHub. `README.md` links to the website, not to the APK. The two READMEs replace the original planning README.
- **In-app updates.** `app-update.service.ts` checks GitHub's latest release about once a day. When there is a newer version, it shows an update sheet, but never during navigation. The sheet downloads the APK with progress and opens Android's installer. A small plugin in the app does the native part (`android/…/AppUpdaterPlugin.java`, registered in `MainActivity`; it needs the `REQUEST_INSTALL_PACKAGES` permission). The Offline tab shows the installed version and has a "Check for updates" button. Android only installs an update signed with the same key as the installed app: keep building releases on the same machine (its debug keystore), or move to a release keystore.
- **Landing page on GitHub Pages** (<https://praneth2580.github.io/TrailCompass/>). The source is in `site/`: static HTML, CSS and a small script, with SEO and Open Graph tags. Its download buttons point at the newest GitHub release APK. `scripts/build-site.mjs` assembles it, and `.github/workflows/pages.yml` publishes it with the fuel and food data. Preview it with `npm run site:preview`. After changing the phone illustration, re-render the share image with `npm run site:og`.
- **Dismissing the share sheet** no longer opens it a second time or shows an error.
- **The map stays mounted across tabs**, so it no longer reloads or loses its camera.
- **`npm test` skips `*.scratch.test.ts`** (live OSM requests). Run them with `LIVE_OSM=1 npm test`.

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
3. **Background location only while a ride records.** `RideRecorderService` keeps the GPS running with the screen off (and, with auto record on, whenever you navigate), and fixes keep reaching the web view. Whether turn-by-turn and voice prompts keep going with the screen locked hasn't been checked on a phone. Without a ride recording, updates stop in the background.
4. **Trip and navigation state is lost on restart.** Only saved routes and road packs survive.
5. **`sharp` is not a declared dependency.** `generate-icons.mjs` needs it, but today it is installed only indirectly (through `@jansoft/mbujkanji-valhalla-wasm` → `next`). Add it to `devDependencies`.
6. **`release.mjs` needs `android/app/src/main/res/xml/config.xml`, which is gitignored.** It exists only after a `cap sync`, so a fresh clone fails at the version-bump step. The script also supports a token embedded in the `origin` URL, which means storing a credential in `.git/config`.
7. **Placeholder app ID** `com.example.trailcompass` (see §16.1), and releases ship a debug APK.
8. **`npm install <package>` fails with ERESOLVE.** `@jansoft/mbujkanji-valhalla-wasm` depends on `@vitest/browser-*@latest`, which wants a different `vitest` than the project's. Adding a package currently needs `--legacy-peer-deps`.

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
npm test               # LIVE_OSM=1 npm test also runs the live OSM scratch tests

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
| Change offline map coverage or limits | `offline/tile-plan.ts`, `services/map-pack.service.ts` |
| Change the fuel & food map layer | `services/map.service.ts` (`ensurePoiLayers`, `refreshPois`) |
| Add a new tab | `app/routes.tsx`, `App.tsx` (screen switch and `NavIcon`) |
