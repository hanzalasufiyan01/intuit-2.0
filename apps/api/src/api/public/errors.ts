import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, UnauthenticatedError } from '../../domain/errors.js';
import { RateLimitedError } from '../../application/rate-limiter.js';

/**
 * The Public API error contract (ADR 0011 section 9):
 *
 *   { "error": { "type", "code", "message", "request_id", "details"? } }
 *
 * `type` is one of authentication_error, permission_error, invalid_request, not_found, conflict,
 * rate_limited, api_error; `code` is a stable snake_case value. Messages are generic: they never
 * say why a credential failed, whether a resource exists in another organization, or anything
 * about the database, the stack or the service principal. Unexpected failures are logged
 * internally and answered as `api_error`.
 */

type PublicErrorType =
  | 'authentication_error'
  | 'permission_error'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'api_error';

interface PublicError {
  status: number;
  type: PublicErrorType;
  code: string;
  message: string;
  details?: { field: string; issue: string }[];
}

export function rateLimitHeaders(
  reply: FastifyReply,
  d: {
    limit: number;
    remaining: number;
    resetSeconds: number;
  },
) {
  void reply.header('ratelimit-limit', String(d.limit));
  void reply.header('ratelimit-remaining', String(d.remaining));
  void reply.header('ratelimit-reset', String(d.resetSeconds));
}

/** Stable public codes for the conflicts a client can act on; the rest stay `conflict`. */
function conflict(internal: string): PublicError {
  const known: Record<string, [string, string]> = {
    VERSION_CONFLICT: [
      'version_conflict',
      'The resource was changed since the version you sent. Read it again and retry.',
    ],
    IDEMPOTENCY_CONFLICT: [
      'idempotency_conflict',
      'This Idempotency-Key was already used for a different request.',
    ],
    INVALID_STATE_TRANSITION: [
      'invalid_state',
      'The resource is not in a state that allows this change.',
    ],
  };
  const [code, message] = known[internal] ?? [
    'conflict',
    'The request conflicts with the current state.',
  ];
  return { status: 409, type: 'conflict', code, message };
}

function classify(error: unknown): PublicError {
  if (error instanceof RateLimitedError) {
    return {
      status: 429,
      type: 'rate_limited',
      code: 'rate_limit_exceeded',
      message: 'Too many requests. Retry after the time given in Retry-After.',
    };
  }
  if (error instanceof UnauthenticatedError) {
    return {
      status: 401,
      type: 'authentication_error',
      code: 'invalid_token',
      message: 'Invalid or expired API token.',
    };
  }
  if (error instanceof AppError) {
    switch (error.status) {
      case 400:
        return {
          status: 400,
          type: 'invalid_request',
          code: error.message === 'invalid_cursor' ? 'invalid_cursor' : 'validation_failed',
          message:
            error.message === 'invalid_cursor'
              ? 'The cursor is not valid.'
              : 'The request is invalid.',
          details: (error.details?.issues ?? []).map((i) => ({ field: i.path, issue: i.message })),
        };
      case 401:
        return {
          status: 401,
          type: 'authentication_error',
          code: 'invalid_token',
          message: 'Invalid or expired API token.',
        };
      case 403:
        return {
          status: 403,
          type: 'permission_error',
          code: 'insufficient_scope',
          message: 'The token does not allow this request.',
        };
      case 404:
        return {
          status: 404,
          type: 'not_found',
          code: 'resource_not_found',
          message: 'The resource was not found.',
        };
      case 409:
        return conflict(error.code);
      default:
        if (error.status < 500) {
          return {
            status: error.status,
            type: 'invalid_request',
            code: 'invalid_request',
            message: 'The request could not be processed.',
          };
        }
    }
  }
  const status = (error as FastifyError).statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    return status === 404
      ? {
          status,
          type: 'not_found',
          code: 'resource_not_found',
          message: 'The resource was not found.',
        }
      : {
          status,
          type: 'invalid_request',
          code: 'bad_request',
          message: 'The request could not be processed.',
        };
  }
  return {
    status: 500,
    type: 'api_error',
    code: 'internal_error',
    message: 'An unexpected error occurred.',
  };
}

function send(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const mapped = classify(error);
  if (mapped.status >= 500) request.log.error({ err: error }, 'Public API error');
  if (error instanceof RateLimitedError) {
    rateLimitHeaders(reply, { ...error.decision, remaining: 0 });
    void reply.header('retry-after', String(error.decision.resetSeconds));
  }
  if (mapped.status === 401) void reply.header('www-authenticate', 'Bearer');
  const { status, ...body } = mapped;
  return reply.status(status).send({ error: { ...body, request_id: request.id } });
}

/** Installs the envelope as this plugin's error and not-found handlers (it does not leak to /api/v1). */
export function registerPublicErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => send(request, reply, error));
  app.setNotFoundHandler((request, reply) =>
    send(request, reply, new AppError('NOT_FOUND', 404, 'not found')),
  );
}
