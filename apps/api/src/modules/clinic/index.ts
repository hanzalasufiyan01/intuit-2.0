/**
 * Public contract of the clinic module (FP-27, migration 0069, ADR 0013): patients, services,
 * practitioners and appointments with their permissions. Administrative and billing data only.
 */
export * from './consent.js';
export * from './data.js';
export * from './permissions.js';
export { appointmentStatuses, sexValues } from './schema.js';
export type { AppointmentStatus } from './schema.js';
