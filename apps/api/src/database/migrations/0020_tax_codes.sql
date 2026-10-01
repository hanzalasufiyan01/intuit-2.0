-- 0020_tax_codes — Phase 3B step 1: tax codes with effective-dated rate versions.
-- Decisions D1, 15, 31, 32, 33, 44, 60; Phase 3B D4 (ADR 0003).
--
-- * A tax code (e.g. GST) posts to its tax payable account. Its rate comes from versions, each
--   effective from a date until the next version starts; the version in effect on a document's
--   date applies, and documents snapshot the rate they used (Decision 15).
-- * Versions are append-only: a correction is a new version (or removing a version nothing uses).
-- * Maldives localization seed (Decisions 44, 60; Phase 3B D4): General GST 8% from 2023-01-01,
--   Tourism GST 16% from 2023-01-01 and 17% from 2025-07-01, mapped to account 2130. The seeded
--   versions are editable configuration and are marked for MIRA verification before production.

CREATE TABLE tax_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES accounting_settings (organization_id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  tax_account_id      uuid NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- NULL: created by the system (localization seed).
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT tax_codes_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT tax_codes_code_key UNIQUE (organization_id, code),
  CONSTRAINT tax_codes_account_fkey FOREIGN KEY (tax_account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);

CREATE TABLE tax_code_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  tax_code_id         uuid NOT NULL,
  -- Percentage, e.g. 8.0000 for 8%.
  rate                numeric(7, 4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  effective_from      date NOT NULL,
  -- Set on seeded data that must be verified against the tax authority before production use.
  verification_note   text CHECK (length(verification_note) <= 300),
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  CONSTRAINT tax_code_rates_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT tax_code_rates_code_fkey FOREIGN KEY (tax_code_id, organization_id)
    REFERENCES tax_codes (id, organization_id),
  CONSTRAINT tax_code_rates_version_key UNIQUE (tax_code_id, effective_from)
);
CREATE INDEX tax_code_rates_lookup_idx ON tax_code_rates (organization_id, tax_code_id, effective_from DESC);

-- Versions never change; a mistake is corrected with a new version (Decision 15).
CREATE TRIGGER tax_code_rates_no_update
  BEFORE UPDATE ON tax_code_rates
  FOR EACH ROW EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER tax_code_rates_no_truncate
  BEFORE TRUNCATE ON tax_code_rates
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER tax_codes_no_truncate
  BEFORE TRUNCATE ON tax_codes
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- Codes are archived, never deleted.
CREATE FUNCTION tax_guard_code() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax codes are archived, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.code, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.code, OLD.created_at) THEN
    RAISE EXCEPTION 'tax code % identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tax_codes_guard
  BEFORE UPDATE OR DELETE ON tax_codes
  FOR EACH ROW EXECUTE FUNCTION tax_guard_code();

ALTER TABLE tax_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_code_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_codes_tenant ON tax_codes FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY tax_code_rates_tenant ON tax_code_rates FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON tax_codes, tax_code_rates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON tax_codes TO intuit_app;
-- DELETE: only an unused version (documents referencing it block the delete).
GRANT SELECT, INSERT, DELETE ON tax_code_rates TO intuit_app;

-- ---------------------------------------------------------------------------
-- Maldives localization seed for existing organizations (Decisions 44, 60; Phase 3B D4)
-- ---------------------------------------------------------------------------

WITH targets AS (
  SELECT s.organization_id, a.id AS account_id
    FROM accounting_settings s
    JOIN accounting_accounts a
      ON a.organization_id = s.organization_id AND a.code = '2130' AND a.account_type = 'LIABILITY'
     AND a.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM accounting_accounts c
                      WHERE c.parent_id = a.id AND c.organization_id = a.organization_id)
   WHERE s.coa_template_key = 'maldives'
),
codes AS (
  INSERT INTO tax_codes (organization_id, code, name, description, tax_account_id, created_at, updated_at)
  SELECT t.organization_id, c.code, c.name, c.description, t.account_id, now(), now()
    FROM targets t
   CROSS JOIN (VALUES
     ('GST', 'General GST', 'Maldives general goods and services tax.'),
     ('TGST', 'Tourism GST', 'Maldives tourism goods and services tax.')
   ) AS c (code, name, description)
  ON CONFLICT (organization_id, code) DO NOTHING
  RETURNING id, organization_id, code
)
INSERT INTO tax_code_rates (organization_id, tax_code_id, rate, effective_from, verification_note, created_at)
SELECT c.organization_id, c.id, v.rate, v.effective_from,
       'Seeded from the Maldives localization; verify against MIRA before production use.', now()
  FROM codes c
  JOIN (VALUES
    ('GST', 8.0000::numeric, DATE '2023-01-01'),
    ('TGST', 16.0000::numeric, DATE '2023-01-01'),
    ('TGST', 17.0000::numeric, DATE '2025-07-01')
  ) AS v (code, rate, effective_from) ON v.code = c.code;
