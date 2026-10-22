/**
 * Lightweight route table for the app shell.
 * Full client-side routing can replace this later if screens multiply.
 */
export type AppScreen = 'map' | 'downloads';

export interface AppRoute {
  id: AppScreen;
  label: string;
  path: string;
}

export const APP_ROUTES: AppRoute[] = [
  { id: 'map', label: 'Map', path: '/' },
  { id: 'downloads', label: 'Library', path: '/downloads' },
];

export function resolveScreen(path: string): AppScreen {
  if (path.includes('download')) return 'downloads';
  return 'map';
}
