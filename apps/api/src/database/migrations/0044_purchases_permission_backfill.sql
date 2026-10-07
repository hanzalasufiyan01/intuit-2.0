-- 0044_purchases_permission_backfill — Phase 4B-12: the Purchases permission backfill for existing
-- organizations (ADR 0004 P4-39, P4-40; Decision 90).
--
-- Organizations created before Phase 4 receive the Purchases permissions on their system roles,
-- as the role templates now grant them to new organizations:
--   * Owner and Administrator: all 26 permissions of the Phase 4 catalog added since Phase 3B
--     (vendors, Purchases settings and reports, bills, vendor credits, vendor payments and
--     direct expenses);
--   * Member: view only (P4-40) — vendors.view, bills.view, vendor_credits.view,
--     vendor_payments.view, purchases.reports.view and expenses.view.
-- `catalog.items.manage` is not repeated here: migration 0031 granted it to every role that held
-- `sales.items.manage`. The migration grants the Owner itself (no dependence on the reference
-- seed's Owner sync).
-- ADDITIVE ONLY: nothing is removed, custom roles are untouched, existing grants are kept
-- (ON CONFLICT DO NOTHING makes it idempotent). Every role that receives permissions gets an
-- append-only audit event.

INSERT INTO permissions (key, module, description) VALUES
  ('vendors.view', 'vendors', 'View vendors'),
  ('vendors.create', 'vendors', 'Create vendors'),
  ('vendors.update', 'vendors', 'Edit vendors, including their contact and tax details'),
  ('vendors.archive', 'vendors', 'Archive and restore vendors'),
  ('purchases.settings.manage', 'purchases', 'Manage Purchases settings, numbering and the AP control account'),
  ('purchases.reports.view', 'purchases', 'View AP aging, vendor statements and the AP reconciliation'),
  ('bills.view', 'purchases', 'View bills'),
  ('bills.create', 'purchases', 'Create bills, submit them for approval and choose tax recoverability'),
  ('bills.edit_draft', 'purchases', 'Edit draft bills'),
  ('bills.delete_draft', 'purchases', 'Delete draft bills'),
  ('bills.post', 'purchases', 'Post bills to the ledger and set a manual exchange rate'),
  ('bills.void', 'purchases', 'Void unpaid posted bills'),
  ('bills.approve', 'purchases', 'Approve bills before they are posted'),
  ('vendor_credits.view', 'purchases', 'View vendor credits and debit notes'),
  ('vendor_credits.create', 'purchases', 'Create, edit, delete and submit draft vendor credits and debit notes'),
  ('vendor_credits.post', 'purchases', 'Post vendor credits and debit notes, set a manual exchange rate and send debit notes'),
  ('vendor_credits.void', 'purchases', 'Void unapplied vendor credits and debit notes'),
  ('vendor_credits.approve', 'purchases', 'Approve vendor credits and debit notes before they are posted'),
  ('vendor_payments.view', 'purchases', 'View vendor payments'),
  ('vendor_payments.create', 'purchases', 'Create and record vendor payments, override their rate or account, and apply vendor credits and prepayments to bills'),
  ('vendor_payments.void', 'purchases', 'Void recorded vendor payments'),
  ('vendor_payments.approve', 'purchases', 'Approve vendor payments before they are recorded'),
  ('expenses.view', 'purchases', 'View direct expenses'),
  ('expenses.create', 'purchases', 'Create, edit, submit and post direct expenses'),
  ('expenses.void', 'purchases', 'Void posted expenses'),
  ('expenses.approve', 'purchases', 'Approve direct expenses before posting')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE p4_purchases_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO p4_purchases_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('vendors.view'), ('vendors.create'), ('vendors.update'), ('vendors.archive'),
  ('purchases.settings.manage'), ('purchases.reports.view'),
  ('bills.view'), ('bills.create'), ('bills.edit_draft'), ('bills.delete_draft'),
  ('bills.post'), ('bills.void'), ('bills.approve'),
  ('vendor_credits.view'), ('vendor_credits.create'), ('vendor_credits.post'),
  ('vendor_credits.void'), ('vendor_credits.approve'),
  ('vendor_payments.view'), ('vendor_payments.create'), ('vendor_payments.void'),
  ('vendor_payments.approve'),
  ('expenses.view'), ('expenses.create'), ('expenses.void'), ('expenses.approve')
) AS p (key);
INSERT INTO p4_purchases_backfill_grants (template_key, permission_key) VALUES
  ('member', 'vendors.view'),
  ('member', 'bills.view'),
  ('member', 'vendor_credits.view'),
  ('member', 'vendor_payments.view'),
  ('member', 'purchases.reports.view'),
  ('member', 'expenses.view');

CREATE TEMPORARY TABLE p4_purchases_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN p4_purchases_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO p4_purchases_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0044_purchases_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 4B-12 Purchases permission backfill for existing organizations (ADR 0004 P4-39, P4-40; Decision 90)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM p4_purchases_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
