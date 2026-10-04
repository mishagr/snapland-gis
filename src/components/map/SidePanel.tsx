'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiClient } from '@/lib/api/ApiClient';
import type { AreaDto, AreaVersionDto, UserDto } from '@/lib/api/types';
import { formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import type { MapState } from '@/lib/map/MapStateStore';
import type { WorkspaceController } from '@/lib/map/WorkspaceController';
import { userColor } from '@/lib/realtime/colors';

interface Props {
  state: MapState;
  controller: WorkspaceController | null;
  user: UserDto;
}

export function SidePanel({ state, controller, user }: Props) {
  const selected = state.selectedId ? state.areas.get(state.selectedId) : undefined;
  return (
    <aside className="side-panel" aria-label="Details">
      <PresenceList state={state} user={user} />
      {selected ? (
        <AreaDetails key={selected.id} area={selected} state={state} controller={controller} user={user} />
      ) : (
        <AreaList state={state} controller={controller} />
      )}
    </aside>
  );
}

function PresenceList({ state, user }: { state: MapState; user: UserDto }) {
  const users = [...state.presence.values()].sort((a, b) => (a.userId === user.id ? -1 : b.userId === user.id ? 1 : a.displayName.localeCompare(b.displayName)));
  const areaName = (id: string) => state.areas.get(id)?.name ?? 'an area';
  return (
    <section className="panel-section">
      <h2>
        On the map now <span className="count">{users.length}</span>
      </h2>
      {users.length === 0 ? (
        <p className="muted">{state.connection === 'open' ? 'Just you.' : 'Presence is unavailable while offline.'}</p>
      ) : (
        <ul className="presence-list">
          {users.map((u) => (
            <li key={u.userId}>
              <span className="avatar avatar-small" style={{ background: u.color }} aria-hidden>
                {u.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="presence-name">
                {u.displayName}
                {u.userId === user.id ? ' (you)' : ''}
              </span>
              <span className="presence-status">
                {u.drawing ? '✎ drawing' : u.editingAreaId ? `editing ${areaName(u.editingAreaId)}` : ''}
                {u.connections > 1 ? ` · ${u.connections} tabs` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AreaList({ state, controller }: { state: MapState; controller: WorkspaceController | null }) {
  const areas = useMemo(() => [...state.areas.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [state.areas]);
  const total = areas.reduce((sum, a) => sum + a.areaSqKm, 0);
  return (
    <section className="panel-section panel-grow">
      <h2>
        Areas in view <span className="count">{areas.length}</span>
      </h2>
      {state.truncated && <p className="warning">Too many areas here to show them all; zoom in to see every area.</p>}
      {areas.length === 0 ? (
        <p className="muted">No areas here yet. Use “Draw area” to add one: click to place points, double-click to finish.</p>
      ) : (
        <>
          <p className="muted">Total {formatArea(total)}</p>
          <ul className="area-list">
            {areas.slice(0, 200).map((a) => (
              <li key={a.id}>
                <button className="area-row" onClick={() => controller?.selectArea(a.id)} onDoubleClick={() => controller?.zoomToArea(a.id)}>
                  <span className="swatch" style={{ background: userColor(a.ownerId) }} aria-hidden />
                  <span className="area-row-name">{a.name}</span>
                  <span className="area-row-size">{formatArea(a.areaSqKm)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AreaDetails({ area, state, controller, user }: { area: AreaDto; state: MapState; controller: WorkspaceController | null; user: UserDto }) {
  const [editingText, setEditingText] = useState(false);
  // Version shown when the form was opened; saving against it detects concurrent edits.
  const [baseVersion, setBaseVersion] = useState(area.version);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isOwner = area.ownerId === user.id;
  const shapeEditing = state.mode.kind === 'editing' && state.mode.areaId === area.id;
  const candidate = state.mode.kind === 'editing' ? state.mode.candidate : null;
  const editor = [...state.presence.values()].find((u) => u.editingAreaId === area.id && u.userId !== user.id);
  const vertexEditing = state.engine === 'leaflet';

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = await controller?.updateDetails(
      area.id,
      { name: String(form.get('name') ?? '').trim(), description: String(form.get('description') ?? '').trim() },
      baseVersion,
    );
    // On conflict the dialog takes over (keep theirs / apply mine), so the form closes too.
    if (result === 'saved' || result === 'conflict') setEditingText(false);
  }

  return (
    <section className="panel-section panel-grow area-details">
      <div className="details-header">
        <button className="btn btn-ghost btn-small" onClick={() => controller?.selectArea(null)} disabled={shapeEditing}>
          ← All areas
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => controller?.zoomToArea(area.id)}>
          Zoom to
        </button>
      </div>

      {editingText ? (
        <form className="details-form" onSubmit={(e) => void onSave(e)}>
          <label>
            Name
            <input name="name" defaultValue={area.name} required maxLength={120} autoFocus />
          </label>
          <label>
            Description
            <textarea name="description" defaultValue={area.description} maxLength={2000} rows={3} />
          </label>
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={state.busy}>
              Save
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setEditingText(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2 className="area-title">
            <span className="swatch" style={{ background: userColor(area.ownerId) }} aria-hidden />
            {area.name}
          </h2>
          {area.description && <p className="area-description">{area.description}</p>}
        </>
      )}

      {editor && <p className="warning">{editor.displayName} is editing this area right now.</p>}

      <dl className="stats">
        <dt>Area</dt>
        <dd title="Geodesic area on the WGS84 ellipsoid (PostGIS geography)">{formatArea(area.areaSqKm)}</dd>
        <dt>Vertices</dt>
        <dd>{area.vertexCount}</dd>
        <dt>Owner</dt>
        <dd>{isOwner ? 'You' : area.ownerName}</dd>
        <dt>Version</dt>
        <dd>
          v{area.version} · {area.updatedByName}, {new Date(area.updatedAt).toLocaleString()}
        </dd>
      </dl>

      {shapeEditing ? (
        <div className="edit-shape-box">
          <p>
            {vertexEditing
              ? 'Drag the handles to move vertices, drag a small handle to add one, right-click a vertex to remove it.'
              : 'govmap has no vertex editing: draw the new outline on the map (double-click to finish).'}
          </p>
          {candidate && (
            <p className={candidate.valid ? 'live-area' : 'form-error'}>
              New area: {formatArea(candidate.areaSqKm)} {candidate.valid ? '' : '(edges cross; fix before saving)'}
            </p>
          )}
          <div className="row">
            <button className="btn btn-primary" disabled={state.busy || (candidate !== null && !candidate.valid)} onClick={() => void controller?.saveShapeEdit()}>
              Save shape
            </button>
            <button className="btn btn-ghost" onClick={() => controller?.cancelShapeEdit()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        !editingText && (
          <div className="row wrap">
            <button
              className="btn"
              onClick={() => {
                setBaseVersion(area.version);
                setEditingText(true);
              }}
              disabled={state.mode.kind !== 'idle'}
            >
              Edit details
            </button>
            <button className="btn" onClick={() => void controller?.startShapeEdit()} disabled={state.mode.kind !== 'idle'}>
              {vertexEditing ? 'Edit shape' : 'Redraw shape'}
            </button>
            <button className="btn" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? 'Hide history' : 'History'}
            </button>
            {isOwner &&
              (confirmDelete ? (
                <span className="confirm">
                  Delete?{' '}
                  <button className="btn btn-danger btn-small" onClick={() => void controller?.deleteArea(area.id)}>
                    Yes, delete
                  </button>
                  <button className="btn btn-ghost btn-small" onClick={() => setConfirmDelete(false)}>
                    No
                  </button>
                </span>
              ) : (
                <button className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)} disabled={state.mode.kind !== 'idle'}>
                  Delete
                </button>
              ))}
          </div>
        )
      )}

      {showHistory && <AreaHistory areaId={area.id} version={area.version} />}
    </section>
  );
}

function AreaHistory({ areaId, version }: { areaId: string; version: number }) {
  const [versions, setVersions] = useState<AreaVersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .listVersions(areaId)
      .then(({ versions }) => !cancelled && setVersions(versions))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // Refetch whenever the area gets a new version.
  }, [areaId, version]);

  if (error) return <p className="form-error">{error}</p>;
  if (!versions) return <p className="muted">Loading history…</p>;
  return (
    <ol className="history">
      {versions.map((v) => (
        <li key={v.version}>
          <span className={`history-action action-${v.action.toLowerCase()}`}>{v.action.toLowerCase()}</span> v{v.version} by{' '}
          <strong>{v.editedByName}</strong>
          <span className="muted"> · {new Date(v.createdAt).toLocaleString()}</span>
          <div className="muted">
            “{v.name}” · {formatArea(v.areaSqKm)}
          </div>
        </li>
      ))}
    </ol>
  );
}
