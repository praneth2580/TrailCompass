# Developing TrailCompass

How to build, run, test and release TrailCompass. For a file-by-file tour of the code and the reasons behind its design, read the [Project Guide](docs/PROJECT_GUIDE.md).

- [Tech stack](#tech-stack)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [npm scripts](#npm-scripts)
- [Project layout](#project-layout)
- [How it works](#how-it-works)
- [Android builds](#android-builds)
- [Releasing a new version](#releasing-a-new-version)
- [The website on GitHub Pages](#the-website-on-github-pages)
- [Fuel and food data](#fuel-and-food-data)
- [Testing](#testing)
- [External services](#external-services)
- [Known issues and gotchas](#known-issues-and-gotchas)
- [Safety, licensing and contributing](#safety-licensing-and-contributing)

## Tech stack

| Area | Technology |
|---|---|
| UI | React 19, TypeScript 6, plain CSS (`src/index.css`, design tokens in `:root`) |
| Build | Vite 8 |
| Native shell | Capacitor 7, Android only (min Android 6.0, SDK 23; target SDK 35) |
| Capacitor plugins | Geolocation, Filesystem, Preferences, Share, App, Keep Awake, Text-to-Speech, and two plugins inside the app: `AppUpdaterPlugin` and `DownloadsPlugin` |
| Map | MapLibre GL JS 6 with OpenFreeMap's Liberty style (online) |
| Routing | On-device A* over OpenStreetMap roads downloaded from Overpass; Valhalla WASM optional |
| Tests and lint | Vitest 4 (Node environment), oxlint |
| Data builds | Python 3.10+ with DuckDB, reading Overture Maps from its public S3 bucket |
| Hosting | GitHub Releases (APKs) and GitHub Pages (website, data, APK copy) |

## Requirements

- **Node.js 20+** and npm 10.
- **For Android builds:** JDK 21 and the Android SDK (platform 35). Android Studio's default install works. The scripts find the SDK through `ANDROID_HOME` or `ANDROID_SDK_ROOT`, and the JDK in its usual locations.
- **For data builds:** Python 3.10+ and `pip install duckdb==1.5.6`.
- **For releases:** the GitHub CLI, signed in (`gh auth login`).
- **A real Android phone.** GPS, compass, voice prompts, keep-awake and in-app updates can only be tested properly on a device.

## Quick start

```bash
git clone https://github.com/praneth2580/TrailCompass.git
cd TrailCompass
npm install        # "ERESOLVE overriding peer dependency" warnings are expected
npm run dev        # http://localhost:5173 (GPS needs localhost or https)
npm test
```

The web build is good for UI work. Anything native (GPS accuracy, sensors, file storage, voice, installs) needs `npm run cap:run` and a phone.

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (also reachable from your LAN) |
| `npm run build` | Type-check (`tsc -b`) and build the web app into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | oxlint |
| `npm test` | Vitest unit tests. `LIVE_OSM=1 npm test` also runs the `*.scratch.test.ts` tests that call live OSM servers (slow) |
| `npm run cap:sync` | Build, then copy the web app into the Android project |
| `npm run cap:build` | Sync, then assemble the debug APK |
| `npm run cap:emulator` | Start an emulator (`ANDROID_AVD`, or the default AVD) |
| `npm run cap:install` | Install the debug APK on a connected phone or emulator |
| `npm run cap:run` | Build, sync, assemble, install and launch |
| `npm run release:minor` / `release:major` | Publish a new version on GitHub with its APK ([details](#releasing-a-new-version)) |
| `npm run icons:generate` | Regenerate app icons and splash screens from the brand mark |
| `npm run data:poi` | Rebuild the bundled fuel and food data ([details](#fuel-and-food-data)) |
| `npm run site:build` | Assemble the website into `_site/` |
| `npm run site:preview` | Build the website and serve it locally (port 4173) |
| `npm run site:og` | Re-render the share image `site/og-image.png` |

## Project layout

```text
.github/workflows/pages.yml   Publishes the website, fuel and food data, and APK copy to GitHub Pages
android/                      Capacitor Android project (the app's own plugins live here)
docs/PROJECT_GUIDE.md         In-depth guide to the code
public/                       App icons and bundled assets
  assets/poi/                 Fuel and food tiles for India (Overture Maps), with sources and licences
resources/                    Master app icon
scripts/                      Android build/run, release, icons, data and website builders
site/                         The landing page: static HTML, CSS and a small script
src/
  app/                        App shell: wires services to screens; tab table
  components/                 Screens, sheets, banners, widgets
  services/                   Location, compass, map, navigation, trips, stops, voice, updates
  routing/                    Road downloads (Overpass), road graph and A*, turn instructions, route files
  database/                   Small JSON stores on Capacitor Preferences
  offline/                    File storage helpers (offline map packages are not built yet)
  hooks/                      Back button, keep-awake, ride view
  types/                      Shared types
```

## How it works

**App shell and services.** State lives in singleton services (`src/services/*.service.ts`). Each has `getState()` and `subscribe()`, and there is no state library. `src/app/App.tsx` connects them to the screens. The map stays mounted behind the other tabs, so it doesn't reload when you switch.

**Routing.** Routes are calculated on the phone, never by an online routing API. For a long trip, the app first downloads the major roads (motorway, trunk and primary) in 0.5° tiles around the trip. It finds the main path on them, then downloads local streets along that path to refine each leg. The roads come from public Overpass servers through `src/routing/overpass-client.ts`, which handles retries, a server that never answers and server cooldowns. Downloaded areas are kept in memory and saved on the phone as "road packs", so planning again in the same area is quick. Valhalla WASM is used instead only if a tile archive is bundled; none is shipped.

**Navigation.** `navigation.service.ts` follows your position along the route. It detects when you're off route (it needs two bad fixes in a row) and reroutes, skipping stops you've already passed. Voice prompts (`voice-guidance.service.ts`) are timed to your speed. The screen stays on while you navigate, and the ride view goes full screen once you're moving.

**Fuel and food stops.** `stop-suggest.service.ts` plans fuel stops by tank range and food stops by meal time. It searches a stretch of the route, not single points. Places come first from the Overture data bundled in `public/assets/poi/`, which also works offline. Live OpenStreetMap results are added where those are few: Nominatim for small areas, Overpass for long stretches.

**Planning in the background.** While a route is planning, **Run in background** starts a foreground service (`DownloadService`, type `dataSync`) with a progress notification and sends the app to the background. The planning itself keeps running in the web view; the service only stops Android from closing the app. The notification's Pause cancels the plan and keeps the roads downloaded so far; Resume plans the same trip again from that cache; Stop cancels it. When the plan finishes in the background, a second notification says the route is ready or why it failed. `background-planning.service.ts` drives this through `DownloadsPlugin`.

**Wi-Fi only downloads.** The Offline tab's Downloads setting (`download-policy.service.ts`) can keep large downloads off mobile data. Road downloads for planning then wait for Wi-Fi (the progress line says so), and fuel and food data and app updates hold off. Rerouting during a ride, map tiles and searches always use whatever network is up. `DownloadsPlugin` reports the network type from Android's `ConnectivityManager`.

**Updates without a new build.** The fuel and food data refreshes itself. About once a day, `poi-data.service.ts` checks the website's `poi/manifest.json` and downloads a newer release. The app updates itself too: `app-update.service.ts` checks the website's `download/latest.json`, falling back to the GitHub API. It downloads the APK with progress and opens Android's installer through `AppUpdaterPlugin`.

## Android builds

```bash
npm run cap:run          # build, sync, assemble, install and launch the debug APK
```

Or one step at a time: `npm run cap:sync`, `npm run cap:build`, `npm run cap:install`. To work in Android Studio, run `npx cap open android`. If no phone is connected, `cap:install` and `cap:run` start an emulator; set `ANDROID_AVD` to choose which one.

- **Native code** in `android/app/src/main/java/com/example/trailcompass/`, registered in `MainActivity`:
  - `AppUpdaterPlugin.java` downloads update APKs and opens the installer.
  - `DownloadsPlugin.java` starts and stops `DownloadService` (background planning), posts its notifications (`DownloadNotifications.java`), and reports Wi-Fi or mobile data.
- **Permissions:** location and internet; `REQUEST_INSTALL_PACKAGES` for in-app updates; `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` and `POST_NOTIFICATIONS` (asked the first time you run planning in the background) for background planning; `ACCESS_NETWORK_STATE` for the Wi-Fi only setting.
- **App ID.** `com.example.trailcompass` is a placeholder. Changing it later makes Android treat the app as a different one, so installed copies won't update to it.

## Releasing a new version

```bash
npm run release:minor -- --notes "What changed"   # or release:major; add --draft to review first
```

The script needs a clean working tree and a remote named `origin`. On a fresh clone, run `npm run cap:sync` once first: the script also updates Android's generated `config.xml`, which only exists after a sync. It then:

1. Bumps the version in `package.json` and the Android `versionName` and `versionCode`.
2. Builds the debug APK.
3. Commits, tags `vX.Y.0` and pushes.
4. Creates the GitHub release "TrailCompass vX.Y.0" with `trailcompass.X.Y.0.apk` attached.

Publishing the release starts the Pages workflow, which copies the APK onto the website. From then on, the website's download button and the in-app updater offer the new version. Your `--notes` become "What's new" in the app's update sheet.

**Keep the signing key.** Releases are debug builds signed with the debug key of the machine that built them. Android only installs an update signed with the same key as the installed app. Build every release on the same machine, or set up a release keystore before you switch.

## The website on GitHub Pages

The site at <https://praneth2580.github.io/TrailCompass/> is published by `.github/workflows/pages.yml` ("Publish site"). Pages replaces the whole site on every publish, so one workflow always publishes everything together:

| Path | Contents |
|---|---|
| `/` | The landing page, built from `site/` by `scripts/build-site.mjs` |
| `download/latest.json`, `download/*.apk` | A copy of the newest release. GitHub's own release downloads are slow or stall on many mobile networks; Pages is served through a CDN |
| `poi/manifest.json`, `poi/<release>/…` | The fuel and food data the app downloads |

The workflow runs:
- **Every Monday:** rebuilds the data when Overture has a new release.
- **On a push to `main` that changes the website:** republishes it, copying over the data that's already live.
- **When a release is published:** republishes so the site serves the new APK.
- **From Actions → Publish site → Run workflow:** tick "force" to rebuild the data too.

If any live data file fails to copy, the run stops before publishing, so a publish never drops data.

One-time setup: in the repository, go to Settings → Pages → Build and deployment and set Source to **GitHub Actions**.

To work on the website locally, run `npm run site:preview`. After changing the phone illustration in `site/index.html`, run `npm run site:og`. It needs Playwright's Chromium (`npx playwright install chromium`), or `CHROME_PATH` pointing at an installed Chrome.

## Fuel and food data

The app bundles about 55,000 fuel stations and 138,000 places to eat in India, taken from the [Overture Maps](https://overturemaps.org) places theme. They're stored in 1° tiles under `public/assets/poi/`.

```bash
python3 -m pip install duckdb==1.5.6
npm run data:poi                                   # India; about 10 minutes
python3 scripts/build-poi-tiles.py --country IN --country NP   # add countries
```

- **Selection:** places must lie inside Overture's boundary for the chosen countries, including territorial waters. Low-confidence and closed places are dropped.
- **Safety check:** the script refuses to replace the data if a kind loses more than 20% of its places (`--allow-drop` overrides). Such a drop is more likely a broken scan than real closures.
- **Other options:** `--release`, `--out` and `--previous`. The Pages workflow uses them to publish data updates without touching the bundled copy.
- **Sources and licences** (CDLA Permissive 2.0, CC0 and Apache 2.0, by provider): [`public/assets/poi/README.md`](public/assets/poi/README.md).

## Testing

- **Unit tests:** `npm test`. They cover routing, geometry, off-route detection, the Overpass client, stop suggestions, data and app updates, voice prompts and more. Tests sit next to the code as `*.test.ts`.
- **Live tests:** `LIVE_OSM=1 npm test` also runs `src/routing/e2e-goregaon.scratch.test.ts`. It plans a real route on live servers and can take many minutes.
- **Before a release:** run `npm run lint`, `npm run build` and `npm test`.
- **On a phone, check:**
  - GPS lock and accuracy.
  - Voice prompts through a headset.
  - The screen staying on while navigating.
  - The back button closing sheets.
  - Fuel and food suggestions in airplane mode.
  - An in-app update from the previous version.

## External services

| Service | Used for | Notes |
|---|---|---|
| [OpenFreeMap](https://openfreemap.org) | Map tiles | Online only; no API key |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Road data, live fuel and food top-up | Public servers that are often busy. The client also tries `lz4.` and `z.overpass-api.de` and skips servers that just failed |
| [Nominatim](https://nominatim.org) | Place search; fuel and food lookups in small areas | At most 1 request per second; on Android the app sends an identifying User-Agent |
| [Overture Maps](https://overturemaps.org) | Fuel and food data, at build time | Public S3 bucket, read with DuckDB |
| GitHub Pages | Website, data updates, APK copy | Served through a CDN |
| GitHub Releases and API | APKs, update-check fallback | The unauthenticated API allows 60 requests an hour per IP |

## Known issues and gotchas

- **Adding an npm package needs `--legacy-peer-deps`.** `@jansoft/mbujkanji-valhalla-wasm` depends on `@vitest/browser-*@latest`, which conflicts with the project's Vitest. A plain `npm install` from the lockfile only warns.
- **The map isn't offline.** Map tiles come from OpenFreeMap over the network. The offline map package plumbing (`src/offline/`) is a stub.
- **Overpass can be down.** When every public Overpass server is busy, planning a long trip fails. Areas that did load are kept, so trying again later carries on.
- **Swiping the app away ends background planning.** The planning runs in the web view, which closes with the app, so the service stops too (`android:stopWithTask`). Areas already downloaded stay cached.
- **Placeholder app ID and debug builds** (see [Android builds](#android-builds) and [Releasing](#releasing-a-new-version)).
- **More open issues**, with links to the code: [Project Guide §19](docs/PROJECT_GUIDE.md#19-known-issues-and-gaps).

## Safety, licensing and contributing

**Safety.** TrailCompass is not a certified navigation or safety system, and the app and website both say so. Don't add features that encourage using the phone while riding.

**Map data and attribution.** OpenStreetMap data is under the ODbL. Show attribution for every source: OpenStreetMap contributors, OpenFreeMap, the Overture Maps Foundation and its providers. Don't bulk-download tiles from the public OpenStreetMap tile servers: their policy forbids it. For any new data source, check that its licence allows bundling and redistribution, and record it next to the data.

**Contributing.** Before proposing a change:

1. Describe the behaviour or bug.
2. Run `npm run lint`, `npm run build` and `npm test`, and test on Android where it matters.
3. Include steps to reproduce device-specific issues.
4. Document any new native plugin, permission, data source or licence requirement.

**Licence.** No licence has been chosen yet, so all rights are reserved by default. Add a `LICENSE` file before accepting outside contributions or calling the project open source.
