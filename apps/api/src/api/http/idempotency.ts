import type { FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError } from '../../domain/errors.js';
import { IDEMPOTENCY_KEY_PATTERN } from '../../modules/idempotency/index.js';

/** Reads the optional `Idempotency-Key` header (Decision 23); a malformed key is a 400. */
export function idempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ValidationError([
      {
        path: 'Idempotency-Key',
        message: 'Use 1–200 letters, digits or "_", ".", ":", "-" (for example a UUID).',
      },
    ]);
  }
  return value;
}

/** Marks a replayed response so clients can tell it apart from a first execution. */
export function markReplay(reply: FastifyReply, replayed: boolean): void {
  if (replayed) void reply.header('idempotent-replayed', 'true');
}
