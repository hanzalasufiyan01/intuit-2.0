-- 0065_organization_modules — optional product modules are switched on per organization (FP-24).
--
-- Payroll, projects and the clinic extension handle sensitive data and are OFF until an
-- administrator enables them for the organization. A missing row means "off". The switch is
-- enforced by the application layer for every operation of the module (`withOrganization` with a
-- `module` option), shown in the interface, and audited. Existing modules (accounting, sales,
-- purchases, banking, inventory, fixed assets, expense claims) are not switchable: they are part
-- of every organization.

CREATE TABLE organization_modules (
  organization_id    uuid NOT NULL REFERENCES organizations (id),
  module_key         text NOT NULL CHECK (module_key IN ('payroll', 'projects', 'clinic')),
  enabled            boolean NOT NULL,
  changed_by_user_id uuid REFERENCES users (id),
  changed_at         timestamptz NOT NULL,
  PRIMARY KEY (organization_id, module_key)
);

ALTER TABLE organization_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_modules_tenant ON organization_modules FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON organization_modules FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON organization_modules TO intuit_app;
CREATE TRIGGER organization_modules_no_truncate BEFORE TRUNCATE ON organization_modules
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
