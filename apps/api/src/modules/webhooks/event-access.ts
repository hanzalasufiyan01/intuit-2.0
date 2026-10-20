import type { PublicResourceType } from '../public-events/index.js';

/**
 * The read permission behind each event family (ADR 0011 section 19.6): a subscription to an event
 * type needs BOTH the acting person and the integration to hold the read permission of the
 * resource, and the integration is re-checked at fan-out and at delivery.
 *
 * `null` means the scope catalog has no read scope for that resource (only `item`, until
 * `items:read` is decided; ADR 0011 section 25.8), so no integration can hold its read permission
 * and the type cannot be subscribed to. Events of those types are still emitted (ADR section 23).
 * The credit note, receipt, refund, vendor credit, vendor payment and expense claim families became
 * subscribable with the five scopes of CR-0011-S6-01 (section 25.4); customer refunds use
 * `receipts.view` and vendor refunds `vendor_payments.view`. Those families have no Public API read
 * endpoint: their events are always delivered thin (see `FULL_MODE_RESOURCES`).
 */
export const RESOURCE_READ_PERMISSION: Record<PublicResourceType, string | null> = {
  customer: 'customers.view',
  vendor: 'vendors.view',
  invoice: 'invoices.view',
  bill: 'bills.view',
  item: null,
  credit_note: 'credit_notes.view',
  receipt: 'receipts.view',
  customer_refund: 'receipts.view',
  vendor_credit: 'vendor_credits.view',
  vendor_payment: 'vendor_payments.view',
  vendor_refund: 'vendor_payments.view',
  expense_claim: 'expense_claims.view',
};

export function readPermissionOfEvent(eventType: string): string | null {
  const resource = eventType.slice(0, eventType.indexOf('.')) as PublicResourceType;
  return RESOURCE_READ_PERMISSION[resource] ?? null;
}

/** The `resource_type` of a `webhook.ping` delivery (it names the endpoint, not a business resource). */
export const PING_RESOURCE_TYPE = 'webhook_endpoint';

/**
 * Who may SEE a delivery in the history (ADR 0011 section 25.2, CR-0011-S6-01): a person holding at
 * least one of the permissions of the delivery's family. This is the viewer side; the integration
 * side (what may be subscribed to and delivered) is `RESOURCE_READ_PERMISSION` above. `webhook.ping`
 * deliveries are visible to every `webhooks.view` holder. Vendor refunds follow the family-level
 * `vendor_payments.view` as approved (the internal refund screen additionally guards refunds funded
 * from a vendor credit with `vendor_credits.view`; the history does not).
 */
export const VIEWER_READ_PERMISSIONS: Record<PublicResourceType, readonly string[]> = {
  customer: ['customers.view'],
  vendor: ['vendors.view'],
  invoice: ['invoices.view'],
  bill: ['bills.view'],
  credit_note: ['credit_notes.view'],
  receipt: ['receipts.view'],
  customer_refund: ['receipts.view'],
  vendor_credit: ['vendor_credits.view'],
  vendor_payment: ['vendor_payments.view'],
  vendor_refund: ['vendor_payments.view'],
  expense_claim: ['expense_claims.view'],
  item: ['invoices.view', 'bills.view', 'catalog.items.manage', 'sales.items.manage'],
};

/**
 * The delivery `resource_type` values a person may see, given their permission check. Always
 * includes the ping type; a family appears only if the person holds one of its permissions.
 */
export function visibleDeliveryResourceTypes(holds: (permission: string) => boolean): string[] {
  return [
    PING_RESOURCE_TYPE,
    ...(Object.entries(VIEWER_READ_PERMISSIONS) as [string, readonly string[]][])
      .filter(([, permissions]) => permissions.some((permission) => holds(permission)))
      .map(([resource]) => resource),
  ];
}

/**
 * The resources whose public DTO can be placed in a `full` payload: the ones with a Public API read
 * endpoint. Every other family is delivered thin even to a `full` endpoint (section 25.5).
 */
export const FULL_MODE_RESOURCES: readonly PublicResourceType[] = [
  'customer',
  'vendor',
  'invoice',
  'bill',
];
