import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import {
  parseRouteFile,
  serializeRouteFile,
  suggestedFileName,
  toGeoJson,
} from '../routing/route-file';
import {
  calculatedToSavedRoute,
  type SavedPlaces,
  type SavedRoute,
} from '../types/route';
import { routeRepository } from '../database/route-repository';
import {
  isMapFile,
  mapPackService,
  routePackId,
  type MapImportResult,
} from './map-pack.service';
import { downloadBlob, shareFile, type ShareText } from './share-file';

const EXPORT_DIR = 'shared-routes';

export type RouteExportKind = 'trailcompass' | 'geojson';

/** An imported trip was new here, newer than the copy here, or not newer (kept as it was). */
export type RouteImportStatus = 'added' | 'updated' | 'kept';

export interface ImportOutcome {
  /** The file's trip as Library now has it; absent for an area's map. */
  route?: SavedRoute;
  routeStatus?: RouteImportStatus;
  /** The file's map, merged into the phone's offline maps. */
  map?: MapImportResult;
}

export class RouteLibraryService {
  list(): Promise<SavedRoute[]> {
    return routeRepository.listRoutes();
  }

  get(id: string): Promise<SavedRoute | null> {
    return routeRepository.getRoute(id);
  }

  async saveFromCalculated(
    route: CalculatedRoute,
    name: string,
    extras?: {
      start?: Coordinate;
      end?: Coordinate;
      waypoints?: Coordinate[];
      places?: SavedPlaces;
    },
  ): Promise<SavedRoute> {
    const saved = calculatedToSavedRoute(route, name.trim() || 'Saved route', extras);
    return routeRepository.saveRoute(saved);
  }

  /**
   * A trip from a file is the same trip as one here with its id: the copy
   * changed last is kept, with its own dates, so nothing is saved twice.
   */
  async saveImported(route: SavedRoute): Promise<{ route: SavedRoute; status: RouteImportStatus }> {
    const existing = await routeRepository.getRoute(route.id);
    if (existing && Date.parse(existing.updatedAt) >= Date.parse(route.updatedAt)) {
      return { route: existing, status: 'kept' };
    }
    await routeRepository.restoreRoute(route);
    return { route, status: existing ? 'updated' : 'added' };
  }

  delete(id: string): Promise<void> {
    return routeRepository.deleteRoute(id);
  }

  /** Undo a delete: the route returns with its original dates. */
  restore(route: SavedRoute): Promise<void> {
    return routeRepository.restoreRoute(route);
  }

  /**
   * Resolves false when the rider dismisses the share sheet. With
   * `withMap` and an offline map saved for the route, shares the map with
   * the route inside it (`.trailcompass.pmtiles`) instead of the JSON file.
   */
  async exportAndShare(
    route: SavedRoute,
    kind: RouteExportKind = 'trailcompass',
    options: { withMap?: boolean } = {},
  ): Promise<boolean> {
    const mapFile =
      options.withMap && kind === 'trailcompass'
        ? await mapPackService.buildShareFile(routePackId(route.id), route)
        : null;
    if (mapFile) {
      return shareFile(mapFile.file, mapFile.fileName, routeShareText(route, 'with offline map'));
    }

    const body =
      kind === 'geojson' ? toGeoJson(route) : serializeRouteFile(route);
    const fileName =
      kind === 'geojson'
        ? suggestedFileName(route).replace(/\.trailcompass\.json$/, '.geojson')
        : suggestedFileName(route);

    if (!Capacitor.isNativePlatform()) {
      downloadBlob(fileName, new Blob([body], { type: 'application/json' }));
      return true;
    }

    await Filesystem.mkdir({
      path: EXPORT_DIR,
      directory: Directory.Cache,
      recursive: true,
    }).catch(() => undefined);

    const path = `${EXPORT_DIR}/${fileName}`;
    await Filesystem.writeFile({
      path,
      data: body,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });

    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.Cache,
    });
    return shareFile({ uri }, fileName, routeShareText(route));
  }

  /**
   * A route file, or a shared map file: a trip's map with the trip inside,
   * or an area's map. Its trip and map join what's here, newest copy
   * winning.
   */
  async importFromFile(
    file: File,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ImportOutcome> {
    if (!(await isMapFile(file))) {
      const { route, status } = await this.saveImported(parseRouteFile(await file.text()));
      return { route, routeStatus: status };
    }
    const shared = await mapPackService.openSharedFile(file);
    const trip = shared.route ? await this.saveImported(shared.route) : null;
    try {
      const map = await mapPackService.importSharedFile(shared, onProgress);
      return { route: trip?.route, routeStatus: trip?.status, map };
    } catch (e) {
      // A trip the file brought stays only with its map.
      if (trip?.status === 'added') await this.delete(trip.route.id);
      throw e;
    }
  }
}

/** What to tell the rider after an import. */
export function importSummary({ route, routeStatus, map }: ImportOutcome): string {
  if (!route) {
    const name = map?.pack.name ?? 'offline';
    if (map && map.added === 0 && !map.replaced) return `The “${name}” map was already up to date here`;
    if (map && map.skipped > 0) {
      return `Updated the “${name}” map · ${map.added} tiles added, ${map.skipped} already here`;
    }
    return `Saved the “${name}” map`;
  }
  const lead =
    routeStatus === 'kept'
      ? `“${route.name}” was already in Library`
      : routeStatus === 'updated'
        ? `Updated “${route.name}” to the newer copy`
        : `Imported “${route.name}”`;
  if (!map) return lead;
  if (map.added === 0) return `${lead} · its map was already on this phone`;
  if (map.skipped === 0) return `${lead} with its offline map`;
  return `${lead} · ${map.added} map tiles added, ${map.skipped} already here`;
}

function routeShareText(route: SavedRoute, extra?: string): ShareText {
  return {
    title: route.name,
    text: [`TrailCompass route · ${formatKm(route.distanceMeters)}`, extra].filter(Boolean).join(' · '),
    dialogTitle: 'Share route',
  };
}

function formatKm(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

export const routeLibrary = new RouteLibraryService();
