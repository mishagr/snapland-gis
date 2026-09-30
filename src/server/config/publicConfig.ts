import type { PublicConfig } from '@/lib/config/publicConfig';
import { GOVMAP_LEVEL_RESOLUTIONS, GOVMAP_TILE_ORIGIN } from '@/lib/govmap/constants';

function numberList(value: string | undefined): number[] | null {
  if (!value) return null;
  const nums = value.split(',').map((v) => Number(v.trim()));
  return nums.length > 0 && nums.every((n) => Number.isFinite(n) && n > 0) ? nums : null;
}

function pair(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const nums = value.split(',').map((v) => Number(v.trim()));
  return nums.length === 2 && nums.every(Number.isFinite) ? [nums[0]!, nums[1]!] : null;
}

/** Builds the browser config from the environment (see .env.example). */
export function getPublicConfig(): PublicConfig {
  const env = process.env;
  const token = env.GOVMAP_TOKEN ?? '';
  const requestedMode = env.GOVMAP_MODE as PublicConfig['govmap']['mode'] | undefined;
  const mode = requestedMode === 'mock' || requestedMode === 'disabled' ? requestedMode : token ? 'live' : 'disabled';
  const defaultEngine = env.MAP_DEFAULT_ENGINE === 'govmap' && mode !== 'disabled' ? 'govmap' : 'leaflet';
  const center = pair(env.MAP_DEFAULT_CENTER) ?? [34.7818, 32.0853];
  const orthoUrl = env.GOVMAP_ORTHO_TILE_URL?.trim();
  return {
    defaultEngine,
    defaultCenter: center,
    defaultResolution: Number(env.MAP_DEFAULT_RESOLUTION) > 0 ? Number(env.MAP_DEFAULT_RESOLUTION) : 20,
    govmap: {
      mode,
      token,
      scriptUrl: env.GOVMAP_SCRIPT_URL || 'https://www.govmap.gov.il/govmap/api/govmap.api.js',
    },
    govmapOrtho: orthoUrl
      ? {
          urlTemplate: orthoUrl,
          origin: pair(env.GOVMAP_ORTHO_ORIGIN) ?? GOVMAP_TILE_ORIGIN,
          resolutions: numberList(env.GOVMAP_ORTHO_RESOLUTIONS) ?? [...GOVMAP_LEVEL_RESOLUTIONS],
        }
      : null,
  };
}
