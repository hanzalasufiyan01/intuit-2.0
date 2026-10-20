import { timingSafeEqual } from 'node:crypto';

/**
 * A small in-process metrics registry in the Prometheus text format (ADR 0012): request counts and
 * latency by route, requests in flight, and the aggregate queue figures the database reports.
 * Labels are bounded: the route is the registered route pattern (never the concrete URL, so ids
 * and tokens never appear), the status is the class (2xx, 4xx, ...). No tenant or personal data.
 */

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

const escapeLabel = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');

export class Metrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Series>();
  private inflight = 0;
  private readonly startedAt = Date.now();

  requestStarted() {
    this.inflight += 1;
  }

  requestFinished(method: string, route: string, statusCode: number, seconds: number) {
    this.inflight = Math.max(0, this.inflight - 1);
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    const requestKey = `${labels},status="${Math.floor(statusCode / 100)}xx"`;
    this.requests.set(requestKey, (this.requests.get(requestKey) ?? 0) + 1);
    let series = this.durations.get(labels);
    if (!series) {
      series = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.durations.set(labels, series);
    }
    series.count += 1;
    series.sum += seconds;
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) series!.buckets[i]! += 1;
    });
  }

  /** `operational` are the database figures as `[metric, label, value]` triples. */
  render(operational: readonly { metric: string; label: string; value: number }[]): string {
    const lines: string[] = [
      '# HELP intuit_process_uptime_seconds Seconds since the API process started.',
      '# TYPE intuit_process_uptime_seconds gauge',
      `intuit_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      '# HELP intuit_http_inflight_requests Requests currently being handled.',
      '# TYPE intuit_http_inflight_requests gauge',
      `intuit_http_inflight_requests ${this.inflight}`,
      '# HELP intuit_http_requests_total Requests by method, route pattern and status class.',
      '# TYPE intuit_http_requests_total counter',
    ];
    for (const [key, value] of [...this.requests].sort()) {
      lines.push(`intuit_http_requests_total{${key}} ${value}`);
    }
    lines.push(
      '# HELP intuit_http_request_duration_seconds Request duration by method and route pattern.',
      '# TYPE intuit_http_request_duration_seconds histogram',
    );
    for (const [labels, series] of [...this.durations].sort()) {
      BUCKETS.forEach((bound, i) => {
        lines.push(
          `intuit_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${series.buckets[i]}`,
        );
      });
      lines.push(
        `intuit_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${series.count}`,
        `intuit_http_request_duration_seconds_sum{${labels}} ${series.sum.toFixed(6)}`,
        `intuit_http_request_duration_seconds_count{${labels}} ${series.count}`,
      );
    }
    const names: Record<string, [string, string]> = {
      jobs: ['intuit_jobs', 'Background jobs by status.'],
      outbox: ['intuit_outbox_events', 'Outbox events by status.'],
      webhook_deliveries: ['intuit_webhook_deliveries', 'Pending and dead webhook deliveries.'],
    };
    for (const [metric, [name, help]] of Object.entries(names)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const row of operational.filter((r) => r.metric === metric)) {
        lines.push(`${name}{status="${escapeLabel(row.label)}"} ${row.value}`);
      }
    }
    const oldest = operational.find((r) => r.metric === 'jobs_oldest_queued_age_seconds');
    lines.push(
      '# HELP intuit_jobs_oldest_queued_age_seconds Age of the oldest due, queued job.',
      '# TYPE intuit_jobs_oldest_queued_age_seconds gauge',
      `intuit_jobs_oldest_queued_age_seconds ${Math.round(oldest?.value ?? 0)}`,
      '',
    );
    return lines.join('\n');
  }
}

/** Constant-time check of the bearer token that protects the endpoint. */
export function metricsTokenMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer (.+)$/i.exec(header ?? '')?.[1];
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
