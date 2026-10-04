import type { PublicConfig } from '@/lib/config/publicConfig';
import type { EngineKind, IMapEngine } from './IMapEngine';

/** Engines the current configuration can offer (govmap needs a token or mock mode). */
export function availableEngines(config: PublicConfig): EngineKind[] {
  return config.govmap.mode === 'disabled' ? ['leaflet'] : ['leaflet', 'govmap'];
}

/**
 * Engines are code-split: Leaflet touches `window` at import time and govmap pulls
 * in its loader, so each is imported only in the browser and only when chosen.
 */
export async function createMapEngine(kind: EngineKind, config: PublicConfig): Promise<IMapEngine> {
  if (kind === 'govmap') {
    const { GovmapEngine } = await import('@/lib/govmap/GovmapEngine');
    return new GovmapEngine(config);
  }
  const { LeafletEngine } = await import('@/lib/leaflet/LeafletEngine');
  return new LeafletEngine(config);
}
