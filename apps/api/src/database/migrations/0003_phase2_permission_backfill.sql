-- Intuit 2.0 — Phase 2 permission backfill for organizations created before Phase 2.
--
-- Approved decision (ADR 0002): the template-derived Administrator and Member roles of
-- existing organizations receive the Phase 2 permissions their templates grant to new
-- organizations. The backfill is ADDITIVE ONLY: no permission is removed, custom roles are
-- untouched, and the protected Owner role keeps being synced by the reference seed.
-- It runs once (migration) and is idempotent (ON CONFLICT DO NOTHING).

-- Make sure the Phase 2 catalog entries exist even if the reference seed has not run yet
-- (upgrade path: migrate first, then seed). The seed later refreshes their descriptions.
INSERT INTO permissions (key, module, description) VALUES
  ('accounting.setup', 'accounting', 'Set up accounting'),
  ('accounting.accounts.view', 'accounting', 'View the chart of accounts'),
  ('accounting.accounts.create', 'accounting', 'Create accounts'),
  ('accounting.accounts.update', 'accounting', 'Edit accounts'),
  ('accounting.accounts.archive', 'accounting', 'Archive accounts'),
  ('accounting.accounts.delete', 'accounting', 'Delete unused accounts'),
  ('accounting.journals.view', 'accounting', 'View journals'),
  ('accounting.journals.create', 'accounting', 'Create draft journals'),
  ('accounting.journals.edit_draft', 'accounting', 'Edit draft journals'),
  ('accounting.journals.submit', 'accounting', 'Submit and withdraw journals'),
  ('accounting.journals.approve', 'accounting', 'Approve or reject journals'),
  ('accounting.journals.post', 'accounting', 'Post journals'),
  ('accounting.journals.reverse', 'accounting', 'Reverse posted journals'),
  ('accounting.periods.view', 'accounting', 'View fiscal years and periods'),
  ('accounting.periods.close', 'accounting', 'Close accounting periods'),
  ('accounting.periods.reopen', 'accounting', 'Reopen closed periods'),
  ('accounting.ledger.view', 'accounting', 'View the general ledger'),
  ('approvals.manage', 'approvals', 'Configure approval policies')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE phase2_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO phase2_backfill_grants (template_key, permission_key)
SELECT 'administrator', key FROM permissions
WHERE key LIKE 'accounting.%' OR key = 'approvals.manage'
UNION ALL
SELECT 'member', unnest(ARRAY[
  'accounting.accounts.view', 'accounting.journals.view',
  'accounting.periods.view', 'accounting.ledger.view'
]);

CREATE TEMPORARY TABLE phase2_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN phase2_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system AND NOT r.is_owner
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO phase2_backfilled SELECT * FROM granted;

-- Append-only audit trail: one system event per role that received permissions.
INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0003_phase2_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 2 permission backfill for organizations created before Phase 2 (ADR 0002)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM phase2_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
