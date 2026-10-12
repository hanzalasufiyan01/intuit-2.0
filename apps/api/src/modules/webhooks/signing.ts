import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing (ADR 0011 section 11.4). `v1 = HMAC-SHA256(secret, "<timestamp>.<delivery id>.<raw body>")`
 * with the timestamp in Unix seconds, refreshed on every attempt. During a secret rotation overlap
 * both signatures are sent (`v1=<new>,v1=<old>`). Consumers verify against the RAW body, compare in
 * constant time, reject timestamps older than the replay window and deduplicate on the event id.
 */

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signWebhook(
  secret: string,
  timestamp: number,
  deliveryId: string,
  rawBody: string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${rawBody}`).digest('hex');
}

/** The `Intuit-Webhook-Signature` header for one or two valid secrets (newest first). */
export function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  deliveryId: string,
  rawBody: string,
): string {
  return [
    `t=${timestamp}`,
    ...secrets.map((s) => `v1=${signWebhook(s, timestamp, deliveryId, rawBody)}`),
  ].join(',');
}

/** The reference verification a consumer performs (also used by the tests and the documentation). */
export function verifyWebhookSignature(input: {
  secret: string;
  header: string;
  deliveryId: string;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const parts = input.header.split(',').map((p) => p.trim());
  const timestamp = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  if (!Number.isInteger(timestamp)) return false;
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return false;
  const expected = Buffer.from(
    signWebhook(input.secret, timestamp, input.deliveryId, input.rawBody),
    'hex',
  );
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const given = Buffer.from(p.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
