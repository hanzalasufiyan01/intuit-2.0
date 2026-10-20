import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metrics, metricsTokenMatches } from '../src/infrastructure/metrics.js';
import { setUpAccountingOrg } from './fixtures.js';
import { createTestContext, type TestContext } from './helpers.js';

/** GET /api/v1/metrics (ADR 0012): token-protected, aggregate only, bounded labels. */

const TOKEN = 'metrics-token-0123456789-abcdef';

describe('Metrics registry', () => {
  it('renders counters, a histogram and the database figures, with escaped labels', () => {
    const metrics = new Metrics();
    metrics.requestStarted();
    metrics.requestFinished('GET', '/customers/:id', 200, 0.12);
    metrics.requestStarted();
    metrics.requestFinished('GET', '/customers/:id', 404, 3);
    metrics.requestStarted();
    metrics.requestFinished('POST', '/we"ird\nroute', 500, 0.01);
    const text = metrics.render([
      { metric: 'jobs', label: 'queued', value: 4 },
      { metric: 'jobs', label: 'dead', value: 1 },
      { metric: 'outbox', label: 'failed', value: 0 },
      { metric: 'jobs_oldest_queued_age_seconds', label: '', value: 12.4 },
    ]);
    expect(text).toContain(
      'intuit_http_requests_total{method="GET",route="/customers/:id",status="2xx"} 1',
    );
    expect(text).toContain(
      'intuit_http_requests_total{method="GET",route="/customers/:id",status="4xx"} 1',
    );
    expect(text).toContain('route="/we\\"ird route"');
    expect(text).toContain(
      'intuit_http_request_duration_seconds_bucket{method="GET",route="/customers/:id",le="0.25"} 1',
    );
    expect(text).toContain(
      'intuit_http_request_duration_seconds_bucket{method="GET",route="/customers/:id",le="+Inf"} 2',
    );
    expect(text).toContain(
      'intuit_http_request_duration_seconds_count{method="GET",route="/customers/:id"} 2',
    );
    expect(text).toContain('intuit_http_inflight_requests 0');
    expect(text).toContain('intuit_jobs{status="queued"} 4');
    expect(text).toContain('intuit_jobs{status="dead"} 1');
    expect(text).toContain('intuit_jobs_oldest_queued_age_seconds 12');
  });

  it('compares the bearer token in constant time and rejects anything else', () => {
    expect(metricsTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(metricsTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      'Basic abc',
    ]) {
      expect(metricsTokenMatches(header, TOKEN), String(header)).toBe(false);
    }
  });
});

describe('GET /api/v1/metrics', () => {
  let ctx: TestContext;
  let withoutToken: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ METRICS_TOKEN: TOKEN });
    withoutToken = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
    await withoutToken.close();
  });

  const fetchMetrics = (context: TestContext, authorization?: string) =>
    context.app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: authorization ? { authorization } : {},
      remoteAddress: '198.51.100.7',
    });

  it('does not exist without a configured token', async () => {
    expect((await fetchMetrics(withoutToken, `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });

  it('needs the token', async () => {
    expect((await fetchMetrics(ctx)).statusCode).toBe(401);
    const wrong = await fetchMetrics(ctx, 'Bearer not-the-token-not-the-token-0000');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
  });

  it('reports request counts by route pattern and aggregate queue figures, and nothing tenant specific', async () => {
    const org = await setUpAccountingOrg(ctx);
    const missing = randomUUID();
    await org.owner.get(`/customers/${missing}`);
    await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    const res = await fetchMetrics(ctx, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.body;
    expect(text).toMatch(
      /intuit_http_requests_total\{method="GET",route="\/api\/v1\/health",status="2xx"\} [1-9]/,
    );
    // The concrete URL (with its id) never appears: only the route pattern does.
    expect(text).toContain('route="/api/v1/customers/:id"');
    expect(text).not.toContain(missing);
    expect(text).not.toContain(org.organizationId);
    expect(text).not.toContain(org.ownerEmail);
    expect(text).toMatch(/intuit_jobs\{status="(queued|succeeded|running|failed|dead)"\} \d+/);
    expect(text).toContain('# TYPE intuit_outbox_events gauge');
    expect(text).toContain('intuit_jobs_oldest_queued_age_seconds');
  });
});
