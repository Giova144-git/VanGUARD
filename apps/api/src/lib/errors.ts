import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError as ApiErrorBody, type ErrorCode } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';

// Mapa fijo código → HTTP (canónicas §7, S15 15.3). 413 se pasa a mano con code invalid_body.
const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_body: 422,
  key_rejected: 422,
  provider_rejected: 422,
  rate_limited: 429,
  budget_exceeded: 429,
  ai_disabled: 503,
  provider_unavailable: 502,
  internal: 500,
};

// `details` solo lleva datos nuestros (missing_permissions, reason, attempts_left…), nunca texto de terceros.
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, status?: ContentfulStatusCode) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = status ?? STATUS[code];
  }
}

export function fail(c: Context<AppEnv>, code: ErrorCode, message: string, details?: Record<string, unknown>,
  status?: ContentfulStatusCode) {
  const body = ApiErrorBody.parse({
    error: { code, message, request_id: c.get('rid') ?? '', ...(details ? { details } : {}) },
  });
  return c.json(body, status ?? STATUS[code]);
}
