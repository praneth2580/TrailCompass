/**
 * Lightweight route table for the app shell.
 * Full client-side routing can replace this later if screens multiply.
 */
export type AppScreen = 'map' | 'plan' | 'library' | 'downloads';

export interface AppRoute {
  id: AppScreen;
  label: string;
  path: string;
}

export const APP_ROUTES: AppRoute[] = [
  { id: 'map', label: 'Map', path: '/' },
  { id: 'plan', label: 'Plan', path: '/plan' },
  { id: 'library', label: 'Library', path: '/library' },
  { id: 'downloads', label: 'Offline', path: '/downloads' },
];

export function resolveScreen(path: string): AppScreen {
  if (path.includes('plan')) return 'plan';
  if (path.includes('library')) return 'library';
  if (path.includes('download')) return 'downloads';
  return 'map';
}
