'use client';

import 'leaflet/dist/leaflet.css';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiClient } from '@/lib/api/ApiClient';
import type { UserDto } from '@/lib/api/types';
import type { PublicConfig } from '@/lib/config/publicConfig';
import { MapStateStore } from '@/lib/map/MapStateStore';
import { WorkspaceController } from '@/lib/map/WorkspaceController';
import { RealtimeClient } from '@/lib/realtime/RealtimeClient';
import { ConflictDialog, SaveAreaDialog } from './Dialogs';
import { SidePanel } from './SidePanel';
import { ConnectionBanner, DrawHint, Toast } from './StatusViews';
import { Toolbar } from './Toolbar';

interface Props {
  user: UserDto;
  config: PublicConfig;
}

/**
 * Client root of the map page. Owns the store (survives React StrictMode's double
 * mount) and creates one WorkspaceController per mount; everything else is a pure
 * view of the store that calls controller methods.
 */
export function MapWorkspace({ user, config }: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [store] = useState(
    () =>
      new MapStateStore({
        engine: config.defaultEngine,
        view: { center: config.defaultCenter, resolution: config.defaultResolution },
      }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [controller] = useState(
    () =>
      new WorkspaceController({
        api: apiClient,
        realtime: new RealtimeClient(),
        store,
        config,
        user,
        onSessionExpired: () => router.replace('/login?expired=1'),
      }),
  );

  useEffect(() => {
    void controller.start(containerRef.current!);
    if (process.env.NODE_ENV !== 'production') {
      // Debug/e2e hook (not shipped in production builds).
      (window as unknown as { __snapland?: unknown }).__snapland = { store, controller };
    }
    return () => controller.dispose();
  }, [controller, store]);

  return (
    <div className="workspace" data-engine={state.engine} data-connection={state.connection}>
      <Toolbar state={state} controller={controller} user={user} config={config} />
      <div className="workspace-body">
        <div className="map-wrap">
          <div ref={containerRef} className="map-container" aria-label="Map" />
          <ConnectionBanner state={state} />
          <DrawHint state={state} controller={controller} />
        </div>
        <SidePanel state={state} controller={controller} user={user} />
      </div>
      <SaveAreaDialog state={state} controller={controller} />
      <ConflictDialog state={state} controller={controller} />
      <Toast state={state} controller={controller} />
    </div>
  );
}
