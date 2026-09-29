-- Intuit 2.0 — Phase 3A, S2: dimension permission backfill for existing organizations
-- (Decisions 65, 90).
--
-- Organizations created before S2 receive the dimension permissions their role templates now
-- grant to new organizations:
--   Administrator: accounting.dimensions.view, accounting.dimensions.manage
--   Member:        accounting.dimensions.view
--   Owner:         accounting.dimensions.view, accounting.dimensions.manage (granted here, so
--                  Owner access does not depend on the reference seed's Owner sync)
-- ADDITIVE ONLY: nothing is removed, custom roles are untouched, and existing grants are kept
-- (ON CONFLICT DO NOTHING makes it idempotent). Every role that receives a permission gets an
-- append-only audit event.

-- Catalog entries first (upgrade path: migrate before seed). The seed refreshes descriptions.
INSERT INTO permissions (key, module, description) VALUES
  ('accounting.dimensions.view', 'accounting', 'View dimension types and values'),
  ('accounting.dimensions.manage', 'accounting',
   'Manage dimension types, values, required settings and account scopes')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE s2_dimension_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO s2_dimension_backfill_grants (template_key, permission_key) VALUES
  ('owner', 'accounting.dimensions.view'),
  ('owner', 'accounting.dimensions.manage'),
  ('administrator', 'accounting.dimensions.view'),
  ('administrator', 'accounting.dimensions.manage'),
  ('member', 'accounting.dimensions.view');

CREATE TEMPORARY TABLE s2_dimension_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN s2_dimension_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO s2_dimension_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0008_dimension_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 3A dimension permission backfill for existing organizations (Decisions 65, 90)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM s2_dimension_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
