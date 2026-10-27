import { describe, expect, it, vi } from 'vitest';
import type { SavedRoute } from '../types/route';

/** In-memory stand-in for Preferences. */
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./database', () => ({
  appDatabase: {
    getJson: async (id: string) => (store.has(id) ? structuredClone(store.get(id)) : null),
    setJson: async (id: string, data: unknown) => void store.set(id, structuredClone(data)),
    remove: async (id: string) => void store.delete(id),
  },
}));

const { RouteRepository } = await import('./route-repository');

function trip(id: string, updatedAt: string): SavedRoute {
  return {
    id,
    name: `Trip ${id}`,
    createdAt: updatedAt,
    updatedAt,
    start: [73.1, 19],
    end: [73.1, 18.7],
    waypoints: [],
    coordinates: [[73.1, 19], [73.1, 18.7]],
    distanceMeters: 38_000,
    durationSeconds: 3_100,
    instructions: [],
  };
}

describe('RouteRepository.restoreRoute', () => {
  it('puts a deleted trip back where it was, dates unchanged', async () => {
    const repo = new RouteRepository();
    for (const route of [trip('a', '2026-10-01T09:00:00Z'), trip('b', '2026-10-20T09:00:00Z'), trip('c', '2026-10-10T09:00:00Z')]) {
      await repo.restoreRoute(route);
    }
    expect((await repo.listRoutes()).map((r) => r.id)).toEqual(['b', 'c', 'a']);

    const deleted = (await repo.getRoute('c'))!;
    await repo.deleteRoute('c');
    expect((await repo.listRoutes()).map((r) => r.id)).toEqual(['b', 'a']);

    await repo.restoreRoute(deleted);
    expect((await repo.listRoutes()).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect((await repo.getRoute('c'))?.updatedAt).toBe('2026-10-10T09:00:00Z');
  });
});
