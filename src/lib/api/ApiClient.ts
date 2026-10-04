import type { BBox, PolygonGeometry } from '@/lib/geo/types';
import type { ApiErrorBody, ApiErrorCode, AreaDto, AreaListResponse, AreaVersionDto, UserDto } from './types';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface AreaPatchInput {
  expectedVersion: number;
  name?: string;
  description?: string;
  geometry?: PolygonGeometry;
}

/** Typed browser client for the REST API (same-origin, cookie session). */
export class ApiClient {
  constructor(private readonly baseUrl = '') {}

  register(email: string, password: string, displayName: string) {
    return this.request<{ user: UserDto }>('POST', '/api/auth/register', { email, password, displayName });
  }
  login(email: string, password: string) {
    return this.request<{ user: UserDto }>('POST', '/api/auth/login', { email, password });
  }
  logout() {
    return this.request<{ ok: true }>('POST', '/api/auth/logout');
  }
  me() {
    return this.request<{ user: UserDto }>('GET', '/api/auth/me');
  }

  listAreas(bbox: BBox, resolution: number | undefined, signal?: AbortSignal) {
    const params = new URLSearchParams({ bbox: `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}` });
    if (resolution && Number.isFinite(resolution)) params.set('res', resolution.toFixed(3));
    return this.request<AreaListResponse>('GET', `/api/areas?${params}`, undefined, signal);
  }
  getArea(id: string) {
    return this.request<{ area: AreaDto }>('GET', `/api/areas/${id}`);
  }
  createArea(input: { name: string; description: string; geometry: PolygonGeometry }) {
    return this.request<{ area: AreaDto }>('POST', '/api/areas', input);
  }
  updateArea(id: string, patch: AreaPatchInput) {
    return this.request<{ area: AreaDto }>('PATCH', `/api/areas/${id}`, patch);
  }
  deleteArea(id: string, expectedVersion?: number) {
    const q = expectedVersion ? `?expectedVersion=${expectedVersion}` : '';
    return this.request<{ area: AreaDto }>('DELETE', `/api/areas/${id}${q}`);
  }
  restoreArea(id: string) {
    return this.request<{ area: AreaDto }>('POST', `/api/areas/${id}/restore`);
  }
  listVersions(id: string) {
    return this.request<{ versions: AreaVersionDto[] }>('GET', `/api/areas/${id}/versions`);
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiClientError(0, 'NETWORK', 'Network error: check your connection');
    }
    if (res.ok) return (await res.json()) as T;
    let payload: ApiErrorBody | undefined;
    try {
      payload = (await res.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error */
    }
    const retryAfter = Number(res.headers.get('Retry-After') ?? '') || undefined;
    throw new ApiClientError(
      res.status,
      payload?.error.code ?? 'INTERNAL',
      payload?.error.message ?? `Request failed (${res.status})`,
      payload?.error.details,
      retryAfter,
    );
  }
}

export const apiClient = new ApiClient();
