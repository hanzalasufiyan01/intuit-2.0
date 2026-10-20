# ADR 0013: Clinic extension: privacy and access-control decisions

Status: **ACCEPTED LOCALLY as safest-default** (2026-10-17). These are conservative, reversible defaults chosen so the clinic extension can be built without storing more sensitive data than the product needs. The business owner must still confirm them (and any legal retention period) before real patient data is entered. Nothing here is legal advice.

## Decisions

1. **Scope of data: administrative and billing only.** The extension stores who the patient is, appointments and the services billed. It stores **no clinical notes, diagnoses, prescriptions, images or test results**. Adding any of them needs a new ADR.
2. **Module off by default**, switched on per organization by an administrator (migration 0065 switch), audited.
3. **Separate permissions**, granted to Owner and Administrator only: `clinic.patients.view`, `clinic.patients.manage`, `clinic.appointments.manage`, `clinic.billing.create`, `clinic.reports.view`. Ordinary members and accounting roles do not receive them.
4. **Reads are audited.** Opening a patient record writes `clinic.patient_viewed` (who, which patient, when, request id); listing patients writes `clinic.patients_listed` with a count. Changes are audited as for every other module. Audit metadata never contains the national id or contact details.
5. **Sensitive fields are masked** in lists and detail (national id shown by its last three characters), and are never placed in exports, URLs, logs or webhook payloads.
6. **Not exposed outside the web application.** No Public API scope and no webhook event exists for clinic data; adding one needs a new ADR.
7. **Erasure is anonymization, not deletion.** An authorized user can anonymize a patient: name, contact details, date of birth and national id are replaced or cleared and cannot be restored. The patient row, its appointments and any invoice stay, so the books remain intact. A legal-hold or retention period set by the business owner is an open input; until it is given, anonymization is allowed.
8. **Billing reuses Sales.** Billing a completed appointment creates a **draft** sales invoice for a chosen customer (the patient themself or a payer), once per appointment. Invoice lines carry only the service name and price, not the patient's name, unless the organization sets the customer to the patient.
9. **No patient portal**, no automatic messages to patients.

## Open inputs for the business owner

Legal retention period for patient administrative records; whether insurers or third-party payers are billed; consent wording; whether clinical notes will ever be kept in this system.

## Addendum (2026-10-19): decisions given by the business owner

1. **Consent**: a per-patient register (migration 0086). The organization enters the purpose and the wording; the system supplies no legal text. Entries are append-only (granted/withdrawn with an effective date and who recorded it), audited without names or wording, kept when a patient is anonymized, and have no automatic effect on any other feature.
2. **Retention**: the organization enters the number of years (no default). The system lists active patients with no activity for longer than that and an authorized person anonymizes them by hand. Nothing is removed automatically; listing is audited.
3. **Third-party payers**: not in scope. Billing stays patient or chosen guarantor customer.
4. **Patient access**: none. Staff only.
   Still open and the owner's to give: the legal retention period, the consent wording, any clinical notes (new ADR).
