/**
 * Public contract of the public-events module: the frozen Public API event catalog and the
 * transactional emission of public events into the outbox (ADR 0011 section 11).
 */
export * from './catalog.js';
export * from './publish.js';
