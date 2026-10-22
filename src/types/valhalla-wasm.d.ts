declare module '@jansoft/mbujkanji-valhalla-wasm' {
  export interface ValhallaRouter {
    init: () => Promise<void>;
    loadTiles: (buffer: ArrayBuffer) => Promise<void>;
    loadTilesFromUrl?: (url: string) => Promise<void>;
    route: (request: Record<string, unknown>) => Promise<{
      trip?: {
        legs?: Array<{
          shape?: string;
          summary?: { length?: number; time?: number };
          maneuvers?: Array<{
            instruction?: string;
            length?: number;
            type?: number;
          }>;
        }>;
        summary?: { length?: number; time?: number };
      };
    }>;
    dispose?: () => void;
  }

  export function createRouter(): ValhallaRouter;
}
