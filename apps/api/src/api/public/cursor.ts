import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CursorPosition } from '../../application/public-api-read-service.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * Opaque keyset cursors for the Public API (ADR 0011 section 7). A cursor names the last row of a
 * page by its creation timestamp (carried as text with full precision) and id; it is bound to the
 * resource, the organization and the filters of the request, and signed, so a cursor from another
 * resource, tenant or filter set, or one that was edited, is refused with `invalid_cursor`.
 * Pagination is never offset-based.
 */

interface Payload {
  v: 1;
  r: string;
  o: string;
  f: string;
  t: string;
  i: string;
}

const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`public-api-cursor:${body}`).digest('base64url');

/** A stable fingerprint of the filters a cursor belongs to. */
export function filterKey(filters: Record<string, string | undefined>): string {
  return Object.keys(filters)
    .filter((k) => filters[k] !== undefined)
    .sort()
    .map((k) => `${k}=${filters[k]}`)
    .join('&');
}

export function encodeCursor(
  secret: string,
  scope: { resource: string; organizationId: string; filters: string },
  position: CursorPosition,
): string {
  const payload: Payload = {
    v: 1,
    r: scope.resource,
    o: scope.organizationId,
    f: scope.filters,
    t: position.timestamp,
    i: position.id,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

const invalid = () =>
  new ValidationError([{ path: 'cursor', message: 'The cursor is not valid.' }], 'invalid_cursor');

export function decodeCursor(
  secret: string,
  scope: { resource: string; organizationId: string; filters: string },
  cursor: string,
): CursorPosition {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra !== undefined) throw invalid();
  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
  } catch {
    throw invalid();
  }
  if (
    payload.v !== 1 ||
    payload.r !== scope.resource ||
    payload.o !== scope.organizationId ||
    payload.f !== scope.filters ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(payload.t) ||
    !/^[0-9a-f-]{36}$/i.test(payload.i)
  ) {
    throw invalid();
  }
  return { timestamp: payload.t, id: payload.i };
}
