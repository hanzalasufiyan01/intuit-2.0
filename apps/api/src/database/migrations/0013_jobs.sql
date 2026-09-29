-- Intuit 2.0 — Phase 3A, S5: background jobs (Decision 76; K-2; S5-14..S5-19).
--
--   * jobs: a PostgreSQL-backed queue. Every job belongs to one organization and runs under its
--     RLS context. Idempotent enqueue: (organization_id, type, job_key) is unique when a key is
--     given, and a repeated enqueue returns the existing job (S5-16).
--   * app_claim_jobs(): narrow SECURITY DEFINER claim across organizations (K-2). It locks due
--     queued jobs, and running jobs whose lock is older than p_stale_after (stale-lock recovery),
--     with FOR UPDATE SKIP LOCKED so concurrent workers never claim the same job. Comparisons use
--     the database clock. It returns identifiers only; the job itself is processed under the
--     organization's RLS context.

CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id),
  type                text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(type) <= 100),
  job_key             text CHECK (length(job_key) BETWEEN 1 AND 200),
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after           timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text CHECK (length(locked_by) <= 200),
  progress            integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_message    text CHECK (length(progress_message) <= 500),
  result              jsonb CHECK (result IS NULL OR octet_length(result::text) <= 65536),
  last_error          text CHECK (length(last_error) <= 2000),
  -- Who may read the job besides its creator (S5-18).
  required_permission text,
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT jobs_lock_consistency CHECK (
    (status = 'running') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CONSTRAINT jobs_finished_consistency CHECK (
    (status IN ('succeeded', 'failed', 'dead')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX jobs_idempotency_key ON jobs (organization_id, type, job_key)
  WHERE job_key IS NOT NULL;
CREATE INDEX jobs_due_idx ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON jobs FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON jobs FROM PUBLIC;
-- Jobs are never deleted; they end as succeeded, failed or dead.
GRANT SELECT, INSERT, UPDATE ON jobs TO intuit_app;

CREATE FUNCTION app_claim_jobs(p_worker text, p_limit integer, p_stale_after interval)
  RETURNS TABLE (id uuid, organization_id uuid, type text)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH due AS (
      SELECT j.id FROM public.jobs j
       WHERE (j.status = 'queued' AND j.run_after <= now())
          OR (j.status = 'running' AND j.locked_at <= now() - p_stale_after)
       ORDER BY j.run_after, j.created_at
       LIMIT least(greatest(p_limit, 0), 100)
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.jobs j
       SET status = 'running', attempts = j.attempts + 1, locked_at = now(),
           locked_by = left(p_worker, 200), updated_at = now()
      FROM due
     WHERE j.id = due.id
    RETURNING j.id, j.organization_id, j.type
  $$;
REVOKE ALL ON FUNCTION app_claim_jobs(text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_jobs(text, integer, interval) TO intuit_app;
