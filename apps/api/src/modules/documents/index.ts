/**
 * Public contract of the shared document engine (Phase 4 P4-04). Pure, exact-decimal rules used
 * by Sales and Purchases documents alike: totals, discounts and per-line tax; due dates;
 * settlement (relieved base, source base, realized FX); the document journal builder and the
 * dimension merge. No tables and no database access.
 */
export * from './attribution.js';
export * from './calculation.js';
export * from './numbering.js';
export * from './posting.js';
export * from './settlement.js';
