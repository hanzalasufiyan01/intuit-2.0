-- 0061_operational_metrics — aggregate operational counts for the metrics endpoint (ADR 0012).
--
-- `GET /api/v1/metrics` reports the depth and health of the background queues. Those tables are
-- tenant tables protected by row-level security, so the runtime role cannot count across
-- organizations. This SECURITY DEFINER function returns ONLY aggregate numbers (a status and a
-- count per queue, and the age of the oldest waiting job): no organization id, no payload, no
-- personal data. It is executable by the runtime role and by no one else.

CREATE FUNCTION app_operational_counts()
  RETURNS TABLE (metric text, label text, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT 'jobs'::text, j.status, count(*)::double precision FROM public.jobs j GROUP BY j.status
    UNION ALL
    SELECT 'jobs_oldest_queued_age_seconds'::text, ''::text,
           coalesce(extract(epoch FROM (now() - min(j.run_after))), 0)::double precision
      FROM public.jobs j WHERE j.status = 'queued' AND j.run_after <= now()
    UNION ALL
    SELECT 'outbox'::text, o.status, count(*)::double precision FROM public.outbox_events o GROUP BY o.status
    UNION ALL
    SELECT 'webhook_deliveries'::text, d.status, count(*)::double precision
      FROM public.webhook_deliveries d WHERE d.status IN ('pending', 'dead') GROUP BY d.status
  $$;
REVOKE ALL ON FUNCTION app_operational_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_operational_counts() TO intuit_app;
