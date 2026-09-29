-- Intuit 2.0 — Phase 3A, S3: financial-report permission backfill for existing organizations
-- (Decisions 65, 90; S3-01, S3-02).
--
-- Organizations created before S3 receive accounting.reports.view on their Owner,
-- Administrator and Member roles, as their role templates now grant it to new organizations.
-- The migration grants the Owner itself (no dependence on the reference seed's Owner sync).
-- ADDITIVE ONLY: nothing is removed, custom roles are untouched, existing grants are kept
-- (ON CONFLICT DO NOTHING makes it idempotent). Every role that receives the permission gets
-- an append-only audit event.

INSERT INTO permissions (key, module, description) VALUES
  ('accounting.reports.view', 'accounting',
   'View and export financial statements (Trial Balance, Profit & Loss, Balance Sheet)')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE s3_reports_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO s3_reports_backfill_grants (template_key, permission_key) VALUES
  ('owner', 'accounting.reports.view'),
  ('administrator', 'accounting.reports.view'),
  ('member', 'accounting.reports.view');

CREATE TEMPORARY TABLE s3_reports_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN s3_reports_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO s3_reports_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0009_reports_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 3A financial-report permission backfill for existing organizations (Decisions 65, 90; S3-02)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM s3_reports_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
