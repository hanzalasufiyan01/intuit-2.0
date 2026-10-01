/**
 * Public contract of the tax module (Phase 3B): tax codes, effective-dated rates and the
 * calculation rules used by Sales. It never posts; Sales documents carry tax into their journals.
 */
export * from './calculation.js';
export * from './permissions.js';
export * from './tax-codes.js';
export { taxCodeStatuses } from './schema.js';
export type { TaxCodeStatus } from './schema.js';
