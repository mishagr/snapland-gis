import { EventEmitter } from 'node:events';
import type { AreaDto } from '@/lib/api/types';
import type { BBox } from '@/lib/geo/types';

export type AreaEventType = 'area.created' | 'area.updated' | 'area.deleted' | 'area.restored';

export interface AreaDomainEvent {
  type: AreaEventType;
  area: AreaDto;
  /** For geometry updates: where the area was before, so viewers of the old spot are told it moved. */
  previousBBox?: BBox;
  actor: { id: string; displayName: string };
  at: string;
}

export type DomainEventListener = (event: AreaDomainEvent) => void;

/**
 * Seam between the write path (REST handlers) and the fan-out path (WebSocket
 * gateway). In-process today; a Redis pub/sub implementation of the same
 * interface is what lets several app instances share events (see README).
 */
export interface DomainEventBus {
  publish(event: AreaDomainEvent): void;
  subscribe(listener: DomainEventListener): () => void;
}

export class InProcessEventBus implements DomainEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: AreaDomainEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: DomainEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
