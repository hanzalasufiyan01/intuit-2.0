import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../domain/errors.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  error: Omit<ErrorBody['error'], 'requestId'>,
) {
  const body: ErrorBody = { error: { ...error, requestId: request.id } };
  return reply.status(status).send(body);
}

/** Maps framework-level client errors to stable codes with generic messages. */
function frameworkClientError(error: FastifyError): { code: string; message: string } {
  switch (error.code) {
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Requests must be sent as application/json.',
      };
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' };
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { code: 'MALFORMED_REQUEST', message: 'The request body is not valid JSON.' };
    default:
      return { code: 'BAD_REQUEST', message: 'The request could not be processed.' };
  }
}

/**
 * Consistent error responses. Internal details (stack traces, SQL, driver messages)
 * are logged server-side only and never returned to clients.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.error({ err: error }, 'Application error');
      if (error.details?.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(error.details.retryAfterSeconds));
      }
      const details = error.details?.issues ? { issues: error.details.issues } : undefined;
      return send(reply, request, error.status, {
        code: error.code,
        message: error.message,
        ...(details ? { details } : {}),
      });
    }

    const statusCode = (error as FastifyError).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      request.log.info({ code: (error as FastifyError).code }, 'Rejected client request');
      return send(reply, request, statusCode, frameworkClientError(error as FastifyError));
    }

    request.log.error({ err: error }, 'Unhandled error');
    return send(reply, request, 500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, request, 404, {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
    }),
  );
}
