/**
 * Public contract of the payments module (migration 0075): gateway settings, payment intents and
 * the provider-event ledger, with their permissions. It knows nothing about receipts or the
 * ledger; the application layer records a receipt when a payment is confirmed.
 */
export * from './data.js';
export * from './permissions.js';
export { gatewayModes, intentStatuses } from './schema.js';
export type { GatewayMode, IntentStatus } from './schema.js';
