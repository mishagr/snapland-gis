import type { ApiClient } from '@/lib/api/ApiClient';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';
import type { BBox } from '@/lib/geo/types';
import type { MapStateStore } from './MapStateStore';

export interface AreaSyncOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Fetch this much extra around the viewport so small pans need no request. */
  padRatio?: number;
  /** Re-fetch even an already-covered viewport after this long. */
  maxAgeMs?: number;
}

/**
 * Keeps the store's areas in sync with the server for the current viewport:
 * debounced, padded fetches (aborting stale ones), skipped when the last fetch
 * already covers the view, plus a polling mode used while the WebSocket is down.
 */
export class AreaSync {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | null = null;
  private last: { bbox: BBox; bucket: number; at: number } | null = null;
  private target: { bbox: BBox; resolution: number } | null = null;
  private readonly opts: Required<AreaSyncOptions>;

  constructor(
    private readonly api: ApiClient,
    private readonly store: MapStateStore,
    options: AreaSyncOptions = {},
  ) {
    this.opts = { debounceMs: 250, pollMs: 15_000, padRatio: 0.25, maxAgeMs: 120_000, ...options };
  }

  request(bbox: BBox, resolution: number): void {
    this.target = { bbox, resolution };
    const bucket = Math.round(Math.log2(Math.max(resolution, 0.01)));
    const fresh = this.last && Date.now() - this.last.at < this.opts.maxAgeMs;
    if (fresh && this.last!.bucket === bucket && BBoxUtil.contains(this.last!.bbox, bbox)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fetch(), this.opts.debounceMs);
  }

  /** Forces a refetch of the current viewport (reconnect, resync, conflict). */
  refresh(): Promise<void> {
    clearTimeout(this.timer);
    return this.fetch();
  }

  startPolling(): void {
    if (this.pollTimer) return;
    this.store.update({ polling: true });
    this.pollTimer = setInterval(() => void this.fetch(), this.opts.pollMs);
    void this.fetch();
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.store.update({ polling: false });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.stopPolling();
    this.controller?.abort();
  }

  private async fetch(): Promise<void> {
    if (!this.target) return;
    const { bbox, resolution } = this.target;
    const padded = BBoxUtil.pad(bbox, this.opts.padRatio);
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.api.listAreas(padded, resolution, controller.signal);
      if (controller.signal.aborted) return;
      this.last = { bbox: padded, bucket: Math.round(Math.log2(Math.max(resolution, 0.01))), at: Date.now() };
      this.store.mergeViewport(padded, result.areas, result.truncated, BBoxUtil.pad(bbox, 1));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.store.notify('error', `Could not load areas: ${(err as Error).message}`);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
