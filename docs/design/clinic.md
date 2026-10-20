# Design: clinic extension (FP-27)

Status: design only; no ADR approved. Health data is sensitive, so the design is deliberately narrow: **administrative and billing data only**; clinical notes are not stored unless explicitly approved.

## Scope (from the brief)

Patients, appointments, services, billing to an invoice, separate permissions and audit.

## Data model

- `clinic_patients`: id, number, party id (reuses Contacts so a patient can be a customer), date of birth, sex, contact person, notes limited to administrative text. National id optional and masked.
- `clinic_services`: a catalog entry linked to a sales item (name, default price, duration).
- `clinic_practitioners`: user link, specialty label, working hours.
- `clinic_appointments`: patient, practitioner, start/end, status (`BOOKED | CHECKED_IN | COMPLETED | CANCELLED | NO_SHOW`), services, version; overlap check per practitioner enforced in the database with an exclusion constraint on a time range.
- `clinic_visits`: completed appointment → billable lines; "Bill visit" creates a draft sales invoice (customer = the patient's customer party or a guarantor), idempotent per visit (unique link).

## Security and privacy

Module disabled by default (per-organization module switch). Permissions: `clinic.patients.view/manage`, `clinic.appointments.manage`, `clinic.billing.create`, `clinic.reports.view`; every patient record read is audited (view events), not only changes. Patient data is excluded from the Public API and webhooks unless a scope is added explicitly. Export requires step-up. Retention and erasure rules are an open decision.

## Reports

Appointments by practitioner/day, no-show rate, revenue by service, unbilled visits.

## Open decisions

Whether clinical notes or prescriptions are in scope (proposed: no); insurance/third-party payer billing; consent records; legal retention period; patient portal.
