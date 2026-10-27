import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import {
  parseRouteFile,
  serializeRouteFile,
  suggestedFileName,
  toGeoJson,
} from '../routing/route-file';
import {
  calculatedToSavedRoute,
  type SavedRoute,
} from '../types/route';
import { routeRepository } from '../database/route-repository';

const EXPORT_DIR = 'shared-routes';

export type RouteExportKind = 'trailcompass' | 'geojson';

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
    },
  ): Promise<SavedRoute> {
    const saved = calculatedToSavedRoute(route, name.trim() || 'Saved route', extras);
    return routeRepository.saveRoute(saved);
  }

  async saveImported(route: SavedRoute): Promise<SavedRoute> {
    // New id if colliding with an existing route of different content.
    const existing = await routeRepository.getRoute(route.id);
    if (existing) {
      route = { ...route, id: crypto.randomUUID() };
    }
    return routeRepository.saveRoute(route);
  }

  delete(id: string): Promise<void> {
    return routeRepository.deleteRoute(id);
  }

  /** Resolves false when the rider dismisses the share sheet. */
  async exportAndShare(
    route: SavedRoute,
    kind: RouteExportKind = 'trailcompass',
  ): Promise<boolean> {
    const body =
      kind === 'geojson' ? toGeoJson(route) : serializeRouteFile(route);
    const fileName =
      kind === 'geojson'
        ? suggestedFileName(route).replace(/\.trailcompass\.json$/, '.geojson')
        : suggestedFileName(route);

    if (!Capacitor.isNativePlatform()) {
      downloadTextFile(fileName, body);
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

    try {
      await Share.share({
        title: route.name,
        text: `TrailCompass route · ${formatKm(route.distanceMeters)}`,
        files: [uri],
        dialogTitle: 'Share route',
      });
      return true;
    } catch (e) {
      if (isShareCancelled(e)) return false;
    }

    // Fallback for platforms that only accept url.
    try {
      await Share.share({
        title: route.name,
        text: `TrailCompass route · ${formatKm(route.distanceMeters)}`,
        url: uri,
        dialogTitle: 'Share route',
      });
      return true;
    } catch (e) {
      if (isShareCancelled(e)) return false;
      throw e;
    }
  }

  async importFromText(raw: string): Promise<SavedRoute> {
    const parsed = parseRouteFile(raw);
    return this.saveImported(parsed);
  }

  async importFromFile(file: File): Promise<SavedRoute> {
    const raw = await file.text();
    return this.importFromText(raw);
  }
}

function downloadTextFile(fileName: string, body: string): void {
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The Share plugin rejects with "Share canceled" when the sheet is dismissed. */
function isShareCancelled(e: unknown): boolean {
  return e instanceof Error && /cancel/i.test(e.message);
}

function formatKm(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

export const routeLibrary = new RouteLibraryService();
