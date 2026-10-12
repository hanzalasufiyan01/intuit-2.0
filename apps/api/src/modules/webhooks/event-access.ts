import type { PublicResourceType } from '../public-events/index.js';

/**
 * The read permission behind each event family (ADR 0011 section 19.6): a subscription to an event
 * type needs BOTH the acting person and the integration to hold the read permission of the
 * resource, and the integration is re-checked at fan-out and at delivery.
 *
 * `null` means the frozen v1 scope catalog has no read scope for that resource (customers,
 * vendors, invoices and bills only), so no integration can hold its read permission and the type
 * cannot be subscribed to yet. Events of those types are still emitted (ADR section 23); they
 * become deliverable when a read scope is added (additive).
 */
export const RESOURCE_READ_PERMISSION: Record<PublicResourceType, string | null> = {
  customer: 'customers.view',
  vendor: 'vendors.view',
  invoice: 'invoices.view',
  bill: 'bills.view',
  item: null,
  credit_note: null,
  receipt: null,
  customer_refund: null,
  vendor_credit: null,
  vendor_payment: null,
  vendor_refund: null,
  expense_claim: null,
};

export function readPermissionOfEvent(eventType: string): string | null {
  const resource = eventType.slice(0, eventType.indexOf('.')) as PublicResourceType;
  return RESOURCE_READ_PERMISSION[resource] ?? null;
}

/** The resources whose public DTO can be placed in a `full` payload. */
export const FULL_MODE_RESOURCES: readonly PublicResourceType[] = [
  'customer',
  'vendor',
  'invoice',
  'bill',
];
