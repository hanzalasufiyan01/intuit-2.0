-- 0096_tutorial_progress — each member's progress through the in-app tutorials (Help centre).
--
-- One row per (organization, user, tutorial). The tutorial identifier is an opaque key the web app
-- owns (its catalogue changes without a migration); the database only bounds its shape. The row
-- belongs to ONE member of ONE organization: the policy below pins both, so a user never sees
-- another user's progress, not even inside the same organization, and never another
-- organization's. The row is pinned to an existing membership by a composite foreign key.
--
-- No personal data is stored: no free text, no answers, no device or IP information.

CREATE TABLE tutorial_progress (
  organization_id uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  tutorial_id     text        NOT NULL CHECK (tutorial_id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  status          text        NOT NULL CHECK (status IN ('in_progress', 'completed', 'skipped')),
  current_step    integer     NOT NULL DEFAULT 0 CHECK (current_step BETWEEN 0 AND 100),
  started_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL,
  CONSTRAINT tutorial_progress_pkey PRIMARY KEY (organization_id, user_id, tutorial_id),
  CONSTRAINT tutorial_progress_membership_fkey FOREIGN KEY (organization_id, user_id)
    REFERENCES memberships (organization_id, user_id),
  CONSTRAINT tutorial_progress_completed_consistency
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- A member can hold progress for a bounded number of tutorials (the catalogue is small), so a
-- client cannot grow the table without limit.
CREATE FUNCTION tutorial_progress_limit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM tutorial_progress
       WHERE organization_id = NEW.organization_id AND user_id = NEW.user_id) >= 50 THEN
    RAISE EXCEPTION 'too many tutorials tracked for this member' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tutorial_progress_limit_guard BEFORE INSERT ON tutorial_progress
  FOR EACH ROW EXECUTE FUNCTION tutorial_progress_limit();

ALTER TABLE tutorial_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY tutorial_progress_own ON tutorial_progress FOR ALL
  USING (organization_id = app_current_organization_id() AND user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id() AND user_id = app_current_user_id());
REVOKE ALL ON tutorial_progress FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON tutorial_progress TO intuit_app;
