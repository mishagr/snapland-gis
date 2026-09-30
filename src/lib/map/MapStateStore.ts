import type { AreaDto } from '@/lib/api/types';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';
import type { BBox, LngLat } from '@/lib/geo/types';
import type { ConnectionStatus } from '@/lib/realtime/RealtimeClient';
import type { PresenceUser } from '@/lib/realtime/protocol';
import type { BaseLayerCategory, BaseLayerInfo, EngineKind, MapView, RenderableSketch, SketchProgress } from './IMapEngine';

export type Mode =
  | { kind: 'idle' }
  | { kind: 'drawing' }
  /** Drawing finished; waiting for name/description before saving. */
  | { kind: 'naming'; ring: LngLat[]; areaSqKm: number }
  | { kind: 'editing'; areaId: string; candidate: (SketchProgress & { ring: LngLat[]; valid: boolean }) | null };

export interface ConflictState {
  areaId: string;
  message: string;
  theirs: AreaDto;
  /** The patch that was rejected, re-sendable against the new version. */
  mine: { name?: string; description?: string; geometry?: AreaDto['geometry'] };
}

export interface MapState {
  engine: EngineKind;
  baseLayers: BaseLayerInfo[];
  baseLayerId: string | null;
  baseLayerCategory: BaseLayerCategory;
  view: MapView;
  viewportBBox: BBox | null;
  areas: ReadonlyMap<string, AreaDto>;
  truncated: boolean;
  selectedId: string | null;
  presence: ReadonlyMap<string, PresenceUser>;
  remoteSketches: ReadonlyMap<string, RenderableSketch>;
  ownSketch: SketchProgress | null;
  mode: Mode;
  connection: ConnectionStatus;
  /** Polling fallback active because the socket is down. */
  polling: boolean;
  conflict: ConflictState | null;
  busy: boolean;
  notice: { kind: 'error' | 'info'; text: string; at: number } | null;
}

type Listener = () => void;

/**
 * Single source of truth for the workspace, framework-agnostic. React subscribes
 * through `useSyncExternalStore`; map engines are re-rendered from it, which is
 * what keeps drawings in place across engine and base-layer switches.
 *
 * State is immutable: every update produces a new snapshot object.
 */
export class MapStateStore {
  private state: MapState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: Pick<MapState, 'engine' | 'view'> & Partial<MapState>) {
    this.state = {
      baseLayers: [],
      baseLayerId: null,
      baseLayerCategory: 'street',
      viewportBBox: null,
      areas: new Map(),
      truncated: false,
      selectedId: null,
      presence: new Map(),
      remoteSketches: new Map(),
      ownSketch: null,
      mode: { kind: 'idle' },
      connection: 'offline',
      polling: false,
      conflict: null,
      busy: false,
      notice: null,
      ...initial,
    };
  }

  getState = (): MapState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<MapState> | ((s: MapState) => Partial<MapState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  notify(kind: 'error' | 'info', text: string): void {
    this.update({ notice: { kind, text, at: Date.now() } });
  }

  /** Upsert, ignoring anything older than what we already hold (out-of-order events). */
  upsertArea(area: AreaDto): void {
    const current = this.state.areas.get(area.id);
    if (current && current.version > area.version) return;
    if (current && current.version === area.version && current.simplified === false && area.simplified) return;
    const areas = new Map(this.state.areas);
    if (area.deletedAt) areas.delete(area.id);
    else areas.set(area.id, area);
    const selectedId = area.deletedAt && this.state.selectedId === area.id ? null : this.state.selectedId;
    this.update({ areas, selectedId });
  }

  removeArea(id: string): void {
    if (!this.state.areas.has(id)) return;
    const areas = new Map(this.state.areas);
    areas.delete(id);
    this.update({ areas, selectedId: this.state.selectedId === id ? null : this.state.selectedId });
  }

  /**
   * Merges a viewport query result. Areas we hold inside the queried bbox that the
   * server did not return were deleted meanwhile (only safe when not truncated).
   * Areas far outside the viewport are dropped to bound memory.
   */
  mergeViewport(queried: BBox, result: AreaDto[], truncated: boolean, keep: BBox): void {
    const areas = new Map<string, AreaDto>();
    const returned = new Set(result.map((a) => a.id));
    for (const [id, a] of this.state.areas) {
      const bbox = BBoxUtil.fromPositions(a.geometry.coordinates[0]);
      const insideQuery = BBoxUtil.intersects(bbox, queried);
      const keepIt = id === this.state.selectedId || BBoxUtil.intersects(bbox, keep);
      if (insideQuery && !truncated && !returned.has(id) && id !== this.editingId()) continue;
      if (keepIt) areas.set(id, a);
    }
    for (const a of result) {
      const current = areas.get(a.id);
      if (current && (current.version > a.version || (current.version === a.version && !current.simplified))) continue;
      areas.set(a.id, a);
    }
    this.update({ areas, truncated });
  }

  setPresence(users: PresenceUser[]): void {
    this.update({ presence: new Map(users.map((u) => [u.userId, u])) });
  }

  upsertPresence(user: PresenceUser, left = false): void {
    const presence = new Map(this.state.presence);
    const remoteSketches = new Map(this.state.remoteSketches);
    if (left) {
      presence.delete(user.userId);
      remoteSketches.delete(user.userId);
    } else {
      presence.set(user.userId, user);
    }
    this.update({ presence, remoteSketches });
  }

  setRemoteSketch(sketch: RenderableSketch | null, userId: string): void {
    const remoteSketches = new Map(this.state.remoteSketches);
    if (sketch) remoteSketches.set(userId, sketch);
    else remoteSketches.delete(userId);
    this.update({ remoteSketches });
  }

  editingId(): string | null {
    return this.state.mode.kind === 'editing' ? this.state.mode.areaId : null;
  }
}
