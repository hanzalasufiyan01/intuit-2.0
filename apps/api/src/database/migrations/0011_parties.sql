-- Intuit 2.0 — Phase 3A, S4: unified Party/Contact master (Decisions 8, 28, 65, 90; S4-01,
-- S4-05, S4-08..S4-11, S4-13..S4-17, S4-20).
--
--   * parties: one identity per real-world contact, kind organization | individual. Archived,
--     never deleted (no DELETE grant, no parties.delete permission). Optional reference unique
--     per organization (case-insensitive). `version` for optimistic concurrency.
--   * party_roles: customer | vendor | employee | other, zero or more per party (classification;
--     customer and vendor business records belong to their own modules).
--   * party_contacts: contact persons; at most one primary per party.
--   * party_addresses: billing and delivery addresses; at most one default per kind.
--   * pg_trgm powers case-insensitive "contains" search over names, reference, email and TIN.
--   * Permission backfill (S4-17): parties.* for existing organizations, additive and audited.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE parties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  kind                text NOT NULL CHECK (kind IN ('organization', 'individual')),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  company_name        text CHECK (company_name IS NULL OR length(btrim(company_name)) BETWEEN 1 AND 200),
  first_name          text CHECK (first_name IS NULL OR length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name           text CHECK (last_name IS NULL OR length(btrim(last_name)) BETWEEN 1 AND 100),
  reference           text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 50),
  tin                 text CHECK (tin IS NULL OR length(btrim(tin)) BETWEEN 1 AND 50),
  email               text CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  phone               text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 40),
  website             text CHECK (website IS NULL OR length(btrim(website)) BETWEEN 1 AND 200),
  notes               text CHECK (notes IS NULL OR length(notes) <= 2000),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  search_text         text GENERATED ALWAYS AS (lower(
                        display_name || ' ' || coalesce(company_name, '') || ' ' ||
                        coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
                        coalesce(reference, '') || ' ' || coalesce(email, '') || ' ' ||
                        coalesce(tin, ''))) STORED,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_by_user_id uuid REFERENCES users (id),
  archived_at         timestamptz,
  CONSTRAINT parties_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT parties_archive_consistency CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX parties_organization_reference_idx
  ON parties (organization_id, lower(reference)) WHERE reference IS NOT NULL;
CREATE INDEX parties_list_idx ON parties (organization_id, status, lower(display_name), id);
CREATE INDEX parties_search_trgm_idx ON parties USING gin (search_text gin_trgm_ops);
CREATE INDEX parties_tin_idx ON parties (organization_id, lower(tin)) WHERE tin IS NOT NULL;
CREATE INDEX parties_email_idx ON parties (organization_id, lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER parties_touch_updated_at BEFORE UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE party_roles (
  party_id        uuid NOT NULL,
  organization_id uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('customer', 'vendor', 'employee', 'other')),
  PRIMARY KEY (party_id, role),
  CONSTRAINT party_roles_party_fkey FOREIGN KEY (party_id, organization_id)
    REFERENCES parties (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX party_roles_organization_role_idx ON party_roles (organization_id, role);

CREATE TABLE party_contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id           uuid NOT NULL,
  organization_id    uuid NOT NULL,
  first_name         text CHECK (first_name IS NULL OR length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name          text CHECK (last_name IS NULL OR length(btrim(last_name)) BETWEEN 1 AND 100),
  job_title          text CHECK (job_title IS NULL OR length(btrim(job_title)) BETWEEN 1 AND 100),
  email              text CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  phone              text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 40),
  mobile             text CHECK (mobile IS NULL OR length(btrim(mobile)) BETWEEN 1 AND 40),
  is_primary         boolean NOT NULL DEFAULT false,
  receives_documents boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_contacts_party_fkey FOREIGN KEY (party_id, organization_id)
    REFERENCES parties (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT party_contacts_name CHECK (first_name IS NOT NULL OR last_name IS NOT NULL)
);
CREATE UNIQUE INDEX party_contacts_single_primary_idx ON party_contacts (party_id) WHERE is_primary;
CREATE INDEX party_contacts_party_idx ON party_contacts (organization_id, party_id);

CREATE TABLE party_addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id        uuid NOT NULL,
  organization_id uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('billing', 'delivery')),
  label           text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 100),
  line1           text NOT NULL CHECK (length(btrim(line1)) BETWEEN 1 AND 200),
  line2           text CHECK (line2 IS NULL OR length(line2) <= 200),
  city            text CHECK (city IS NULL OR length(city) <= 100),
  region          text CHECK (region IS NULL OR length(region) <= 100),
  postal_code     text CHECK (postal_code IS NULL OR length(postal_code) <= 20),
  country_code    char(2) NOT NULL REFERENCES countries (code),
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_addresses_party_fkey FOREIGN KEY (party_id, organization_id)
    REFERENCES parties (id, organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX party_addresses_single_default_idx
  ON party_addresses (party_id, kind) WHERE is_default;
CREATE INDEX party_addresses_party_idx ON party_addresses (organization_id, party_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties', 'party_roles', 'party_contacts', 'party_addresses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id = app_current_organization_id()) '
      'WITH CHECK (organization_id = app_current_organization_id())',
      t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;

-- Parties are archived, never deleted (S4-11).
GRANT SELECT, INSERT, UPDATE ON parties TO intuit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON party_roles, party_contacts, party_addresses TO intuit_app;

-- ---------------------------------------------------------------------------
-- Permission backfill for existing organizations (Decisions 65, 90; S4-17)
-- Owner: all; Administrator: all; Member: parties.view. Additive only; custom roles untouched.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, module, description) VALUES
  ('parties.view', 'parties', 'View parties (contacts), their contact persons and addresses'),
  ('parties.create', 'parties', 'Create parties'),
  ('parties.update', 'parties', 'Edit parties, their roles, contact persons and addresses'),
  ('parties.archive', 'parties', 'Archive and restore parties')
ON CONFLICT (key) DO NOTHING;

CREATE TEMPORARY TABLE s4_parties_backfill_grants (template_key text, permission_key text) ON COMMIT DROP;
INSERT INTO s4_parties_backfill_grants (template_key, permission_key) VALUES
  ('owner', 'parties.view'), ('owner', 'parties.create'),
  ('owner', 'parties.update'), ('owner', 'parties.archive'),
  ('administrator', 'parties.view'), ('administrator', 'parties.create'),
  ('administrator', 'parties.update'), ('administrator', 'parties.archive'),
  ('member', 'parties.view');

CREATE TEMPORARY TABLE s4_parties_backfilled (role_id uuid, organization_id uuid, permission_key text) ON COMMIT DROP;

WITH granted AS (
  INSERT INTO role_permissions (role_id, organization_id, permission_key)
  SELECT r.id, r.organization_id, g.permission_key
  FROM roles r
  JOIN s4_parties_backfill_grants g ON g.template_key = r.template_key
  WHERE r.is_system
  ON CONFLICT DO NOTHING
  RETURNING role_id, organization_id, permission_key
)
INSERT INTO s4_parties_backfilled SELECT * FROM granted;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'role.permissions_backfilled', 'role',
       b.role_id::text, 'migration:0011_parties',
       jsonb_build_object(
         'reason', 'Phase 3A party permission backfill for existing organizations (Decisions 65, 90; S4-17)',
         'roleName', r.name,
         'templateKey', r.template_key,
         'permissionsAdded', to_jsonb(array_agg(b.permission_key ORDER BY b.permission_key))
       )
FROM s4_parties_backfilled b
JOIN roles r ON r.id = b.role_id
GROUP BY b.organization_id, b.role_id, r.name, r.template_key;
