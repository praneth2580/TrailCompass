import type { SavedRoute } from '../types/route';
import { appDatabase } from './database';

const INDEX_KEY = 'route-index';

export class RouteRepository {
  async listRoutes(): Promise<SavedRoute[]> {
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    const routes: SavedRoute[] = [];
    for (const id of ids) {
      const route = await appDatabase.getJson<SavedRoute>(`route:${id}`);
      if (route) routes.push(route);
    }
    return routes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRoute(id: string): Promise<SavedRoute | null> {
    return appDatabase.getJson<SavedRoute>(`route:${id}`);
  }

  async saveRoute(route: SavedRoute): Promise<SavedRoute> {
    const next: SavedRoute = {
      ...route,
      updatedAt: new Date().toISOString(),
    };
    await appDatabase.setJson(`route:${next.id}`, next);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    if (!ids.includes(next.id)) {
      ids.push(next.id);
      await appDatabase.setJson(INDEX_KEY, ids);
    }
    return next;
  }

  async deleteRoute(id: string): Promise<void> {
    await appDatabase.remove(`route:${id}`);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    await appDatabase.setJson(
      INDEX_KEY,
      ids.filter((x) => x !== id),
    );
  }
}

export const routeRepository = new RouteRepository();
