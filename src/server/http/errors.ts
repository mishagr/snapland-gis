import type { ApiErrorCode } from '@/lib/api/types';

const API_ERROR_BRAND = Symbol.for('snapland.ApiError');

/**
 * An error that maps directly to an HTTP response.
 *
 * Use `ApiError.is()` rather than `instanceof`: services are instantiated by the
 * custom server while route handlers are bundled by Next, so the two sides hold
 * different copies of this class. The brand lives in the global symbol registry.
 */
export class ApiError extends Error {
  readonly [API_ERROR_BRAND] = true;

  static is(err: unknown): err is ApiError {
    return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[API_ERROR_BRAND] === true;
  }

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static validation(message: string, details?: unknown) {
    return new ApiError(422, 'VALIDATION_FAILED', message, details);
  }
  static invalidGeometry(message: string, details?: unknown) {
    return new ApiError(422, 'INVALID_GEOMETRY', message, details);
  }
  static unauthorized(message = 'Sign in required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Not allowed') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
  static rateLimited(retryAfterMs: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return new ApiError(429, 'RATE_LIMITED', `Too many requests, retry in ${seconds}s`, { retryAfterSeconds: seconds }, {
      'Retry-After': String(seconds),
    });
  }
  static timeout() {
    return new ApiError(503, 'TIMEOUT', 'The request took too long; please retry');
  }
  static unavailable(message = 'Service temporarily unavailable') {
    return new ApiError(503, 'UNAVAILABLE', message);
  }
}
