import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CreateChargeInput,
  PaymentProvider,
  ProviderCharge,
  ProviderChargeState,
  ProviderEvent,
  ProviderEventType,
  WebhookVerification,
} from './provider.js';

/**
 * A deterministic simulated provider for development and tests. It holds charges in memory,
 * derives references from the intent id, and signs webhooks with HMAC-SHA256 over the raw body
 * (`x-mock-signature: sha256=<hex>`), exactly the way a real provider would so the verification
 * path is the real one. It NEVER moves money and is refused in production unless explicitly
 * enabled by configuration.
 */

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

interface MockCharge {
  providerRef: string;
  amount: string;
  currencyCode: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  failureCode: string | null;
}

export const signMockPayload = (secret: string, rawBody: string) =>
  `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

const EVENT_TYPES: readonly ProviderEventType[] = [
  'charge.succeeded',
  'charge.failed',
  'charge.cancelled',
];

export class MockPaymentProvider implements PaymentProvider {
  readonly key = 'mock' as const;
  readonly mode = 'mock' as const;
  private readonly charges = new Map<string, MockCharge>();
  private failNext = false;

  constructor(
    private readonly webhookSecret: string,
    private readonly checkoutOrigin: string,
  ) {}

  createCharge(input: CreateChargeInput): Promise<ProviderCharge> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Simulated provider outage'));
    }
    // Deterministic and idempotent on the intent id.
    const providerRef = `mock_ch_${input.intentId.replaceAll('-', '').slice(0, 24)}`;
    if (!this.charges.has(providerRef)) {
      this.charges.set(providerRef, {
        providerRef,
        amount: input.amount,
        currencyCode: input.currencyCode,
        status: 'pending',
        failureCode: null,
      });
    }
    return Promise.resolve({
      providerRef,
      checkoutUrl: `${this.checkoutOrigin.replace(/\/$/, '')}/mock-pay/${providerRef}`,
    });
  }

  retrieveCharge(providerRef: string): Promise<ProviderChargeState> {
    const c = this.charges.get(providerRef);
    if (!c)
      return Promise.resolve({
        status: 'unknown',
        amount: null,
        currencyCode: null,
        failureCode: null,
      });
    return Promise.resolve({
      status: c.status,
      amount: c.amount,
      currencyCode: c.currencyCode,
      failureCode: c.failureCode,
    });
  }

  cancelCharge(providerRef: string): Promise<ProviderChargeState> {
    const c = this.charges.get(providerRef);
    if (c?.status === 'pending') c.status = 'cancelled';
    return this.retrieveCharge(providerRef);
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookVerification {
    const given = headers[MOCK_SIGNATURE_HEADER];
    if (!given) return { valid: false, reason: 'missing signature' };
    const expected = signMockPayload(this.webhookSecret, rawBody);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'signature mismatch' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: 'malformed payload' };
    }
    const p = parsed as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const id = str(p.id);
    const providerRef = str(p.providerRef);
    const type = str(p.type);
    if (!id || !providerRef || !type || !EVENT_TYPES.includes(type as ProviderEventType)) {
      return { valid: false, reason: 'malformed payload' };
    }
    const event: ProviderEvent = {
      id,
      type: type as ProviderEventType,
      providerRef,
      amount: str(p.amount),
      currencyCode: str(p.currencyCode),
      failureCode: str(p.failureCode),
    };
    return { valid: true, event };
  }

  // ---- Simulation controls (tests and the development checkout page only) ----------------------

  /**
   * Settles a charge on the simulated provider and returns the signed webhook delivery a real
   * provider would then send. Calling it again for an already-settled charge returns the same
   * event id (a duplicate delivery).
   */
  settle(
    providerRef: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    options: { failureCode?: string; amount?: string; eventId?: string } = {},
  ): { rawBody: string; headers: Record<string, string> } {
    const c = this.charges.get(providerRef);
    if (!c) throw new Error(`Unknown mock charge ${providerRef}`);
    if (c.status === 'pending') {
      c.status = outcome;
      c.failureCode = options.failureCode ?? null;
    }
    return this.delivery(c, options);
  }

  /** A signed delivery for a charge in its current state, with a stable or chosen event id. */
  delivery(
    chargeOrRef: MockCharge | string,
    options: { amount?: string; eventId?: string; failureCode?: string } = {},
  ) {
    const c = typeof chargeOrRef === 'string' ? this.charges.get(chargeOrRef) : chargeOrRef;
    if (!c) throw new Error('Unknown mock charge');
    const type: ProviderEventType =
      c.status === 'succeeded'
        ? 'charge.succeeded'
        : c.status === 'cancelled'
          ? 'charge.cancelled'
          : 'charge.failed';
    const rawBody = JSON.stringify({
      id: options.eventId ?? `mock_evt_${c.providerRef}_${c.status}`,
      type,
      providerRef: c.providerRef,
      amount: options.amount ?? c.amount,
      currencyCode: c.currencyCode,
      failureCode: options.failureCode ?? c.failureCode,
    });
    return {
      rawBody,
      headers: { [MOCK_SIGNATURE_HEADER]: signMockPayload(this.webhookSecret, rawBody) },
    };
  }

  /** A signed delivery that was never backed by a settled charge (to test confirmation). */
  forge(providerRef: string, type: ProviderEventType, amount: string, currencyCode: string) {
    const rawBody = JSON.stringify({
      id: `mock_evt_forged_${randomUUID()}`,
      type,
      providerRef,
      amount,
      currencyCode,
      failureCode: null,
    });
    return {
      rawBody,
      headers: { [MOCK_SIGNATURE_HEADER]: signMockPayload(this.webhookSecret, rawBody) },
    };
  }

  /** Test hook: the next createCharge fails, as during a provider outage. */
  failNextCreate() {
    this.failNext = true;
  }

  /** Test hook: forget a charge, as if the provider lost it. */
  forget(providerRef: string) {
    this.charges.delete(providerRef);
  }
}
