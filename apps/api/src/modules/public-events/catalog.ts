/**
 * The frozen Public API v1 event catalog (ADR 0011 section 11.2): 27 types. Event types are
 * immutable public contracts: types are only ever added, never renamed or removed. Events are
 * business-resource level only; journal-level and accounting-event events are never public.
 */

export const PUBLIC_EVENT_RESOURCES = {
  customer: ['created', 'updated', 'archived'],
  vendor: ['created', 'updated', 'archived'],
  item: ['created', 'updated', 'archived'],
  invoice: ['issued', 'voided'],
  credit_note: ['issued'],
  receipt: ['recorded', 'voided'],
  customer_refund: ['recorded', 'voided'],
  bill: ['posted', 'voided'],
  vendor_credit: ['posted', 'voided'],
  vendor_payment: ['recorded', 'voided'],
  vendor_refund: ['recorded', 'voided'],
  expense_claim: ['posted', 'voided'],
} as const;

export type PublicResourceType = keyof typeof PUBLIC_EVENT_RESOURCES;

type ActionOf<R extends PublicResourceType> = (typeof PUBLIC_EVENT_RESOURCES)[R][number];

/** Every event a domain operation can emit (`webhook.ping` is the test event, never emitted here). */
export type DomainPublicEventType = {
  [R in PublicResourceType]: `${R}.${ActionOf<R>}`;
}[PublicResourceType];

export const DOMAIN_PUBLIC_EVENT_TYPES: readonly DomainPublicEventType[] = (
  Object.entries(PUBLIC_EVENT_RESOURCES) as [PublicResourceType, readonly string[]][]
).flatMap(([resource, actions]) =>
  actions.map((action) => `${resource}.${action}` as DomainPublicEventType),
);

/** All 27 public event types, including the test event. */
export const PUBLIC_EVENT_TYPES: readonly string[] = [...DOMAIN_PUBLIC_EVENT_TYPES, 'webhook.ping'];

/**
 * The public read endpoint of a resource, which the thin event's `data.url` points to (ADR 0011
 * section 11.2). Only these resources can be retrieved through the Public API in v1; for every
 * other resource there is no retrieval endpoint (items have no `items:read`), so `url` is null.
 */
export const PUBLIC_READ_PATHS: Partial<Record<PublicResourceType, string>> = {
  customer: '/public/v1/customers',
  vendor: '/public/v1/vendors',
  invoice: '/public/v1/invoices',
  bill: '/public/v1/bills',
};

/** The outbox namespace: nothing existing subscribes to `public.*`. */
export const PUBLIC_OUTBOX_PREFIX = 'public.';
export const publicOutboxType = (type: string) => `${PUBLIC_OUTBOX_PREFIX}${type}`;

export const PUBLIC_API_VERSION = 'v1';
