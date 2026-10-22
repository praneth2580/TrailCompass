/**
 * Local tile / PMTiles protocol bridge for MapLibre GL JS.
 *
 * IMPORTANT: MapLibre in a WebView does not automatically serve filesystem
 * PMTiles. This module defines the registration contract; the Android-local
 * range-request bridge is Milestone 3 work and is not active yet.
 */

export type TileProtocolHandler = (
  params: { url: string },
  abortController?: AbortController,
) => Promise<{ data: ArrayBuffer | Uint8Array }>;

export interface TileProtocolRegistration {
  /** Protocol scheme without trailing colon, e.g. "pmtiles". */
  scheme: string;
  registered: boolean;
  message: string;
}

const PROTOCOL_SCHEME = 'pmtiles';

let registered = false;

/**
 * Registers a custom protocol with MapLibre when a real handler is provided.
 * Until the native bridge exists, this only records intent.
 */
export function registerTileProtocol(
  addProtocol?: (scheme: string, handler: TileProtocolHandler) => void,
  handler?: TileProtocolHandler,
): TileProtocolRegistration {
  if (!addProtocol || !handler) {
    return {
      scheme: PROTOCOL_SCHEME,
      registered: false,
      message:
        'Offline tile protocol not registered — local PMTiles bridge pending. ' +
        'The on-screen map is an online style and needs a network connection.',
    };
  }

  addProtocol(PROTOCOL_SCHEME, handler);
  registered = true;
  return {
    scheme: PROTOCOL_SCHEME,
    registered: true,
    message: `Protocol "${PROTOCOL_SCHEME}://" registered`,
  };
}

export function isTileProtocolRegistered(): boolean {
  return registered;
}

export function buildPmtilesStyleUrl(localPackageUri: string): string {
  return `${PROTOCOL_SCHEME}://${localPackageUri}`;
}
