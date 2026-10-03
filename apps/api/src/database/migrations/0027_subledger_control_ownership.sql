-- 0027_subledger_control_ownership — Phase 4A-1: which subledger owns a control account.
-- ADR 0004 P4-08 (amends the Phase 3B E3 implementation; Decision 11, C3).
--
-- * accounting_accounts.control_subledger records the subledger that maintains a control account:
--   'sales' (the AR control account) or 'purchases' (the AP control account, Phase 4). The CHECK
--   ties it to the existing is_control_account flag, so an account is controlled by exactly one
--   subledger or by none, and two subledgers can never claim the same account.
-- * Backfill: until now the only application path that marks a control account is the Sales
--   settings change (Phase 3B E3), so every existing control account is owned by 'sales'. Each
--   backfilled account gets an append-only, system-actor audit event.
-- * Manual-journal rejection (C3), the S8-07 opening-balance guard and the S9 exposure rules keep
--   reading is_control_account and are unchanged.

ALTER TABLE accounting_accounts
  ADD COLUMN control_subledger text
    CHECK (control_subledger IS NULL OR control_subledger IN ('sales', 'purchases'));

CREATE TEMPORARY TABLE p4_control_backfilled (account_id uuid, organization_id uuid) ON COMMIT DROP;

-- backfill:begin
WITH marked AS (
  UPDATE accounting_accounts
     SET control_subledger = 'sales'
   WHERE is_control_account AND control_subledger IS NULL
  RETURNING id, organization_id
)
INSERT INTO p4_control_backfilled SELECT * FROM marked;

INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id, action,
                          resource_type, resource_id, request_id, metadata)
SELECT now(), b.organization_id, 'system', NULL, 'account.control_subledger_recorded',
       'accounting_account', b.account_id::text, 'migration:0027_subledger_control_ownership',
       jsonb_build_object(
         'reason', 'Phase 4 P4-08: existing control accounts are maintained by the Sales subledger (Phase 3B E3)',
         'subledger', 'sales'
       )
FROM p4_control_backfilled b;
-- backfill:end

ALTER TABLE accounting_accounts
  ADD CONSTRAINT accounting_accounts_control_subledger_consistency
    CHECK (is_control_account = (control_subledger IS NOT NULL));
