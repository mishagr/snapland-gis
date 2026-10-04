import { userColor } from '@/lib/realtime/colors';
import type { PresenceUser } from '@/lib/realtime/protocol';

interface Entry {
  displayName: string;
  color: string;
  sockets: Set<string>;
  editingAreaId: string | null;
  drawingSockets: Set<string>;
}

export type PresenceChange = { event: 'join' | 'leave' | 'update'; user: PresenceUser } | null;

/**
 * Who is on the map right now. A user may have several tabs (sockets); they join
 * with their first socket and leave with their last, so presence does not flicker
 * on reloads or multi-tab use. Per-instance state; see README for multi-instance.
 */
export class PresenceRegistry {
  private readonly users = new Map<string, Entry>();

  add(userId: string, displayName: string, socketId: string): PresenceChange {
    const existing = this.users.get(userId);
    if (existing) {
      existing.sockets.add(socketId);
      existing.displayName = displayName;
      return { event: 'update', user: this.snapshot(userId, existing) };
    }
    const entry: Entry = { displayName, color: userColor(userId), sockets: new Set([socketId]), editingAreaId: null, drawingSockets: new Set() };
    this.users.set(userId, entry);
    return { event: 'join', user: this.snapshot(userId, entry) };
  }

  remove(userId: string, socketId: string): PresenceChange {
    const entry = this.users.get(userId);
    if (!entry) return null;
    entry.sockets.delete(socketId);
    entry.drawingSockets.delete(socketId);
    if (entry.sockets.size === 0) {
      this.users.delete(userId);
      return { event: 'leave', user: this.snapshot(userId, entry) };
    }
    return { event: 'update', user: this.snapshot(userId, entry) };
  }

  setEditing(userId: string, areaId: string | null): PresenceChange {
    const entry = this.users.get(userId);
    if (!entry || entry.editingAreaId === areaId) return null;
    entry.editingAreaId = areaId;
    return { event: 'update', user: this.snapshot(userId, entry) };
  }

  setDrawing(userId: string, socketId: string, drawing: boolean): PresenceChange {
    const entry = this.users.get(userId);
    if (!entry) return null;
    const before = entry.drawingSockets.size > 0;
    if (drawing) entry.drawingSockets.add(socketId);
    else entry.drawingSockets.delete(socketId);
    const after = entry.drawingSockets.size > 0;
    return before === after ? null : { event: 'update', user: this.snapshot(userId, entry) };
  }

  get(userId: string): PresenceUser | null {
    const entry = this.users.get(userId);
    return entry ? this.snapshot(userId, entry) : null;
  }

  connectionCount(userId: string): number {
    return this.users.get(userId)?.sockets.size ?? 0;
  }

  list(): PresenceUser[] {
    return [...this.users.entries()].map(([id, e]) => this.snapshot(id, e));
  }

  get size(): number {
    return this.users.size;
  }

  private snapshot(userId: string, e: Entry): PresenceUser {
    return {
      userId,
      displayName: e.displayName,
      color: e.color,
      connections: e.sockets.size,
      editingAreaId: e.editingAreaId,
      drawing: e.drawingSockets.size > 0,
    };
  }
}
