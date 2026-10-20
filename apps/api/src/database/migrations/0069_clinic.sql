-- 0069_clinic — clinic extension v1 (FP-27, ADR 0013): patients, services, practitioners,
-- appointments and billing of completed appointments into draft sales invoices.
--
-- Administrative and billing data ONLY: no clinical notes, diagnoses, prescriptions or results are
-- stored (ADR 0013). The module is off until an administrator enables it for the organization
-- (0065); its permissions go to owners and administrators only. A patient is never deleted:
-- anonymization clears the personal fields for good while appointments and invoices stay.

INSERT INTO permissions (key, module, description) VALUES
  ('clinic.patients.view', 'clinic', 'View patient records (every view is audited)'),
  ('clinic.patients.manage', 'clinic', 'Create, edit and anonymize patients, services and practitioners'),
  ('clinic.appointments.manage', 'clinic', 'Book, move, check in, complete and cancel appointments'),
  ('clinic.billing.create', 'clinic', 'Create draft invoices from completed appointments'),
  ('clinic.reports.view', 'clinic', 'View clinic reports')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE clinic_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO clinic_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('clinic.patients.view'), ('clinic.patients.manage'), ('clinic.appointments.manage'),
  ('clinic.billing.create'), ('clinic.reports.view')
) AS p (key);

CREATE TEMPORARY TABLE clinic_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN clinic_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO clinic_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0069_clinic',
       jsonb_build_object(
         'reason', 'Clinic permission backfill for existing organizations',
         'roleName', r.name,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM clinic_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name;

CREATE TABLE clinic_number_sequences (
  organization_id  uuid NOT NULL REFERENCES accounting_settings (organization_id),
  document_type    text NOT NULL CHECK (document_type IN ('patient', 'appointment')),
  prefix           text NOT NULL DEFAULT '' CHECK (length(prefix) <= 10),
  min_digits       integer NOT NULL DEFAULT 5 CHECK (min_digits BETWEEN 1 AND 12),
  next_number      bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE clinic_patients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number                text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  display_name          text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  date_of_birth         date,
  sex                   text CHECK (sex IS NULL OR sex IN ('female', 'male', 'other', 'undisclosed')),
  phone                 text CHECK (phone IS NULL OR length(phone) <= 40),
  email                 text CHECK (email IS NULL OR length(email) <= 320),
  -- Sensitive: never returned in full (masked to its last characters).
  national_id           text CHECK (national_id IS NULL OR length(national_id) <= 40),
  -- Who is billed for this patient's appointments (the patient themself or a payer).
  billing_customer_id   uuid,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ANONYMIZED')),
  anonymized_at         timestamptz,
  anonymized_by_user_id uuid REFERENCES users (id),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id    uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  updated_by_user_id    uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT clinic_patients_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT clinic_patients_customer_fkey FOREIGN KEY (billing_customer_id, organization_id)
    REFERENCES customers (id, organization_id),
  CONSTRAINT clinic_patients_anonymized CHECK (
    (status = 'ANONYMIZED') = (anonymized_at IS NOT NULL)
    AND (status <> 'ANONYMIZED' OR (date_of_birth IS NULL AND phone IS NULL AND email IS NULL
                                    AND national_id IS NULL AND billing_customer_id IS NULL)))
);
CREATE UNIQUE INDEX clinic_patients_number_idx ON clinic_patients (organization_id, number);
CREATE INDEX clinic_patients_name_idx ON clinic_patients (organization_id, lower(display_name));

CREATE TABLE clinic_services (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  sales_item_id       uuid,
  price               numeric(28, 4) NOT NULL CHECK (price >= 0),
  duration_minutes    integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT clinic_services_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT clinic_services_item_fkey FOREIGN KEY (sales_item_id, organization_id)
    REFERENCES sales_items (id, organization_id)
);

CREATE TABLE clinic_practitioners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  specialty           text NOT NULL DEFAULT '' CHECK (length(specialty) <= 100),
  user_id             uuid REFERENCES users (id),
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT clinic_practitioners_id_organization_key UNIQUE (id, organization_id)
);

CREATE TABLE clinic_appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  patient_id          uuid NOT NULL,
  practitioner_id     uuid NOT NULL,
  service_id          uuid NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'BOOKED'
                        CHECK (status IN ('BOOKED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  -- Administrative note (for example "bring previous reports"); never clinical content.
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  -- Frozen from the service when the appointment is booked.
  price               numeric(28, 4) NOT NULL CHECK (price >= 0),
  cancel_reason       text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  invoice_id          uuid,
  billed_at           timestamptz,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT clinic_appointments_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT clinic_appointments_patient_fkey FOREIGN KEY (patient_id, organization_id)
    REFERENCES clinic_patients (id, organization_id),
  CONSTRAINT clinic_appointments_practitioner_fkey FOREIGN KEY (practitioner_id, organization_id)
    REFERENCES clinic_practitioners (id, organization_id),
  CONSTRAINT clinic_appointments_service_fkey FOREIGN KEY (service_id, organization_id)
    REFERENCES clinic_services (id, organization_id),
  CONSTRAINT clinic_appointments_times CHECK (ends_at > starts_at),
  CONSTRAINT clinic_appointments_billed CHECK ((invoice_id IS NULL) = (billed_at IS NULL)),
  CONSTRAINT clinic_appointments_billing_status CHECK (invoice_id IS NULL OR status = 'COMPLETED'),
  CONSTRAINT clinic_appointments_cancel_reason CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX clinic_appointments_number_idx ON clinic_appointments (organization_id, number);
CREATE INDEX clinic_appointments_day_idx ON clinic_appointments (organization_id, starts_at);
CREATE INDEX clinic_appointments_patient_idx ON clinic_appointments (organization_id, patient_id, starts_at);
-- One draft invoice per appointment, and an invoice belongs to one appointment.
CREATE UNIQUE INDEX clinic_appointments_invoice_idx ON clinic_appointments (organization_id, invoice_id)
  WHERE invoice_id IS NOT NULL;

-- A practitioner is never double-booked: serialized on the practitioner row, checked in the database.
CREATE FUNCTION clinic_guard_appointment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appointments are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('CANCELLED', 'NO_SHOW') THEN
      RAISE EXCEPTION '% appointment % is final', lower(OLD.status), OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD.status = 'BOOKED' AND NEW.status IN ('BOOKED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'))
      OR (OLD.status = 'CHECKED_IN' AND NEW.status IN ('CHECKED_IN', 'COMPLETED', 'CANCELLED'))
      OR (OLD.status = 'COMPLETED' AND NEW.status = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'appointment % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'COMPLETED' AND (
         NEW.patient_id, NEW.practitioner_id, NEW.service_id, NEW.starts_at, NEW.ends_at, NEW.price)
       IS DISTINCT FROM (
         OLD.patient_id, OLD.practitioner_id, OLD.service_id, OLD.starts_at, OLD.ends_at, OLD.price) THEN
      RAISE EXCEPTION 'a completed appointment % cannot change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
      RAISE EXCEPTION 'appointment % was already billed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IN ('BOOKED', 'CHECKED_IN') THEN
    PERFORM 1 FROM clinic_practitioners
      WHERE id = NEW.practitioner_id AND organization_id = NEW.organization_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM clinic_appointments a
       WHERE a.organization_id = NEW.organization_id
         AND a.practitioner_id = NEW.practitioner_id
         AND a.id <> NEW.id
         AND a.status IN ('BOOKED', 'CHECKED_IN')
         AND a.starts_at < NEW.ends_at AND a.ends_at > NEW.starts_at) THEN
      RAISE EXCEPTION 'the practitioner is already booked at that time'
        USING ERRCODE = 'exclusion_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinic_appointments_guard BEFORE INSERT OR UPDATE OR DELETE ON clinic_appointments
  FOR EACH ROW EXECUTE FUNCTION clinic_guard_appointment();

-- An anonymized patient stays anonymized, and patients are never deleted.
CREATE FUNCTION clinic_guard_patient() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'patients are never deleted (%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ANONYMIZED' THEN
    RAISE EXCEPTION 'anonymized patient % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinic_patients_guard BEFORE UPDATE OR DELETE ON clinic_patients
  FOR EACH ROW EXECUTE FUNCTION clinic_guard_patient();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinic_number_sequences', 'clinic_patients', 'clinic_services', 'clinic_practitioners',
    'clinic_appointments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO intuit_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
