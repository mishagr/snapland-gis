'use client';

import { useEffect, useRef, type FormEvent } from 'react';
import { formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import type { MapState } from '@/lib/map/MapStateStore';
import type { WorkspaceController } from '@/lib/map/WorkspaceController';

interface Props {
  state: MapState;
  controller: WorkspaceController | null;
}

/** Native <dialog> opened/closed from store state (focus trap and Esc for free). */
function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

export function SaveAreaDialog({ state, controller }: Props) {
  const open = state.mode.kind === 'naming';
  const ref = useDialog(open);
  const size = state.mode.kind === 'naming' ? state.mode.areaSqKm : 0;
  const vertices = state.mode.kind === 'naming' ? state.mode.ring.length - 1 : 0;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const ok = await controller?.saveNewArea(String(form.get('name') ?? '').trim(), String(form.get('description') ?? '').trim());
    if (ok) e.currentTarget?.reset();
  }

  return (
    <dialog ref={ref} className="dialog" onCancel={() => controller?.discardNewArea()} aria-labelledby="save-area-title">
      {open && (
        <form method="dialog" onSubmit={(e) => void onSubmit(e)}>
          <h2 id="save-area-title">Save new area</h2>
          <p className="muted">
            {formatArea(size)} · {vertices} vertices (geodesic, WGS84 ellipsoid)
          </p>
          <label>
            Name
            <input name="name" required maxLength={120} autoFocus placeholder="e.g. North field" />
          </label>
          <label>
            Description <span className="muted">(optional)</span>
            <textarea name="description" maxLength={2000} rows={3} />
          </label>
          <div className="row end">
            <button type="button" className="btn btn-ghost" onClick={() => controller?.discardNewArea()}>
              Discard
            </button>
            <button type="submit" className="btn btn-primary" disabled={state.busy}>
              {state.busy ? 'Saving…' : 'Save area'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function ConflictDialog({ state, controller }: Props) {
  const conflict = state.conflict;
  const ref = useDialog(conflict !== null);
  const changed = conflict ? Object.keys(conflict.mine).join(', ') : '';
  return (
    <dialog ref={ref} className="dialog" onCancel={() => void controller?.resolveConflict('theirs')} aria-labelledby="conflict-title">
      {conflict && (
        <div>
          <h2 id="conflict-title">Someone else changed this area</h2>
          <p>{conflict.message}</p>
          <dl className="stats">
            <dt>Their version</dt>
            <dd>
              v{conflict.theirs.version} by {conflict.theirs.updatedByName}
            </dd>
            <dt>Their name</dt>
            <dd>{conflict.theirs.name}</dd>
            <dt>Their area</dt>
            <dd>{formatArea(conflict.theirs.areaSqKm)}</dd>
            <dt>Your change</dt>
            <dd>{changed}</dd>
          </dl>
          <div className="row end">
            <button className="btn" onClick={() => void controller?.resolveConflict('theirs')}>
              Keep their version
            </button>
            <button className="btn btn-primary" onClick={() => void controller?.resolveConflict('mine')}>
              Apply my change on top
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
