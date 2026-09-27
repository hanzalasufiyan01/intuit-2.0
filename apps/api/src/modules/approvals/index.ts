/**
 * Public contract of the approvals module: the reusable Authority & Approval framework.
 * Other modules (accounting today; payments, payroll, permission changes later) use it
 * instead of building their own approval mechanisms.
 */
export * from './approvals.js';
export * from './permissions.js';
export type { ApprovalRequestStatus, PolicySnapshot, PolicySnapshotStep } from './schema.js';
