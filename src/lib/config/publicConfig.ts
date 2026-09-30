import type { LngLat } from '@/lib/geo/types';
import type { EngineKind } from '@/lib/map/IMapEngine';

/**
 * Browser-visible configuration. Read from the server environment at request time
 * (not inlined at build time) so one Docker image serves any deployment.
 * Nothing here is secret: a govmap token is bound to its domain and public by design.
 */
export interface PublicConfig {
  defaultEngine: EngineKind;
  defaultCenter: LngLat;
  /** Initial ground resolution, metres per pixel. */
  defaultResolution: number;
  govmap: {
    /** `live` loads the real govmap API, `mock` an in-browser fake (dev/tests), `disabled` hides the engine. */
    mode: 'live' | 'mock' | 'disabled';
    token: string;
    scriptUrl: string;
  };
  /** Expose `window.__snapland` (store + controller) for debugging and end-to-end tests. */
  debugHandle: boolean;
  /** govmap orthophoto tiles for the Leaflet engine (EPSG:2039 grid). Absent = layer hidden. */
  govmapOrtho: {
    urlTemplate: string;
    origin: [number, number];
    resolutions: number[];
  } | null;
}
