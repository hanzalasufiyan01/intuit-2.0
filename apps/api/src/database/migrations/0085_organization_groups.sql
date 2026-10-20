-- 0085_organization_groups — groups of organizations (legal entities), FP-24
-- (docs/design/branches-legal-entities.md).
--
-- A legal entity is a separate organization (its own books, tax registration and security
-- boundary). A GROUP only links organizations that one user owns so that the user can read them
-- side by side. It changes nothing inside any organization: no shared ledger, no consolidation
-- entries, no intercompany eliminations, no currency translation (those accounting rules are an
-- open decision, docs/open-decisions.md). The group belongs to a user, not to a tenant, so its rows
-- are guarded by the user, and every read of an organization's figures still runs under that
-- organization's own row-level security and permissions.

CREATE TABLE organization_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  owner_user_id  uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL
);
CREATE INDEX organization_groups_owner_idx ON organization_groups (owner_user_id);

CREATE TABLE organization_group_members (
  group_id         uuid NOT NULL REFERENCES organization_groups (id),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  added_by_user_id uuid NOT NULL REFERENCES users (id),
  added_at         timestamptz NOT NULL,
  PRIMARY KEY (group_id, organization_id),
  -- An organization belongs to at most one group.
  CONSTRAINT organization_group_members_one_group UNIQUE (organization_id)
);

ALTER TABLE organization_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_groups_owner ON organization_groups FOR ALL
  USING (owner_user_id = app_current_user_id())
  WITH CHECK (owner_user_id = app_current_user_id());

ALTER TABLE organization_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_group_members_owner ON organization_group_members FOR ALL
  USING (EXISTS (SELECT 1 FROM organization_groups g WHERE g.id = group_id))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_groups g WHERE g.id = group_id));

REVOKE ALL ON organization_groups, organization_group_members FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON organization_groups TO intuit_app;
GRANT SELECT, INSERT, DELETE ON organization_group_members TO intuit_app;
CREATE TRIGGER organization_groups_no_truncate BEFORE TRUNCATE ON organization_groups
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
CREATE TRIGGER organization_group_members_no_truncate BEFORE TRUNCATE ON organization_group_members
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
