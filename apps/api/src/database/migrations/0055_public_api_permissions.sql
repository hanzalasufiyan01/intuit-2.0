-- 0055_public_api_permissions — the frozen v1 Public API permission keys (ADR 0011, D2 and section 19.3).
--
-- Exactly four keys: api_tokens.view|manage and webhooks.view|manage. No settings permission and no
-- organization-level API policy exist in v1. Owner and Administrator receive all four; the Member
-- template receives the two view keys (Member stays view-only). Only system template roles are
-- backfilled: custom roles never receive management permissions silently.

INSERT INTO permissions (key, module, description) VALUES
  ('api_tokens.view', 'api_integrations', 'View API integrations and their tokens'),
  ('api_tokens.manage', 'api_integrations', 'Create, change and revoke API integrations and tokens'),
  ('webhooks.view', 'api_integrations', 'View webhook endpoints and delivery history'),
  ('webhooks.manage', 'api_integrations', 'Create, change and disable webhook endpoints')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE public_api_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO public_api_backfill_grants (template_key, permission_key)
SELECT t.template_key, p.key
FROM (VALUES ('owner'), ('administrator')) AS t (template_key)
CROSS JOIN (VALUES
  ('api_tokens.view'), ('api_tokens.manage'), ('webhooks.view'), ('webhooks.manage')
) AS p (key);
INSERT INTO public_api_backfill_grants (template_key, permission_key) VALUES
  ('member', 'api_tokens.view'),
  ('member', 'webhooks.view');

CREATE TEMPORARY TABLE public_api_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN public_api_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO public_api_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0055_public_api_permissions',
       jsonb_build_object(
         'reason', 'Public API permission backfill for existing organizations',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM public_api_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
