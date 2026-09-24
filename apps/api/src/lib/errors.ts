/**
 * Structured, user-safe error model. Every error returned by the API has the shape:
 *   { "error": { "code": "INVALID_URL", "message": "...", "details"?: {...}, "requestId": "..." } }
 * Messages never include stack traces, internal hostnames, or upstream response bodies.
 */

export const ErrorCodes = {
  // request / validation
  VALIDATION_ERROR: 400,
  INVALID_URL: 400,
  UNSUPPORTED_URL: 400,
  BLOCKED_URL: 400,
  LIMIT_EXCEEDED: 400,
  // auth
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_API_KEY: 401,
  FORBIDDEN: 403,
  SIGNUP_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  JOB_NOT_CANCELLABLE: 409,
  RESULT_NOT_READY: 409,
  RATE_LIMITED: 429,
  TOO_MANY_ACTIVE_JOBS: 429,
  // execution (surface on job/result records; also returned by sync paths)
  DNS_RESOLUTION_FAILED: 422,
  ROBOTS_DISALLOWED: 422,
  TIMEOUT: 504,
  HTTP_ERROR: 502,
  CONNECTION_FAILED: 502,
  SSL_ERROR: 502,
  CRAWL_FAILED: 502,
  EXTRACTION_FAILED: 502,
  ENGINE_UNAVAILABLE: 503,
  INTERRUPTED: 500,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`);
