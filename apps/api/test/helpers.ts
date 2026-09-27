import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuiltApp } from '../src/app.js';
import { createDatabase, type DatabaseHandle } from '../src/database/client.js';
import type { Clock } from '../src/infrastructure/clock.js';
import { loadConfig, type AppConfig } from '../src/infrastructure/config/config.js';
import { loadEnvFile } from '../src/infrastructure/config/load-env.js';
import { MockEmailProvider } from '../src/infrastructure/email/email-provider.js';
import { createArgon2idPasswordHasher } from '../src/infrastructure/security/password-hasher.js';

loadEnvFile();

export const TEST_PASSWORD = 'correct horse battery staple';
export const WEB_ORIGIN_OVERRIDE = 'http://localhost:5173';

export class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function uniqueEmail(label = 'user'): string {
  return `${label}-${randomUUID()}@example.test`;
}

/** A distinct client IP per test client keeps per-IP login protection independent. */
export function randomIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export interface TestContext extends BuiltApp {
  config: AppConfig;
  clock: TestClock;
  email: MockEmailProvider;
  database: DatabaseHandle;
  logs: string[];
  client(ip?: string): TestClient;
  close(): Promise<void>;
}

export async function createTestContext(
  overrides: Partial<Record<string, string>> = {},
): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    APP_ENV: 'testing',
    LOG_LEVEL: 'info',
    WEB_ORIGIN: WEB_ORIGIN_OVERRIDE,
    ...overrides,
  });
  const database = createDatabase({ connectionString: config.database.url, poolMax: 5 });
  const clock = new TestClock();
  const email = new MockEmailProvider(config.email.from);
  const logs: string[] = [];
  const built = await buildApp({
    deps: {
      db: database.db,
      config,
      clock,
      passwordHasher: createArgon2idPasswordHasher(),
      emailProvider: email,
    },
    logStream: { write: (line) => void logs.push(line) },
  });
  await built.app.ready();
  return {
    ...built,
    config,
    clock,
    email,
    database,
    logs,
    client: (ip) => new TestClient(built.app, config, ip ?? randomIp()),
    close: async () => {
      await built.app.close();
      await database.close();
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: LightMyRequestResponse['headers'];
  raw: LightMyRequestResponse;
}

/** Browser-like API client: keeps the session cookie and sends the CSRF token. */
export class TestClient {
  sessionToken: string | undefined;
  csrfToken: string | undefined;

  constructor(
    readonly app: FastifyInstance,
    readonly config: AppConfig,
    readonly ip: string,
  ) {}

  async request<T = any>(
    method: Method,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const allHeaders: Record<string, string> = { ...headers };
    if (this.sessionToken)
      allHeaders.cookie = `${this.config.session.cookieName}=${this.sessionToken}`;
    if (method !== 'GET' && this.csrfToken && !('x-csrf-token' in headers)) {
      allHeaders['x-csrf-token'] = this.csrfToken;
    }
    const response = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: allHeaders,
      remoteAddress: this.ip,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    for (const cookie of response.cookies as { name: string; value: string; expires?: Date }[]) {
      if (cookie.name !== this.config.session.cookieName) continue;
      const cleared =
        cookie.value === '' || (cookie.expires && cookie.expires.getTime() <= Date.now());
      this.sessionToken = cleared ? undefined : cookie.value;
      if (cleared) this.csrfToken = undefined;
    }
    const parsed = response.body ? (JSON.parse(response.body) as T) : (undefined as T);
    const maybeCsrf = (parsed as { data?: { csrfToken?: unknown } } | undefined)?.data?.csrfToken;
    if (typeof maybeCsrf === 'string') this.csrfToken = maybeCsrf;
    return { status: response.statusCode, body: parsed, headers: response.headers, raw: response };
  }

  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}) => this.request<T>('POST', url, body);
  put = <T = any>(url: string, body: unknown = {}) => this.request<T>('PUT', url, body);
  patch = <T = any>(url: string, body: unknown = {}) => this.request<T>('PATCH', url, body);
  delete = <T = any>(url: string) => this.request<T>('DELETE', url);

  async register(
    input: Partial<{
      email: string;
      password: string;
      displayName: string;
      organizationName: string;
    }> = {},
  ) {
    const payload = {
      email: input.email ?? uniqueEmail(),
      password: input.password ?? TEST_PASSWORD,
      displayName: input.displayName ?? 'Test User',
      organizationName: input.organizationName ?? `Org ${randomUUID().slice(0, 8)}`,
    };
    const response = await this.post('/auth/register', payload);
    if (response.status !== 201) {
      throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return { ...payload, session: response.body.data };
  }

  login(email: string, password = TEST_PASSWORD) {
    return this.post('/auth/login', { email, password });
  }

  reauthenticate(password = TEST_PASSWORD) {
    return this.post('/auth/reauthenticate', { password });
  }
}

/** Extracts the raw token from the most recent mock email link sent to an address. */
export function tokenFromEmail(email: MockEmailProvider, to: string): string {
  const message = email.lastTo(to);
  const match = message?.text.match(/#token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`No token email found for ${to}`);
  return match[1];
}

/** Direct connections with each database role, for database-level assertions. */
export async function connectAs(role: 'app' | 'owner'): Promise<pg.Client> {
  const url = role === 'app' ? process.env.DATABASE_URL : process.env.DATABASE_MIGRATION_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
