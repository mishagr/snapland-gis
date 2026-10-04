import { z } from 'zod';
import type { AreaDto } from '@/lib/api/types';
import type { BBox, LngLat } from '@/lib/geo/types';

/**
 * WebSocket protocol shared by client and server. JSON text frames, one message
 * per frame, discriminated by `type`. Inbound messages are validated with zod on
 * the server; the server never trusts identity fields from clients.
 */
export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';
/** Server rejects frames larger than this (bytes). */
export const WS_MAX_PAYLOAD = 64 * 1024;
/** Maximum vertices in a live sketch message. */
export const MAX_SKETCH_POINTS = 1000;

/** WebSocket close codes used by the server (4000–4999 are application-defined). */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  SESSION_EXPIRED: 4001,
  TOO_MANY_CONNECTIONS: 4029,
} as const;

const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const lngLat = z.tuple([lng, lat]);

const bboxSchema = z
  .object({ minLng: lng, minLat: lat, maxLng: lng, maxLat: lat })
  .refine((b) => b.minLng <= b.maxLng && b.minLat <= b.maxLat, 'Invalid bbox');

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** The area of the map the client is looking at; drives which events it receives. */
  z.object({ type: z.literal('viewport'), bbox: bboxSchema }),
  /** In-progress drawing (vertices placed so far + live area). */
  z.object({
    type: z.literal('sketch'),
    points: z.array(lngLat).max(MAX_SKETCH_POINTS),
    areaSqKm: z.number().nonnegative().max(1e7),
  }),
  z.object({ type: z.literal('sketch:end') }),
  /** Advisory "I am editing this area" hint so others know to expect changes. */
  z.object({ type: z.literal('editing'), areaId: z.uuid().nullable() }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface PresenceUser {
  userId: string;
  displayName: string;
  color: string;
  connections: number;
  editingAreaId: string | null;
  drawing: boolean;
}

export type AreaEvent = 'created' | 'updated' | 'deleted' | 'restored';

export type ServerMessage =
  | { type: 'hello'; protocol: number; you: PresenceUser; users: PresenceUser[]; serverTime: number }
  | { type: 'presence'; event: 'join' | 'leave' | 'update'; user: PresenceUser }
  | { type: 'area'; event: AreaEvent; area: AreaDto; actor: { id: string; displayName: string } }
  | { type: 'sketch'; userId: string; displayName: string; color: string; points: LngLat[]; areaSqKm: number }
  | { type: 'sketch:end'; userId: string }
  | { type: 'pong'; t: number; serverTime: number }
  /** Messages were dropped (slow connection); the client should refetch its viewport. */
  | { type: 'resync'; reason: string }
  | { type: 'error'; code: 'BAD_MESSAGE' | 'RATE_LIMITED'; message: string };

export type { BBox };
