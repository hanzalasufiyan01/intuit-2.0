-- Intuit 2.0 — Phase 3A, S5: file storage (Decisions 6, 29, 61, 65, 75, 76; S4-03; S5-01..S5-13,
-- S5-19, S5-20).
--
--   * files: metadata only; contents live in the storage provider (never in PostgreSQL). Storage
--     keys are server-generated and tenant-prefixed (org/{organizationId}/...). At most 25 MB.
--     Allowed detected types: PDF, PNG, JPEG, WebP, CSV, XLSX (Decision 61). Rows are never deleted:
--     a deleted file keeps its row until purged (status purged, object removed). Legal hold is
--     system-managed in Phase 3A and blocks deletion and purge.
--   * file_links: exactly one business record per file (S5-04); access inherits that record's
--     permission (Decision 65). Link types in S5: organization_logo, party, journal.
--   * organization_profiles.logo_file_id (S4-03, S5-11).
--   * app_organizations_with_due_file_purges(): narrow SECURITY DEFINER discovery for the purge
--     scheduler (S5-19); returns organization ids only.

CREATE TABLE files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  storage_provider    text NOT NULL CHECK (storage_provider IN ('local')),
  storage_key         text NOT NULL UNIQUE CHECK (
    storage_key ~ '^org/[0-9a-f-]{36}/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}$'),
  original_name       text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  detected_type       text NOT NULL CHECK (detected_type IN ('pdf', 'png', 'jpeg', 'webp', 'csv', 'xlsx')),
  mime_type           text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 100),
  size_bytes          bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'quarantined', 'deleted', 'purged')),
  scan_status         text NOT NULL DEFAULT 'not_scanned'
                        CHECK (scan_status IN ('not_scanned', 'clean', 'infected')),
  legal_hold          boolean NOT NULL DEFAULT false,
  uploaded_by_user_id uuid NOT NULL REFERENCES users (id),
  uploaded_at         timestamptz NOT NULL,
  deleted_by_user_id  uuid REFERENCES users (id),
  deleted_at          timestamptz,
  purge_after         timestamptz,
  purged_at           timestamptz,
  CONSTRAINT files_id_organization_key UNIQUE (id, organization_id),
  -- The storage key always belongs to the file's own organization.
  CONSTRAINT files_storage_key_tenant CHECK (starts_with(storage_key, 'org/' || organization_id::text || '/')),
  CONSTRAINT files_deleted_consistency CHECK (
    (status IN ('deleted', 'purged')) = (deleted_at IS NOT NULL AND purge_after IS NOT NULL)),
  CONSTRAINT files_purged_consistency CHECK ((status = 'purged') = (purged_at IS NOT NULL)),
  -- Legal hold blocks deletion and purge (S5-13).
  CONSTRAINT files_legal_hold CHECK (NOT (legal_hold AND status IN ('deleted', 'purged'))),
  CONSTRAINT files_infected_quarantined CHECK (scan_status <> 'infected' OR status <> 'available')
);
CREATE INDEX files_purge_due_idx ON files (purge_after) WHERE status = 'deleted' AND NOT legal_hold;
CREATE INDEX files_organization_idx ON files (organization_id, status);

CREATE TABLE file_links (
  file_id            uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  link_type          text NOT NULL CHECK (link_type IN ('organization_logo', 'party', 'journal')),
  link_id            uuid,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_links_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  -- The logo belongs to the organization itself; every other link names its record.
  CONSTRAINT file_links_target CHECK ((link_type = 'organization_logo') = (link_id IS NULL))
);
CREATE INDEX file_links_target_idx ON file_links (organization_id, link_type, link_id);

-- S4-03 / S5-11: the organization logo.
ALTER TABLE organization_profiles ADD COLUMN logo_file_id uuid;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profiles_logo_fkey
  FOREIGN KEY (logo_file_id, organization_id) REFERENCES files (id, organization_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files', 'file_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id = app_current_organization_id()) '
      'WITH CHECK (organization_id = app_current_organization_id())',
      t || '_tenant', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END;
$$;

-- Rows are never deleted (status changes only).
GRANT SELECT, INSERT, UPDATE ON files, file_links TO intuit_app;

-- Organizations that have deleted files past their retention and not under legal hold.
-- Identifiers only; the purge itself runs under each organization's RLS context.
CREATE FUNCTION app_organizations_with_due_file_purges()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT DISTINCT f.organization_id FROM public.files f
     WHERE f.status = 'deleted' AND NOT f.legal_hold AND f.purge_after <= now()
  $$;
REVOKE ALL ON FUNCTION app_organizations_with_due_file_purges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizations_with_due_file_purges() TO intuit_app;
