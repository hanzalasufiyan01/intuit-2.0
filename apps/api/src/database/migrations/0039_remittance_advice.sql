-- 0039_remittance_advice — Phase 4B-7: vendor remittance advice PDF and email (ADR 0004 P4-46;
-- 4B-7 decisions D1-D17 approved 2026-10-07).
--
-- * A remittance advice is OUTPUT ONLY. It is rendered on demand from an immutable snapshot taken
--   on the first request (D4, D5) from one RECORDED payment and its own recorded allocations. It
--   never creates or changes a journal, an accounting event, an allocation or a balance.
-- * purchases_payments gains two output columns, set at most once and only while the payment is
--   RECORDED: render_snapshot (the frozen advice content) and remittance_pdf_file_id (the stored
--   PDF, under legal hold). A separate guard enforces this; the 0036 payment guard is unchanged,
--   so a VOID payment is still wholly immutable there (D6, D9) and an existing PDF stays.
-- * purchases_remittance_emails records each explicit email request (D8, D13): a sibling of the
--   4B-1 purchases_document_emails, which is not touched. queued -> sent | failed, once.
-- * file_links gains the 'vendor_payment' link type for the generated PDF.
-- Forward-only, like 0001-0038: the project's migrator keeps no down scripts.

-- ---------------------------------------------------------------------------
-- Payment output state
-- ---------------------------------------------------------------------------

ALTER TABLE purchases_payments
  ADD COLUMN render_snapshot jsonb,
  ADD COLUMN remittance_pdf_file_id uuid;

ALTER TABLE purchases_payments
  ADD CONSTRAINT purchases_payments_remittance_file_fkey
    FOREIGN KEY (remittance_pdf_file_id, organization_id)
    REFERENCES files (id, organization_id),
  -- A draft or pending payment has no output; the PDF needs its frozen snapshot.
  ADD CONSTRAINT purchases_payments_remittance_state CHECK (
    (render_snapshot IS NULL OR status IN ('RECORDED', 'VOID'))
    AND (remittance_pdf_file_id IS NULL OR render_snapshot IS NOT NULL));

-- Set-once, and only on a RECORDED payment; tenant ownership of the file is the composite key.
CREATE FUNCTION purchases_guard_payment_remittance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.render_snapshot IS DISTINCT FROM OLD.render_snapshot THEN
    IF OLD.render_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'the remittance snapshot of payment % is set once and cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'RECORDED' THEN
      RAISE EXCEPTION 'only a recorded payment can receive remittance output (payment %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.remittance_pdf_file_id IS DISTINCT FROM OLD.remittance_pdf_file_id THEN
    IF OLD.remittance_pdf_file_id IS NOT NULL THEN
      RAISE EXCEPTION 'the remittance PDF of payment % is set once and cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'RECORDED' THEN
      RAISE EXCEPTION 'only a recorded payment can receive remittance output (payment %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_payments_remittance_guard
  BEFORE UPDATE OF render_snapshot, remittance_pdf_file_id ON purchases_payments
  FOR EACH ROW WHEN (NEW.render_snapshot IS DISTINCT FROM OLD.render_snapshot
                     OR NEW.remittance_pdf_file_id IS DISTINCT FROM OLD.remittance_pdf_file_id)
  EXECUTE FUNCTION purchases_guard_payment_remittance();

-- ---------------------------------------------------------------------------
-- Remittance emails
-- ---------------------------------------------------------------------------

CREATE TABLE purchases_remittance_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id),
  payment_id            uuid NOT NULL,
  recipient             text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
  subject               text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  message               text NOT NULL DEFAULT '' CHECK (length(message) <= 4000),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  job_id                uuid,
  file_id               uuid,
  requested_by_user_id  uuid NOT NULL REFERENCES users (id),
  requested_at          timestamptz NOT NULL,
  sent_at               timestamptz,
  CONSTRAINT purchases_remittance_emails_payment_fkey FOREIGN KEY (payment_id, organization_id)
    REFERENCES purchases_payments (id, organization_id),
  CONSTRAINT purchases_remittance_emails_file_fkey FOREIGN KEY (file_id, organization_id)
    REFERENCES files (id, organization_id),
  CONSTRAINT purchases_remittance_emails_sent_consistency CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX purchases_remittance_emails_payment_idx
  ON purchases_remittance_emails (organization_id, payment_id, requested_at DESC);

-- Queued -> sent | failed, once; the request itself never changes and is never deleted.
CREATE FUNCTION purchases_guard_remittance_email() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'remittance emails are kept' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'queued'
     OR (NEW.id, NEW.organization_id, NEW.payment_id, NEW.recipient, NEW.subject, NEW.message,
         NEW.requested_by_user_id, NEW.requested_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.payment_id, OLD.recipient, OLD.subject, OLD.message,
         OLD.requested_by_user_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'remittance email % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_remittance_emails_guard
  BEFORE UPDATE OR DELETE ON purchases_remittance_emails
  FOR EACH ROW EXECUTE FUNCTION purchases_guard_remittance_email();
CREATE TRIGGER purchases_remittance_emails_no_truncate
  BEFORE TRUNCATE ON purchases_remittance_emails
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_history_modification();

ALTER TABLE purchases_remittance_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_remittance_emails_tenant ON purchases_remittance_emails FOR ALL
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
REVOKE ALL ON purchases_remittance_emails FROM PUBLIC;
-- No DELETE: emails are kept.
GRANT SELECT, INSERT, UPDATE ON purchases_remittance_emails TO intuit_app;

-- ---------------------------------------------------------------------------
-- The generated PDF's file link
-- ---------------------------------------------------------------------------

ALTER TABLE file_links DROP CONSTRAINT file_links_link_type_check;
ALTER TABLE file_links ADD CONSTRAINT file_links_link_type_check CHECK (
  link_type IN ('organization_logo', 'party', 'journal', 'import_batch', 'export',
                'opening_balance_batch', 'invoice', 'credit_note', 'receipt', 'bill',
                'vendor_credit', 'vendor_payment'));
