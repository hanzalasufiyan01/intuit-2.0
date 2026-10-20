-- 0072_project_tasks — tasks inside a project, with hour budgets, and time logged against a task
-- (FP-26 follow-up, docs/design/projects-job-costing.md).
--
-- A task belongs to one project, may carry an hours budget, and is OPEN or DONE. A time entry may
-- name a task of its own project (checked by a composite key, so it cannot name another project's
-- task). Budgets are advisory: the summary shows hours against budget per task and per project
-- and flags an overrun; nothing blocks logging time.

CREATE TABLE project_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  project_id          uuid NOT NULL,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  budget_hours        numeric(12, 2) CHECK (budget_hours IS NULL OR budget_hours >= 0),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  updated_by_user_id  uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT project_tasks_id_project_key UNIQUE (id, project_id, organization_id),
  CONSTRAINT project_tasks_project_fkey FOREIGN KEY (project_id, organization_id)
    REFERENCES projects (id, organization_id)
);
CREATE UNIQUE INDEX project_tasks_name_idx ON project_tasks (project_id, lower(name));

ALTER TABLE project_time_entries ADD COLUMN task_id uuid;
ALTER TABLE project_time_entries ADD CONSTRAINT project_time_entries_task_fkey
  FOREIGN KEY (task_id, project_id, organization_id)
  REFERENCES project_tasks (id, project_id, organization_id);

-- The task joins the figures that are frozen once time is submitted.
CREATE OR REPLACE FUNCTION project_guard_time_entry() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('DRAFT', 'REJECTED') THEN
      RAISE EXCEPTION 'time entry % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'BILLED' AND NOT (
       NEW.status = 'BILLED' AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
       OR NEW.status = 'APPROVED' AND NEW.invoice_id IS NULL AND NEW.billed_at IS NULL) THEN
    RAISE EXCEPTION 'billed time entry % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    OLD.status = 'BILLED' AND NEW.status IN ('BILLED', 'APPROVED') OR
    (OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'SUBMITTED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED', 'APPROVED', 'REJECTED'))
    OR (OLD.status = 'REJECTED' AND NEW.status IN ('REJECTED', 'DRAFT', 'SUBMITTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'BILLED'))
  ) THEN
    RAISE EXCEPTION 'time entry % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('SUBMITTED', 'APPROVED', 'BILLED') AND (
       NEW.project_id, NEW.task_id, NEW.user_id, NEW.work_date, NEW.hours, NEW.description,
       NEW.billable, NEW.bill_rate, NEW.cost_rate)
     IS DISTINCT FROM (
       OLD.project_id, OLD.task_id, OLD.user_id, OLD.work_date, OLD.hours, OLD.description,
       OLD.billable, OLD.bill_rate, OLD.cost_rate) THEN
    RAISE EXCEPTION 'the figures of time entry % are frozen while it is %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_tasks_tenant ON project_tasks FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON project_tasks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON project_tasks TO intuit_app;
CREATE TRIGGER project_tasks_no_truncate BEFORE TRUNCATE ON project_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();
