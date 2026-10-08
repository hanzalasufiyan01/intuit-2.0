-- 0057_api_rate_windows — Public API rate-limit counters (ADR 0011 section 4; Step 3).
--
-- Fixed one-minute windows in PostgreSQL, correct across several API instances and needing no extra
-- infrastructure. A counter is keyed by a string such as `token:<id>:read`, `org:<id>` or
-- `authfail:<ip>`; the limiter behind the RateLimiter interface can be replaced without touching
-- any handler. The table holds no business data and has no organization column, so it is
-- written before any tenant context exists (failed-authentication throttling by IP).

CREATE TABLE api_rate_windows (
  key          text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count >= 1),
  PRIMARY KEY (key, window_start)
);
CREATE INDEX api_rate_windows_window_idx ON api_rate_windows (window_start);

REVOKE ALL ON api_rate_windows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_rate_windows TO intuit_app;
