'use client';

import { useEffect, useState } from 'react';
import type { MapState } from '@/lib/map/MapStateStore';
import type { WorkspaceController } from '@/lib/map/WorkspaceController';

interface Props {
  state: MapState;
  controller?: WorkspaceController | null;
}

/** Graceful degradation notice: editing keeps working over REST while live updates are down. */
export function ConnectionBanner({ state }: Props) {
  if (state.connection === 'open' || state.connection === 'connecting') return null;
  return (
    <div className="connection-banner" role="status">
      {state.connection === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Live updates unavailable.'}{' '}
      {state.polling ? 'Showing changes every 15 s; you can keep drawing and editing.' : 'You can keep drawing and editing.'}
    </div>
  );
}

export function DrawHint({ state }: Props) {
  if (state.mode.kind !== 'drawing') return null;
  const govmap = state.engine === 'govmap';
  return (
    <div className="draw-hint" role="status">
      {govmap
        ? 'Click to add points, double-click to finish (govmap drawing). Esc or Cancel to stop.'
        : 'Click to add points · double-click, Enter or click the first point to finish · Backspace undoes · Esc cancels'}
    </div>
  );
}

export function Toast({ state, controller }: Props) {
  const notice = state.notice;
  // Notices are identified by timestamp; a notice is hidden once dismissed or expired.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setDismissedAt(notice.at), notice.kind === 'error' ? 7000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice || dismissedAt === notice.at) return null;
  const hide = () => setDismissedAt(notice.at);
  const canUndo = notice.text.startsWith('Deleted') && controller?.lastDeleted;
  return (
    <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {canUndo && (
        <button
          className="btn btn-small"
          onClick={() => {
            void controller?.restoreLastDeleted();
            hide();
          }}
        >
          Undo
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={hide}>
        ×
      </button>
    </div>
  );
}
