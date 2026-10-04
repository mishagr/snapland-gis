import { ApiClientError, type ApiClient } from '@/lib/api/ApiClient';
import type { AreaDto, ConflictDetails, UserDto } from '@/lib/api/types';
import type { PublicConfig } from '@/lib/config/publicConfig';
import { formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';
import type { LngLat, PolygonGeometry } from '@/lib/geo/types';
import { userColor } from '@/lib/realtime/colors';
import type { ServerMessage } from '@/lib/realtime/protocol';
import type { ConnectionStatus, RealtimeClient } from '@/lib/realtime/RealtimeClient';
import { AreaSync } from './AreaSync';
import type { EngineKind, IMapEngine, RenderableArea, RenderableSketch } from './IMapEngine';
import { createMapEngine } from './MapEngineFactory';
import type { MapStateStore } from './MapStateStore';

export interface WorkspaceDeps {
  api: ApiClient;
  realtime: RealtimeClient;
  store: MapStateStore;
  config: PublicConfig;
  user: UserDto;
  /** Injected for tests. */
  createEngine?: (kind: EngineKind, config: PublicConfig) => Promise<IMapEngine>;
  /** How long the socket may be down before polling kicks in. */
  offlineGraceMs?: number;
  /** Called when the server says the session is gone (navigate to sign-in). */
  onSessionExpired: () => void;
}

const validator = new PolygonValidator();

export type WriteResult = 'saved' | 'conflict' | 'failed';

/**
 * Orchestrates the workspace: owns the active map engine and wires it to the
 * store, the REST API and the WebSocket. React components only read the store
 * and call methods here; engines only receive render calls. This is what makes
 * engines swappable at runtime without losing state.
 */
export class WorkspaceController {
  private engine: IMapEngine | null = null;
  private container: HTMLElement | null = null;
  private engineOffs: (() => void)[] = [];
  private readonly offs: (() => void)[] = [];
  private readonly sync: AreaSync;
  private frame = 0;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private renderCache: { areas: unknown; presence: unknown; selected: unknown; result: RenderableArea[] } | null = null;
  private renderedSketches: unknown = null;
  /** Most recently deleted area (offered as "Undo"). */
  lastDeleted: string | null = null;
  private switching = false;
  private disposed = false;
  /** Incremented per mount/dispose so a superseded async mount can tell it is stale. */
  private mountSeq = 0;

  constructor(private readonly deps: WorkspaceDeps) {
    this.sync = new AreaSync(deps.api, deps.store);
  }

  private get store(): MapStateStore {
    return this.deps.store;
  }

  /** Mounts into `container`. Can be called again after `dispose()` (React StrictMode remounts). */
  async start(container: HTMLElement): Promise<void> {
    this.disposed = false;
    this.container = container;
    this.offs.push(this.store.subscribe(() => this.scheduleRender()));
    this.offs.push(this.deps.realtime.on('message', (m) => this.onMessage(m)));
    this.offs.push(this.deps.realtime.on('status', (s) => this.onStatus(s)));
    this.offs.push(this.deps.realtime.on('reconnected', () => void this.sync.refresh()));
    this.deps.realtime.connect();
    await this.mountEngine(this.store.getState().engine);
  }

  dispose(): void {
    this.disposed = true;
    this.mountSeq++;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.offlineTimer);
    for (const off of [...this.offs, ...this.engineOffs]) off();
    this.offs.length = 0;
    this.engineOffs = [];
    this.renderCache = null;
    this.renderedSketches = null;
    this.engine?.destroy();
    this.engine = null;
    this.sync.dispose();
    this.deps.realtime.disconnect();
  }

  // ---------------------------------------------------------------- engine & layers

  async switchEngine(kind: EngineKind): Promise<void> {
    const state = this.store.getState();
    if (kind === state.engine || this.switching) return;
    if (state.mode.kind !== 'idle') {
      this.store.notify('error', 'Finish or cancel the current drawing before switching maps');
      return;
    }
    const view = this.engine?.getView() ?? state.view;
    this.store.update({ view, engine: kind });
    await this.mountEngine(kind);
  }

  async setBaseLayer(id: string): Promise<void> {
    if (!this.engine || this.switching) return;
    this.switching = true;
    this.store.update({ busy: true });
    try {
      await this.engine.setBaseLayer(id);
      const info = this.engine.listBaseLayers().find((l) => l.id === id);
      this.store.update({ baseLayerId: id, baseLayerCategory: info?.category ?? 'street' });
    } catch (err) {
      this.store.notify('error', (err as Error).message);
    } finally {
      this.switching = false;
      this.store.update({ busy: false });
    }
  }

  // ---------------------------------------------------------------- drawing

  startDrawing(): void {
    if (!this.engine || this.store.getState().mode.kind !== 'idle') return;
    this.selectArea(null);
    this.engine.startDrawing();
    this.store.update({ mode: { kind: 'drawing' }, ownSketch: { points: [], vertexCount: 0, areaSqKm: 0, perimeterM: 0 } });
  }

  finishDrawing(): void {
    this.engine?.finishDrawing();
  }

  undoVertex(): void {
    this.engine?.undoLastVertex();
  }

  cancelDrawing(): void {
    this.engine?.cancelDrawing();
  }

  async saveNewArea(name: string, description: string): Promise<boolean> {
    const mode = this.store.getState().mode;
    if (mode.kind !== 'naming') return false;
    const geometry: PolygonGeometry = { type: 'Polygon', coordinates: [mode.ring] };
    this.store.update({ busy: true });
    try {
      const { area } = await this.deps.api.createArea({ name, description, geometry });
      this.store.upsertArea(area);
      this.store.update({ mode: { kind: 'idle' }, selectedId: area.id });
      this.store.notify('info', `Saved “${area.name}” (${formatArea(area.areaSqKm)})`);
      return true;
    } catch (err) {
      this.reportError(err, 'Could not save the area');
      return false;
    } finally {
      this.store.update({ busy: false });
    }
  }

  discardNewArea(): void {
    if (this.store.getState().mode.kind === 'naming') this.store.update({ mode: { kind: 'idle' } });
  }

  // ---------------------------------------------------------------- selection & editing

  selectArea(id: string | null): void {
    this.store.update({ selectedId: id });
    const area = id ? this.store.getState().areas.get(id) : undefined;
    // List queries may return simplified geometry; selection shows full detail.
    if (area?.simplified) void this.loadFullArea(area.id);
  }

  async startShapeEdit(): Promise<void> {
    const { selectedId, mode } = this.store.getState();
    if (!this.engine || !selectedId || mode.kind !== 'idle') return;
    let area = this.store.getState().areas.get(selectedId);
    if (!area) return;
    if (area.simplified) area = (await this.loadFullArea(area.id)) ?? area;
    this.deps.realtime.setEditing(area.id);
    this.store.update({ mode: { kind: 'editing', areaId: area.id, baseVersion: area.version, candidate: null } });
    this.engine.startEditing(this.toRenderable(area, true, null));
  }

  async saveShapeEdit(): Promise<void> {
    const mode = this.store.getState().mode;
    if (!this.engine || mode.kind !== 'editing') return;
    const ring = this.engine.stopEditing(true);
    const area = this.store.getState().areas.get(mode.areaId);
    this.finishEditMode();
    if (!ring || !area) return;
    const check = validator.validate({ type: 'Polygon', coordinates: [ring] });
    if (!check.ok) {
      this.store.notify('error', check.issues[0]!.message);
      return;
    }
    await this.patch(area, { geometry: check.polygon }, mode.baseVersion);
  }

  cancelShapeEdit(): void {
    if (this.store.getState().mode.kind !== 'editing') return;
    this.engine?.stopEditing(false);
    this.finishEditMode();
  }

  /**
   * @param baseVersion the version the user was looking at when they started editing;
   *   if someone saved in between, the server answers 409 and the conflict dialog opens.
   */
  async updateDetails(id: string, details: { name: string; description: string }, baseVersion: number): Promise<WriteResult> {
    const area = this.store.getState().areas.get(id);
    if (!area) return 'failed';
    const changes: { name?: string; description?: string } = {};
    if (details.name !== area.name) changes.name = details.name;
    if (details.description !== area.description) changes.description = details.description;
    if (Object.keys(changes).length === 0) return 'saved';
    return this.patch(area, changes, baseVersion);
  }

  async deleteArea(id: string): Promise<void> {
    const area = this.store.getState().areas.get(id);
    if (!area) return;
    this.store.update({ busy: true });
    try {
      await this.deps.api.deleteArea(id, area.version);
      this.store.removeArea(id);
      this.store.notify('info', `Deleted “${area.name}”. It can be restored for a limited time.`);
      this.lastDeleted = area.id;
    } catch (err) {
      this.handleWriteError(err, area, {});
    } finally {
      this.store.update({ busy: false });
    }
  }

  async restoreLastDeleted(): Promise<void> {
    if (!this.lastDeleted) return;
    const id = this.lastDeleted;
    this.lastDeleted = null;
    try {
      const { area } = await this.deps.api.restoreArea(id);
      this.store.upsertArea(area);
      this.store.update({ selectedId: area.id });
    } catch (err) {
      this.reportError(err, 'Could not restore the area');
    }
  }

  /** Resolves a 409: keep theirs, or re-apply my change on top of their version. */
  async resolveConflict(choice: 'theirs' | 'mine'): Promise<void> {
    const conflict = this.store.getState().conflict;
    if (!conflict) return;
    this.store.update({ conflict: null });
    this.store.upsertArea(conflict.theirs);
    if (choice === 'mine') await this.patch(conflict.theirs, conflict.mine);
  }

  zoomToArea(id: string): void {
    const area = this.store.getState().areas.get(id);
    if (!area || !this.engine) return;
    const ring = area.geometry.coordinates[0];
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    this.engine.fitBounds({ minLng: Math.min(...lngs), minLat: Math.min(...lats), maxLng: Math.max(...lngs), maxLat: Math.max(...lats) });
  }

  // ---------------------------------------------------------------- internals

  private async mountEngine(kind: EngineKind): Promise<void> {
    if (!this.container) return;
    const seq = ++this.mountSeq;
    const stale = () => seq !== this.mountSeq || this.disposed;
    this.switching = true;
    this.store.update({ busy: true });
    for (const off of this.engineOffs) off();
    this.engineOffs = [];
    this.engine?.destroy();
    this.engine = null;
    this.renderCache = null;
    this.renderedSketches = null;
    const host = document.createElement('div');
    host.className = 'map-host';
    this.container.replaceChildren(host);
    let engine: IMapEngine | null = null;
    try {
      engine = await (this.deps.createEngine ?? createMapEngine)(kind, this.deps.config);
      if (stale()) return;
      this.engine = engine;
      this.wireEngine(engine);
      const state = this.store.getState();
      await engine.mount(host, { view: state.view, baseLayer: state.baseLayerCategory });
      if (stale()) return;
      this.store.update({ baseLayers: engine.listBaseLayers(), baseLayerId: engine.getBaseLayer() });
      this.render();
    } catch (err) {
      if (stale()) return;
      this.store.notify('error', `Could not load the ${kind} map: ${(err as Error).message}`);
      if (kind !== 'leaflet') {
        this.store.update({ engine: 'leaflet' });
        this.switching = false;
        await this.mountEngine('leaflet');
        return;
      }
    } finally {
      if (stale()) {
        // A newer mount (or dispose) superseded this one: release what we created.
        if (engine && engine !== this.engine) engine.destroy();
      } else {
        this.switching = false;
        this.store.update({ busy: false });
      }
    }
  }

  private wireEngine(engine: IMapEngine): void {
    this.engineOffs.push(
      engine.on('viewportChange', ({ bbox, view }) => {
        this.store.update({ view, viewportBBox: bbox });
        this.deps.realtime.setViewport(bbox);
        this.sync.request(bbox, view.resolution);
      }),
      engine.on('areaClick', (id) => {
        if (this.store.getState().mode.kind === 'idle') this.selectArea(id);
      }),
      engine.on('sketchChange', (s) => {
        this.store.update({ ownSketch: s });
        this.deps.realtime.sendSketch(s.points, s.areaSqKm);
      }),
      engine.on('drawComplete', (ring) => this.onDrawComplete(ring)),
      engine.on('drawCancel', () => {
        this.deps.realtime.endSketch();
        this.store.update({ mode: { kind: 'idle' }, ownSketch: null });
      }),
      engine.on('editChange', (candidate) => {
        const mode = this.store.getState().mode;
        if (mode.kind === 'editing') this.store.update({ mode: { ...mode, candidate } });
      }),
      engine.on('baseLayerChange', (id) => this.store.update({ baseLayerId: id })),
      engine.on('error', (err) => this.store.notify('error', err.message)),
    );
  }

  private onDrawComplete(ring: LngLat[]): void {
    this.deps.realtime.endSketch();
    const check = validator.validate({ type: 'Polygon', coordinates: [ring] });
    if (!check.ok) {
      this.store.notify('error', check.issues[0]!.message);
      this.store.update({ mode: { kind: 'idle' }, ownSketch: null });
      return;
    }
    this.store.update({ mode: { kind: 'naming', ring: check.polygon.coordinates[0], areaSqKm: check.areaSqKm }, ownSketch: null });
  }

  private finishEditMode(): void {
    this.deps.realtime.setEditing(null);
    this.store.update({ mode: { kind: 'idle' } });
  }

  private async loadFullArea(id: string): Promise<AreaDto | null> {
    try {
      const { area } = await this.deps.api.getArea(id);
      this.store.upsertArea(area);
      return area;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) this.store.removeArea(id);
      return null;
    }
  }

  private async patch(
    area: AreaDto,
    changes: { name?: string; description?: string; geometry?: PolygonGeometry },
    expectedVersion = area.version,
  ): Promise<WriteResult> {
    this.store.update({ busy: true });
    try {
      const { area: updated } = await this.deps.api.updateArea(area.id, { expectedVersion, ...changes });
      this.store.upsertArea(updated);
      return 'saved';
    } catch (err) {
      this.handleWriteError(err, area, changes);
      return this.store.getState().conflict ? 'conflict' : 'failed';
    } finally {
      this.store.update({ busy: false });
    }
  }

  private handleWriteError(err: unknown, area: AreaDto, mine: { name?: string; description?: string; geometry?: PolygonGeometry }): void {
    if (err instanceof ApiClientError && err.status === 409) {
      const theirs = (err.details as ConflictDetails | undefined)?.current;
      if (theirs) {
        this.store.update({ conflict: { areaId: area.id, message: err.message, theirs, mine } });
        return;
      }
    }
    if (err instanceof ApiClientError && err.status === 404) this.store.removeArea(area.id);
    this.reportError(err, 'Could not save your change');
  }

  private reportError(err: unknown, fallback: string): void {
    if (err instanceof ApiClientError) {
      if (err.status === 401) {
        this.deps.onSessionExpired();
        return;
      }
      this.store.notify('error', err.message || fallback);
    } else {
      this.store.notify('error', fallback);
    }
  }

  private onStatus(status: ConnectionStatus): void {
    this.store.update({ connection: status });
    if (status === 'open') {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = undefined;
      this.sync.stopPolling();
      return;
    }
    if (status === 'unauthorized') {
      this.deps.onSessionExpired();
      return;
    }
    // Remote sketches cannot be trusted while disconnected.
    if (this.store.getState().remoteSketches.size > 0) this.store.update({ remoteSketches: new Map() });
    this.offlineTimer ??= setTimeout(() => this.sync.startPolling(), this.deps.offlineGraceMs ?? 3_000);
  }

  private onMessage(message: ServerMessage): void {
    const me = this.deps.user.id;
    switch (message.type) {
      case 'hello':
        this.store.setPresence(message.users);
        break;
      case 'presence':
        this.store.upsertPresence(message.user, message.event === 'leave');
        break;
      case 'area': {
        const editing = this.store.editingId();
        if (message.event === 'deleted') {
          if (this.store.getState().selectedId === message.area.id && message.actor.id !== me) {
            this.store.notify('info', `${message.actor.displayName} deleted “${message.area.name}”`);
          }
          this.store.removeArea(message.area.id);
        } else {
          this.store.upsertArea(message.area);
        }
        if (editing === message.area.id && message.actor.id !== me) {
          this.store.notify('info', `${message.actor.displayName} just changed this area; saving will ask you to resolve the conflict`);
        }
        break;
      }
      case 'sketch':
        if (message.userId === me) break;
        this.store.setRemoteSketch(
          { userId: message.userId, displayName: message.displayName, color: message.color, points: message.points, areaSqKm: message.areaSqKm },
          message.userId,
        );
        break;
      case 'sketch:end':
        this.store.setRemoteSketch(null, message.userId);
        break;
      case 'resync':
        void this.sync.refresh();
        break;
      case 'error':
      case 'pong':
        break;
    }
  }

  private scheduleRender(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    if (!this.engine) return;
    const state = this.store.getState();
    const cache = this.renderCache;
    let areas: RenderableArea[];
    if (cache && cache.areas === state.areas && cache.presence === state.presence && cache.selected === state.selectedId) {
      areas = cache.result;
    } else {
      const lockedBy = new Map<string, string>();
      for (const u of state.presence.values()) if (u.editingAreaId && u.userId !== this.deps.user.id) lockedBy.set(u.editingAreaId, u.displayName);
      areas = [...state.areas.values()]
        // Larger first so small polygons stay clickable on top.
        .sort((a, b) => b.areaSqKm - a.areaSqKm)
        .map((a) => this.toRenderable(a, a.id === state.selectedId, lockedBy.get(a.id) ?? null));
      this.renderCache = { areas: state.areas, presence: state.presence, selected: state.selectedId, result: areas };
    }
    this.engine.renderAreas(areas);
    if (this.renderedSketches !== state.remoteSketches) {
      this.renderedSketches = state.remoteSketches;
      const sketches: RenderableSketch[] = [...state.remoteSketches.values()];
      this.engine.renderSketches(sketches);
    }
  }

  private toRenderable(area: AreaDto, selected: boolean, lockedBy: string | null): RenderableArea {
    return {
      id: area.id,
      name: area.name,
      geometry: area.geometry,
      color: userColor(area.ownerId),
      label: `${area.name} · ${formatArea(area.areaSqKm)} · ${area.ownerName}${lockedBy ? ` · ${lockedBy} is editing` : ''}`,
      selected,
      lockedBy,
    };
  }
}
