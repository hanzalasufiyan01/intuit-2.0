/**
 * Public contract of the payroll module (FP-25, migration 0066): employees, pay components, pay
 * runs and payslips, the pure payslip calculation and the payroll permissions. It knows nothing
 * about the ledger; the application layer posts runs through accounting events.
 */
export * from './adjustments.js';
export * from './calculation.js';
export * from './data.js';
export * from './extra.js';
export * from './history.js';
export * from './permissions.js';
export { payrollRunStatuses } from './schema.js';
export type { PayrollRunStatus } from './schema.js';
