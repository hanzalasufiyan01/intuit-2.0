import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Clinic permissions (ADR 0013): sensitive, owners and administrators only. Opening a patient
 * record needs `clinic.patients.view` and is audited.
 */
export const ClinicPermissions = {
  PatientsView: 'clinic.patients.view',
  PatientsManage: 'clinic.patients.manage',
  AppointmentsManage: 'clinic.appointments.manage',
  BillingCreate: 'clinic.billing.create',
  ReportsView: 'clinic.reports.view',
} as const;

export const clinicPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: ClinicPermissions.PatientsView,
    module: 'clinic',
    description: 'View patient records (every view is audited)',
  },
  {
    key: ClinicPermissions.PatientsManage,
    module: 'clinic',
    description: 'Create, edit and anonymize patients, services and practitioners',
  },
  {
    key: ClinicPermissions.AppointmentsManage,
    module: 'clinic',
    description: 'Book, move, check in, complete and cancel appointments',
  },
  {
    key: ClinicPermissions.BillingCreate,
    module: 'clinic',
    description: 'Create draft invoices from completed appointments',
  },
  { key: ClinicPermissions.ReportsView, module: 'clinic', description: 'View clinic reports' },
];
