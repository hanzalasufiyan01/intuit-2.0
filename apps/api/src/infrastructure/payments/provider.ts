/**
 * Provider-neutral payment gateway contract. The application never talks to a payment provider
 * except through this interface, so a real provider is one more implementation. Only `mock` exists
 * today and it is a simulation: it never moves money. A real provider is NOT configured anywhere.
 */

export type ProviderChargeStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface CreateChargeInput {
  /** Our intent id; also the provider-side idempotency key, so a retry never double-creates. */
  intentId: string;
  /** Decimal string in the currency's minor-unit precision. */
  amount: string;
  currencyCode: string;
  description: string;
}

export interface ProviderCharge {
  providerRef: string;
  /** Where the customer completes the payment (the provider hosted page). */
  checkoutUrl: string;
}

/** What the provider reports about a charge when asked directly (reconciliation). */
export interface ProviderChargeState {
  status: ProviderChargeStatus;
  amount: string | null;
  currencyCode: string | null;
  failureCode: string | null;
}

export type ProviderEventType = 'charge.succeeded' | 'charge.failed' | 'charge.cancelled';

/** A webhook after its signature was verified. */
export interface ProviderEvent {
  /** Provider-assigned, unique per event: the duplicate-delivery key. */
  id: string;
  type: ProviderEventType;
  providerRef: string;
  amount: string | null;
  currencyCode: string | null;
  failureCode: string | null;
}

export type WebhookVerification =
  { valid: true; event: ProviderEvent } | { valid: false; reason: string };

export interface PaymentProvider {
  /** Stable key stored on intents and events. */
  readonly key: 'mock';
  /** Whether this provider moves real money. */
  readonly mode: 'mock' | 'live';
  createCharge(input: CreateChargeInput): Promise<ProviderCharge>;
  /** Cancels a charge that has not been paid. Resolves to the charge state afterwards. */
  cancelCharge(providerRef: string): Promise<ProviderChargeState>;
  /** The provider's own view of a charge. Authoritative: webhooks are confirmed against it. */
  retrieveCharge(providerRef: string): Promise<ProviderChargeState>;
  /**
   * Verifies the signature over the RAW request body (never a re-serialisation) and parses it.
   * Implementations compare in constant time and reject anything malformed.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookVerification;
}
