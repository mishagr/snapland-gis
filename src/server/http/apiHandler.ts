import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import type { ApiErrorBody } from '@/lib/api/types';
import type { RequestMeta } from '@/server/areas/AreaService';
import { SESSION_COOKIE } from '@/server/auth/cookies';
import type { Session } from '@/server/auth/SessionStore';
import { getServices } from '@/server/container';
import { corsHeaders, isTrustedMutationOrigin } from '@/server/security/origin';
import { CLIENT_IP_HEADER } from './constants';
import { ApiError } from './errors';

const MAX_BODY_BYTES = 256 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiContext<P> {
  req: NextRequest;
  params: P;
  requestId: string;
  meta: RequestMeta;
  session: Session | null;
  /** The authenticated session; throws 401 when absent. */
  requireSession(): Session;
  /** Parses and validates the JSON body (size-limited). */
  body<T>(schema: ZodType<T>): Promise<T>;
}

export interface ApiRouteOptions {
  /** Reject unauthenticated requests before the handler runs. */
  auth?: boolean;
}

type RouteContext<P> = { params: Promise<P> };
type Handler<P> = (ctx: ApiContext<P>) => Promise<Response | object>;

/**
 * Wraps a route handler with the cross-cutting concerns every endpoint needs:
 * request ids, CSRF origin checks, session loading, body limits, a hard timeout,
 * uniform JSON errors, CORS headers and one structured access-log line.
 */
export function apiRoute<P = Record<string, never>>(handler: Handler<P>, options: ApiRouteOptions = {}) {
  return async (req: NextRequest, routeCtx: RouteContext<P>): Promise<Response> => {
    const { logger, env } = getServices();
    const started = performance.now();
    const requestId = sanitizeRequestId(req.headers.get('x-request-id')) ?? randomUUID();
    const meta: RequestMeta = {
      requestId,
      ip: req.headers.get(CLIENT_IP_HEADER) ?? undefined,
      userAgent: req.headers.get('user-agent'),
    };
    let session: Session | null = null;
    let response: Response;

    try {
      if (MUTATING.has(req.method) && !isTrustedMutationOrigin(req.headers.get('origin'), req.headers.get('sec-fetch-site'))) {
        throw ApiError.forbidden('Cross-origin request rejected');
      }
      session = await loadSession(req);
      if (options.auth && !session) throw ApiError.unauthorized();

      const ctx: ApiContext<P> = {
        req,
        params: await routeCtx.params,
        requestId,
        meta,
        session,
        requireSession: () => {
          if (!session) throw ApiError.unauthorized();
          return session;
        },
        body: (schema) => readJson(req, schema),
      };

      const result = await withTimeout(handler(ctx), env.REQUEST_TIMEOUT_MS);
      response = result instanceof Response ? result : NextResponse.json(result);
    } catch (err) {
      response = errorResponse(err, requestId, logger);
    }

    response.headers.set('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) response.headers.set(k, v);
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');

    const durationMs = Math.round(performance.now() - started);
    const log = { requestId, method: req.method, path: req.nextUrl.pathname, status: response.status, durationMs, userId: session?.userId };
    if (response.status >= 500) logger.error(log, 'request failed');
    else if (durationMs > 1000) logger.warn(log, 'slow request');
    else logger.info(log, 'request');
    return response;
  };

  async function loadSession(req: NextRequest): Promise<Session | null> {
    const sid = req.cookies.get(SESSION_COOKIE)?.value;
    if (!sid) return null;
    try {
      return await getServices().sessions.get(sid);
    } catch {
      throw ApiError.unavailable('Session store unavailable');
    }
  }
}

/** Preflight handler for routes that accept cross-origin calls from allow-listed origins. */
export function corsPreflight(req: NextRequest): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'BAD_REQUEST', 'Request body too large');
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw ApiError.badRequest('Expected application/json');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'BAD_REQUEST', 'Request body too large');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw ApiError.badRequest('Malformed JSON body');
  }
  return schema.parse(json);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(ApiError.timeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorResponse(err: unknown, requestId: string, logger: ReturnType<typeof getServices>['logger']): Response {
  const apiError = toApiError(err);
  if (apiError.status >= 500) logger.error({ err, requestId }, apiError.message);
  const body: ApiErrorBody = {
    error: { code: apiError.code, message: apiError.message, requestId, ...(apiError.details !== undefined ? { details: apiError.details } : {}) },
  };
  return NextResponse.json(body, { status: apiError.status, headers: apiError.headers });
}

/** Maps library/database errors to API errors without leaking internals. */
export function toApiError(err: unknown): ApiError {
  if (ApiError.is(err)) return err;
  if (err instanceof ZodError || (err instanceof Error && err.name === 'ZodError' && Array.isArray((err as ZodError).issues))) {
    const zodError = err as ZodError;
    return ApiError.validation(
      zodError.issues[0]?.message ?? 'Invalid input',
      { issues: zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    );
  }
  const pgCode = postgresErrorCode(err);
  // 23514 check_violation (ST_IsValid), XX000 / 22023 raised by ST_GeomFromGeoJSON on bad input.
  if (pgCode === '23514' || pgCode === 'XX000' || pgCode === '22023') {
    return ApiError.invalidGeometry('The polygon is not a valid geometry');
  }
  if (pgCode === '57014') return ApiError.timeout(); // statement_timeout
  if (pgCode === '22P02') return ApiError.badRequest('Malformed identifier');
  return new ApiError(500, 'INTERNAL', 'Unexpected server error');
}

function postgresErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } }; cause?: { code?: unknown; originalCode?: unknown } };
  const candidates = [e.meta?.code, e.meta?.driverAdapterError?.cause?.originalCode, e.cause?.originalCode, e.cause?.code, e.code];
  return candidates.find((c): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c));
}

function sanitizeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : undefined;
}
