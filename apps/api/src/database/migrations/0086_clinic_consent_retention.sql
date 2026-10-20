-- 0086_clinic_consent_retention — consent register and retention setting for the clinic extension
-- (FP-27, ADR 0013 addendum, decisions given by the business owner on 2026-10-19).
--
-- Consent: an append-only register per patient. The WORDING IS ENTERED BY THE ORGANIZATION; the
-- system supplies no legal text. It holds no personal data beyond the link to the patient row, so
-- it stays intact when a patient is anonymized. Recording consent has no automatic effect on any
-- other feature (nothing is gated).
--
-- Retention: the organization enters the number of years it must keep patient records. There is
-- NO default. The system only lists patients with no activity for longer than that period so that
-- an authorized person can anonymize them by hand; nothing is removed automatically.

CREATE TABLE clinic_consent_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES accounting_settings (organization_id),
  patient_id           uuid NOT NULL,
  purpose              text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 200),
  -- The organization's own wording at the time (a version of the consent text).
  wording              text NOT NULL DEFAULT '' CHECK (length(wording) <= 4000),
  action               text NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  effective_date       date NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES users (id),
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT clinic_consent_events_patient_fkey FOREIGN KEY (patient_id, organization_id)
    REFERENCES clinic_patients (id, organization_id),
  CONSTRAINT clinic_consent_events_wording CHECK (action = 'withdrawn' OR length(btrim(wording)) >= 1)
);
CREATE INDEX clinic_consent_events_patient_idx
  ON clinic_consent_events (organization_id, patient_id, recorded_at, id);

CREATE TABLE clinic_settings (
  organization_id     uuid PRIMARY KEY REFERENCES accounting_settings (organization_id),
  -- NULL = not set yet (no review list is produced). No default is assumed.
  retention_years     integer CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 100),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinic_consent_events', 'clinic_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (organization_id = app_current_organization_id())
                      WITH CHECK (organization_id = app_current_organization_id())',
                   t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT ON clinic_consent_events TO intuit_app;
GRANT SELECT, INSERT, UPDATE ON clinic_settings TO intuit_app;
CREATE TRIGGER clinic_consent_events_append_only BEFORE UPDATE OR DELETE ON clinic_consent_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
