import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../config/config.js';

/** Replaces the values of token-like query parameters in a logged URL. */
export function redactQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
}

/** Minimal log destination (pino-compatible). */
export interface LogDestination {
  write(line: string): void;
}

/**
 * Structured JSON logging. Secrets are redacted even if a header or field is logged by
 * mistake; request bodies (passwords, tokens) are never logged by default serializers.
 */
export function loggerOptions(
  config: AppConfig,
  stream?: LogDestination,
): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level: config.logLevel,
    base: { service: 'intuit2-api', env: config.appEnv },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.newPassword',
        '*.token',
        '*.passwordHash',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      // Signed download tokens travel in the query string (/files/content?token=); never log them.
      req: (request: { method: string; url: string; id: string }) => ({
        id: request.id,
        method: request.method,
        url: redactQuery(request.url) ?? '',
      }),
    },
    ...(stream ? { stream } : {}),
  };
}
