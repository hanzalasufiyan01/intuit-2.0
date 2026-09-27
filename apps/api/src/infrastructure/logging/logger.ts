import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../config/config.js';

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
    ...(stream ? { stream } : {}),
  };
}
