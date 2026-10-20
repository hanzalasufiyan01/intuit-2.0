-- 0084_branch_scopes — branch-scoped access (FP-24, docs/design/branches-legal-entities.md).
--
-- A branch is a dimension value (the accounting module already tags documents with them). A member
-- can be limited to a set of branches. The limit is enforced in the DATABASE, not in each service:
-- row-level security on sales invoices and purchase bills (and their lines) shows a restricted
-- session only documents whose header dimensions overlap its branches, and refuses to write any
-- other. The application sets the session's branch list (`app.branch_scope`) after it has
-- resolved the member's access; with no list (every other session, job and Public API request) the
-- extra predicate is true and nothing changes.
--
-- A restricted member also keeps only the permissions of a short allow-list (documents of those
-- two kinds, their master data and the dimension list); every other permission, and therefore every
-- report, ledger or payment screen, is removed for the duration of the restriction. Owners are never
-- restricted.

CREATE TABLE membership_branch_scopes (
  organization_id     uuid NOT NULL,
  membership_id       uuid NOT NULL,
  dimension_value_id  uuid NOT NULL,
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (membership_id, dimension_value_id),
  CONSTRAINT membership_branch_scopes_membership_fkey FOREIGN KEY (membership_id, organization_id)
    REFERENCES memberships (id, organization_id),
  CONSTRAINT membership_branch_scopes_value_fkey FOREIGN KEY (dimension_value_id, organization_id)
    REFERENCES accounting_dimension_values (id, organization_id)
);
CREATE INDEX membership_branch_scopes_org_idx ON membership_branch_scopes (organization_id, membership_id);

ALTER TABLE membership_branch_scopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_branch_scopes_tenant ON membership_branch_scopes FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON membership_branch_scopes FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON membership_branch_scopes TO intuit_app;
CREATE TRIGGER membership_branch_scopes_no_truncate BEFORE TRUNCATE ON membership_branch_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

-- The session's branch list: NULL when the session is not restricted.
CREATE FUNCTION app_branch_scope() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(current_setting('app.branch_scope', true), '') = ''
              THEN NULL
              ELSE string_to_array(current_setting('app.branch_scope', true), ',')::uuid[] END
$$;

-- A document is visible to a restricted session when its header dimensions include one of its branches.
CREATE FUNCTION app_branch_visible(dimension_ids uuid[]) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_branch_scope() IS NULL OR coalesce(dimension_ids, '{}'::uuid[]) && app_branch_scope()
$$;
GRANT EXECUTE ON FUNCTION app_branch_scope() TO intuit_app;
GRANT EXECUTE ON FUNCTION app_branch_visible(uuid[]) TO intuit_app;

DROP POLICY sales_invoices_tenant ON sales_invoices;
CREATE POLICY sales_invoices_tenant ON sales_invoices FOR ALL
  USING (organization_id = app_current_organization_id() AND app_branch_visible(dimension_value_ids))
  WITH CHECK (organization_id = app_current_organization_id() AND app_branch_visible(dimension_value_ids));

DROP POLICY purchases_bills_tenant ON purchases_bills;
CREATE POLICY purchases_bills_tenant ON purchases_bills FOR ALL
  USING (organization_id = app_current_organization_id() AND app_branch_visible(dimension_value_ids))
  WITH CHECK (organization_id = app_current_organization_id() AND app_branch_visible(dimension_value_ids));

DROP POLICY sales_invoice_lines_tenant ON sales_invoice_lines;
CREATE POLICY sales_invoice_lines_tenant ON sales_invoice_lines FOR ALL
  USING (organization_id = app_current_organization_id()
         AND (app_branch_scope() IS NULL OR EXISTS (
               SELECT 1 FROM sales_invoices i
                WHERE i.id = sales_invoice_lines.invoice_id AND i.organization_id = sales_invoice_lines.organization_id)))
  WITH CHECK (organization_id = app_current_organization_id()
         AND (app_branch_scope() IS NULL OR EXISTS (
               SELECT 1 FROM sales_invoices i
                WHERE i.id = sales_invoice_lines.invoice_id AND i.organization_id = sales_invoice_lines.organization_id)));

DROP POLICY purchases_bill_lines_tenant ON purchases_bill_lines;
CREATE POLICY purchases_bill_lines_tenant ON purchases_bill_lines FOR ALL
  USING (organization_id = app_current_organization_id()
         AND (app_branch_scope() IS NULL OR EXISTS (
               SELECT 1 FROM purchases_bills b
                WHERE b.id = purchases_bill_lines.bill_id AND b.organization_id = purchases_bill_lines.organization_id)))
  WITH CHECK (organization_id = app_current_organization_id()
         AND (app_branch_scope() IS NULL OR EXISTS (
               SELECT 1 FROM purchases_bills b
                WHERE b.id = purchases_bill_lines.bill_id AND b.organization_id = purchases_bill_lines.organization_id)));
