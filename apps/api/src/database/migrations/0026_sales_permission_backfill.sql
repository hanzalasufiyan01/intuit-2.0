-- Intuit 2.0 — Phase 3B: Sales, customer and tax permission backfill for existing organizations
-- (ADR 0003 D14; Decisions 65, 90).
--
-- Organizations created before Phase 3B receive the new permissions on their system roles, as
-- the role templates now grant them to new organizations:
--   * Owner and Administrator: all 22 Sales, customer and tax permissions;
--   * Member: view only — customers.view, invoices.view, credit_notes.view, receipts.view and
--     sales.reports.view.
-- The migration grants the Owner itself (no dependence on the reference seed's Owner sync).
-- ADDITIVE ONLY: nothing is removed, custom roles are untouched, existing grants are kept
-- (ON CONFLICT DO NOTHING makes it idempotent). Every role that receives permissions gets an
-- append-only audit event.

INSERT INTO permissions (key, module, description) VALUES
  ('customers.view', 'customers', 'View customers'),
  ('customers.create', 'customers', 'Create customers'),
  ('customers.update', 'customers', 'Edit customers, including their contact and tax details'),
  ('customers.archive', 'customers', 'Archive and restore customers'),
  ('invoices.view', 'sales', 'View invoices'),
  ('invoices.create', 'sales', 'Create draft invoices'),
  ('invoices.edit_draft', 'sales', 'Edit draft invoices'),
  ('invoices.delete_draft', 'sales', 'Delete draft invoices'),
  ('invoices.issue', 'sales', 'Issue invoices (posts them to the ledger)'),
  ('invoices.void', 'sales', 'Void unpaid issued invoices'),
  ('invoices.approve', 'sales', 'Approve invoices before they are issued'),
  ('credit_notes.view', 'sales', 'View credit notes'),
  ('credit_notes.create', 'sales', 'Create, edit and delete draft credit notes'),
  ('credit_notes.issue', 'sales', 'Issue credit notes (posts them to the ledger)'),
  ('credit_notes.approve', 'sales', 'Approve credit notes before they are issued'),
  ('receipts.view', 'sales', 'View customer receipts and allocations'),
  ('receipts.create', 'sales', 'Record receipts, allocate them and apply customer credit'),
  ('receipts.void', 'sales', 'Void receipts'),
  ('sales.settings.manage', 'sales', 'Manage sales settings, numbering and default accounts'),
  ('sales.reports.view', 'sales', 'View sales reports, aging and customer statements'),
  ('sales.items.manage', 'sales', 'Manage the items catalog'),
  ('tax.codes.manage', 'tax', 'Create and change tax codes and their effective-dated rates')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE p3b_sales_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO p3b_sales_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('customers.view'), ('customers.create'), ('customers.update'), ('customers.archive'),
  ('invoices.view'), ('invoices.create'), ('invoices.edit_draft'), ('invoices.delete_draft'),
  ('invoices.issue'), ('invoices.void'), ('invoices.approve'),
  ('credit_notes.view'), ('credit_notes.create'), ('credit_notes.issue'),
  ('credit_notes.approve'),
  ('receipts.view'), ('receipts.create'), ('receipts.void'),
  ('sales.settings.manage'), ('sales.reports.view'), ('sales.items.manage'),
  ('tax.codes.manage')
) AS p (key);
INSERT INTO p3b_sales_backfill_grants (template_key, permission_key) VALUES
  ('member', 'customers.view'),
  ('member', 'invoices.view'),
  ('member', 'credit_notes.view'),
  ('member', 'receipts.view'),
  ('member', 'sales.reports.view');

CREATE TEMPORARY TABLE p3b_sales_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN p3b_sales_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO p3b_sales_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0026_sales_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 3B Sales permission backfill for existing organizations (ADR 0003 D14; Decisions 65, 90)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM p3b_sales_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
