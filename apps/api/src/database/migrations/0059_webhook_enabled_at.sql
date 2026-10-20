-- 0059_webhook_enabled_at — when a webhook endpoint was last enabled (ADR 0011, CR-0011-S6-01,
-- section 25.3).
--
-- The automatic-disablement rule "3 days without a successful delivery" is measured from the LATER
-- of `last_success_at` and `enabled_at`, so re-enabling an endpoint restarts the window instead of
-- inheriting an old success time. `enabled_at` is written by the application when an endpoint is
-- created and every time it returns to `active`.
--
-- * Forward-only and additive: migration 0058 is not changed.
-- * Backfill: no re-enable time was recorded before this migration, so every existing endpoint
--   (active, disabled, auto-disabled or deleted) gets `enabled_at = created_at`.
-- * No column default: the application always writes the value from its own clock, and an insert
--   that omits it fails instead of silently taking the database clock.

ALTER TABLE webhook_endpoints ADD COLUMN enabled_at timestamptz;

-- The 0058 row guard refuses every update of a deleted endpoint. It is suspended for this one
-- backfill statement only, inside the migration's own transaction, and re-enabled immediately.
ALTER TABLE webhook_endpoints DISABLE TRIGGER webhook_endpoints_guard;
UPDATE webhook_endpoints SET enabled_at = created_at;
ALTER TABLE webhook_endpoints ENABLE TRIGGER webhook_endpoints_guard;

ALTER TABLE webhook_endpoints ALTER COLUMN enabled_at SET NOT NULL;
ALTER TABLE webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_enabled_after_created CHECK (enabled_at >= created_at);
