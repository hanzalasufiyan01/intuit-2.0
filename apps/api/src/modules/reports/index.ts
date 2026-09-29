/**
 * Public contract of the reports module: pure financial-statement composition (Trial Balance,
 * Profit & Loss, Balance Sheet) over the accounting module's aggregated balances. It owns no
 * tables and never accesses the database (S3-04).
 */
export * from './balance-sheet.js';
export * from './engine.js';
export * from './profit-and-loss.js';
export * from './sections.js';
export * from './trial-balance.js';
