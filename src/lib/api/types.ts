import type { PolygonGeometry } from '@/lib/geo/types';

/** Public user shape (never includes credentials). */
export interface UserDto {
  id: string;
  email: string;
  displayName: string;
}

/** An area as returned by the API. Dates are ISO strings. */
export interface AreaDto {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  description: string;
  /** Geodesic area on the WGS84 ellipsoid, km² (computed by PostGIS). */
  areaSqKm: number;
  vertexCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedById: string;
  updatedByName: string;
  deletedAt: string | null;
  geometry: PolygonGeometry;
  /** True when geometry was simplified for the requested zoom (fetch by id for full detail). */
  simplified: boolean;
}

export type AreaAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE';

export interface AreaVersionDto {
  version: number;
  action: AreaAction;
  name: string;
  description: string;
  areaSqKm: number;
  editedById: string;
  editedByName: string;
  createdAt: string;
  geometry: PolygonGeometry;
}

export interface AreaListResponse {
  areas: AreaDto[];
  /** More areas matched than the server returns in one response; zoom in to see all. */
  truncated: boolean;
}

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'INVALID_GEOMETRY'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/** 409 body for a stale `expectedVersion`: carries the current server state. */
export interface ConflictDetails {
  current: AreaDto;
}
