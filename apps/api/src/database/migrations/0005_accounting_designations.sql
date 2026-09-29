-- Intuit 2.0 — Phase 3A, S1: system account designations (Decisions 14, 64).
--
-- One account per designation and organization. Existing organizations start undesignated and
-- designate required accounts explicitly before dependent features are used (no guessing); new
-- organizations receive the designations of their template. Changes are audited by the
-- application (accounting.designations_changed).

CREATE TABLE accounting_designations (
  organization_id    uuid NOT NULL REFERENCES accounting_settings (organization_id),
  designation        text NOT NULL CHECK (designation IN (
                       'RETAINED_EARNINGS', 'REALIZED_FX_GAIN_LOSS', 'UNREALIZED_FX_GAIN_LOSS',
                       'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY')),
  account_id         uuid NOT NULL,
  updated_by_user_id uuid NOT NULL REFERENCES users (id),
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (organization_id, designation),
  CONSTRAINT accounting_designations_account_fkey FOREIGN KEY (account_id, organization_id)
    REFERENCES accounting_accounts (id, organization_id)
);
CREATE INDEX accounting_designations_account_idx ON accounting_designations (organization_id, account_id);

-- Templates carry the Decision 64 designation mapping (3200, 3900, 4950, 4960, 5950), applied
-- when a new organization is set up from the template.
ALTER TABLE accounting_coa_template_accounts ADD COLUMN designation text CHECK (designation IN (
  'RETAINED_EARNINGS', 'REALIZED_FX_GAIN_LOSS', 'UNREALIZED_FX_GAIN_LOSS',
  'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY'));
CREATE UNIQUE INDEX accounting_coa_template_accounts_designation_idx
  ON accounting_coa_template_accounts (template_key, designation) WHERE designation IS NOT NULL;

ALTER TABLE accounting_designations ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_designations_tenant ON accounting_designations FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON accounting_designations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_designations TO intuit_app;
