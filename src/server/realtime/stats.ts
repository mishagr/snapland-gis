export interface RealtimeStats {
  connections: number;
  users: number;
  messagesIn: number;
  messagesOut: number;
  droppedForBackpressure: number;
  rejectedUpgrades: number;
}

const globalForStats = globalThis as unknown as { __snaplandRealtimeStats?: () => RealtimeStats };

/** The gateway registers a provider; health checks read it without importing `ws`. */
export function registerRealtimeStats(provider: () => RealtimeStats): void {
  globalForStats.__snaplandRealtimeStats = provider;
}

export function readRealtimeStats(): RealtimeStats | null {
  return globalForStats.__snaplandRealtimeStats?.() ?? null;
}
