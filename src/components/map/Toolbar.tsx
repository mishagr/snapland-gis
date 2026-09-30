'use client';

import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/ApiClient';
import type { UserDto } from '@/lib/api/types';
import type { PublicConfig } from '@/lib/config/publicConfig';
import { formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import { availableEngines } from '@/lib/map/MapEngineFactory';
import type { MapState } from '@/lib/map/MapStateStore';
import type { WorkspaceController } from '@/lib/map/WorkspaceController';
import { userColor } from '@/lib/realtime/colors';

interface Props {
  state: MapState;
  controller: WorkspaceController | null;
  user: UserDto;
  config: PublicConfig;
}

const ENGINE_LABELS = { leaflet: 'OpenStreetMap', govmap: 'govmap' } as const;
const CONNECTION_LABELS: Record<MapState['connection'], string> = {
  open: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  unauthorized: 'Signed out',
};

export function Toolbar({ state, controller, user, config }: Props) {
  const router = useRouter();
  const engines = availableEngines(config);
  const drawing = state.mode.kind === 'drawing';
  const idle = state.mode.kind === 'idle';

  async function signOut() {
    try {
      await apiClient.logout();
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <header className="topbar" role="toolbar" aria-label="Map tools">
      <div className="brand">
        <span className="brand-mark" aria-hidden>◈</span>
        <span className="brand-name">Snapland GIS</span>
      </div>

      <div className="segmented" role="radiogroup" aria-label="Map engine">
        {engines.map((kind) => (
          <button
            key={kind}
            role="radio"
            aria-checked={state.engine === kind}
            className={state.engine === kind ? 'active' : ''}
            disabled={!controller || state.busy || !idle}
            onClick={() => void controller?.switchEngine(kind)}
            title={kind === 'govmap' && config.govmap.mode === 'mock' ? 'govmap (mock mode: no token configured)' : undefined}
          >
            {ENGINE_LABELS[kind]}
            {kind === 'govmap' && config.govmap.mode === 'mock' ? ' (mock)' : ''}
          </button>
        ))}
      </div>

      <label className="layer-select">
        <span className="visually-hidden">Base layer</span>
        <select
          value={state.baseLayerId ?? ''}
          disabled={!controller || state.busy || state.baseLayers.length < 2}
          onChange={(e) => void controller?.setBaseLayer(e.target.value)}
          aria-label="Base layer"
        >
          {state.baseLayers.map((l) => (
            <option key={l.id} value={l.id} title={l.note}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <div className="draw-controls">
        {!drawing ? (
          <button className="btn btn-primary" disabled={!controller || !idle} onClick={() => controller?.startDrawing()}>
            ✎ Draw area
          </button>
        ) : (
          <>
            <span className="live-area" aria-live="polite" title="Geodesic area on the WGS84 ellipsoid">
              {formatArea(state.ownSketch?.areaSqKm ?? 0)} · {state.ownSketch?.vertexCount ?? 0} pts
            </span>
            <button className="btn btn-primary" onClick={() => controller?.finishDrawing()}>
              Finish
            </button>
            <button className="btn" onClick={() => controller?.undoVertex()} title="Backspace">
              Undo
            </button>
            <button className="btn btn-ghost" onClick={() => controller?.cancelDrawing()} title="Escape">
              Cancel
            </button>
          </>
        )}
      </div>

      <div className="spacer" />

      <span className={`connection-pill connection-${state.connection}`} title={state.polling ? 'Live updates paused; refreshing every 15 s' : undefined}>
        <span className="dot" aria-hidden /> {CONNECTION_LABELS[state.connection]}
        {state.polling ? ' · polling' : ''}
      </span>

      <div className="user-chip">
        <span className="avatar" style={{ background: userColor(user.id) }} aria-hidden>
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-name">{user.displayName}</span>
        <button className="btn btn-ghost btn-small" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
