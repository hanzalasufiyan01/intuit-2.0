-- 0031_catalog_items_permission_backfill — Phase 4A-4 (ADR 0004 P4-06, amended).
--
-- The shared items catalog is governed by the neutral key `catalog.items.manage`. Every role that
-- holds `sales.items.manage` (the superseded Phase 3B key) receives it, custom roles included,
-- because this preserves access rather than widening it. `sales.items.manage` is not removed.
-- ADDITIVE ONLY and idempotent (ON CONFLICT DO NOTHING); each role that receives the key gets an
-- append-only, system-actor audit event. New organizations get the key from the role templates.

INSERT INTO permissions (key, module, description) VALUES
  ('catalog.items.manage', 'catalog', 'Manage the shared items catalog (sales and purchase details)')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE p4_catalog_backfilled (role_id uuid, organization_id uuid) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT rp.role_id, rp.organization_id, 'catalog.items.manage'
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id AND r.organization_id = rp.organization_id
  WHERE rp.permission_key = 'sales.items.manage'
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id
)
INSERT INTO p4_catalog_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0031_catalog_items_permission_backfill',
       jsonb_build_object(
         'reason', 'Phase 4 P4-06: the shared catalog key for every role holding sales.items.manage',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', jsonb_build_array('catalog.items.manage')
       )
FROM p4_catalog_backfilled b
JOIN roles r ON r.id = b.role_id;
