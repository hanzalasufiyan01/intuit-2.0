import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppDependencies } from '../../application/dependencies.js';
import { metricsTokenMatches, type Metrics } from '../../infrastructure/metrics.js';

/**
 * GET /api/v1/metrics (Prometheus text format, ADR 0012). Protected by a bearer token from the
 * environment; without METRICS_TOKEN the endpoint does not exist. It carries aggregate figures
 * only (no tenant data), and its answer is never cached.
 */
export function registerMetricsRoute(
  app: FastifyInstance,
  deps: { deps: AppDependencies; metrics: Metrics },
): void {
  const token = deps.deps.config.metrics.token;
  if (!token) return;
  app.get('/metrics', async (request, reply) => {
    if (!metricsTokenMatches(request.headers.authorization, token)) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: { code: 'UNAUTHENTICATED', message: 'A metrics token is required.' } });
    }
    let operational: { metric: string; label: string; value: number }[] = [];
    try {
      const result = await deps.deps.db.execute<{ metric: string; label: string; value: number }>(
        sql`SELECT metric, label, value FROM app_operational_counts()`,
      );
      operational = result.rows.map((r) => ({
        metric: String(r.metric),
        label: String(r.label),
        value: Number(r.value),
      }));
    } catch (error) {
      // The HTTP figures are still useful when the database is down; the gap is itself a signal.
      request.log.warn({ err: error }, 'Operational counts unavailable');
    }
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(deps.metrics.render(operational));
  });
}
