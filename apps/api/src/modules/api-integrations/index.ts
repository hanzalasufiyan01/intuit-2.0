/**
 * Public contract of the api-integrations module (ADR 0011): organization-owned API integrations
 * (each backed by a non-human service principal), their explicit scopes under the fixed platform
 * Public API policy, and their opaque tokens. No public API routes, rate limiting, DTOs or
 * webhooks live here.
 */
export * from './data.js';
export * from './permissions.js';
export * from './scopes.js';
export * from './token.js';
export { integrationStatuses } from './schema.js';
export type { IntegrationStatus } from './schema.js';
