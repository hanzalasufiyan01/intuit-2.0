import { randomInt, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuiltApp } from '../src/app.js';
import { createDatabase, type DatabaseHandle } from '../src/database/client.js';
import type { Clock } from '../src/infrastructure/clock.js';
import { loadConfig, type AppConfig } from '../src/infrastructure/config/config.js';
import { loadEnvFile } from '../src/infrastructure/config/load-env.js';
import { MockEmailProvider } from '../src/infrastructure/email/email-provider.js';
import { createArgon2idPasswordHasher } from '../src/infrastructure/security/password-hasher.js';
import { base32Decode, totpCode, totpStep } from '../src/infrastructure/security/totp.js';

loadEnvFile();

export const TEST_PASSWORD = 'correct horse battery staple';
export const WEB_ORIGIN_OVERRIDE = 'http://localhost:5173';
/** Test file storage lives outside the repository (S5). */
export const TEST_STORAGE_ROOT = path.join(tmpdir(), 'intuit2-test-storage');

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
    STORAGE_LOCAL_ROOT: TEST_STORAGE_ROOT,
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
    client: (ip) => new TestClient(built.app, config, ip ?? randomIp(), clock),
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

/**
 * TOTP secrets of users the harness enrolled (S7-44), keyed by email, with the last time step it
 * used (replay protection means each code works once). Shared across test contexts.
 */
const harnessMfa = new Map<string, { secret: Buffer; lastStep: number }>();
/** Latest remembered-device token per user email (tokens rotate on every sign-in). */
const harnessDevices = new Map<string, string>();

/** Records a secret the test itself enrolled, so the harness can answer later challenges. */
export function rememberMfaSecret(email: string, secretBase32: string, lastStep: number): void {
  harnessMfa.set(email.toLowerCase(), { secret: base32Decode(secretBase32), lastStep });
}

/** A fresh, never-used code for a harness-enrolled user at `now` (window +1 at most). */
export function nextTotpCode(email: string, now: Date): string {
  const entry = harnessMfa.get(email.toLowerCase());
  if (!entry) throw new Error(`No MFA secret known for ${email}`);
  const current = totpStep(now);
  const step = Math.max(current, entry.lastStep + 1);
  if (step > current + 1) throw new Error('No unused TOTP step left; advance the test clock');
  entry.lastStep = step;
  return totpCode(entry.secret, step);
}

/**
 * Browser-like API client: keeps the session cookie (and the remembered-device cookie) and sends
 * the CSRF token. With `autoMfa` (default) it behaves like a user who set up an authenticator
 * when asked: MFA_ENROLLMENT_REQUIRED triggers enrollment, a login challenge is answered with a
 * code (remembering the device), then the request is retried. It never bypasses enforcement;
 * dedicated MFA tests turn `autoMfa` off to observe every step.
 */
export class TestClient {
  sessionToken: string | undefined;
  csrfToken: string | undefined;
  deviceToken: string | undefined;
  email: string | undefined;
  autoMfa = true;
  /** One enrollment / step-up at a time; concurrent requests wait for it, then retry once. */
  private mfaWork: Promise<unknown> | null = null;

  constructor(
    readonly app: FastifyInstance,
    readonly config: AppConfig,
    readonly ip: string,
    readonly clock: Clock = { now: () => new Date() },
  ) {}

  async request<T = any>(
    method: Method,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
    retried = false,
  ): Promise<ApiResponse<T>> {
    const allHeaders: Record<string, string> = { ...headers };
    const cookies: string[] = [];
    if (this.sessionToken) cookies.push(`${this.config.session.cookieName}=${this.sessionToken}`);
    if (this.deviceToken && url.startsWith('/auth')) {
      cookies.push(`${this.config.mfa.trustedDeviceCookieName}=${this.deviceToken}`);
    }
    if (cookies.length > 0 && !('cookie' in headers)) allHeaders.cookie = cookies.join('; ');
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
      const cleared =
        cookie.value === '' || (cookie.expires && cookie.expires.getTime() <= Date.now());
      if (cookie.name === this.config.session.cookieName) {
        this.sessionToken = cleared ? undefined : cookie.value;
        if (cleared) this.csrfToken = undefined;
      } else if (cookie.name === this.config.mfa.trustedDeviceCookieName) {
        this.deviceToken = cleared ? undefined : cookie.value;
        if (this.email) {
          if (cleared) harnessDevices.delete(this.email.toLowerCase());
          else harnessDevices.set(this.email.toLowerCase(), cookie.value);
        }
      }
    }
    const parsed = response.body ? (JSON.parse(response.body) as T) : (undefined as T);
    const data = (parsed as { data?: Record<string, any> } | undefined)?.data;
    const maybeCsrf = data?.csrfToken;
    if (typeof maybeCsrf === 'string') this.csrfToken = maybeCsrf;
    const maybeEmail = data?.user?.email ?? data?.session?.user?.email;
    if (typeof maybeEmail === 'string') this.email = maybeEmail;
    const result = {
      status: response.statusCode,
      body: parsed,
      headers: response.headers,
      raw: response,
    };

    const errorCode = (parsed as { error?: { code?: string } } | undefined)?.error?.code;
    if (this.autoMfa && !retried && errorCode === 'MFA_ENROLLMENT_REQUIRED') {
      await this.once(() => this.enrollMfa());
      return this.request<T>(method, url, body, headers, true);
    }
    if (
      this.autoMfa &&
      !retried &&
      (errorCode === 'MFA_VERIFICATION_REQUIRED' || errorCode === 'MFA_STEP_UP_REQUIRED') &&
      this.email &&
      harnessMfa.has(this.email.toLowerCase())
    ) {
      await this.once(() => this.stepUp());
      return this.request<T>(method, url, body, headers, true);
    }
    return result;
  }

  private async once(work: () => Promise<unknown>): Promise<void> {
    this.mfaWork ??= work().finally(() => {
      this.mfaWork = null;
    });
    await this.mfaWork;
  }

  /** Sets up an authenticator for the signed-in user, as the enrollment screen would. */
  async enrollMfa(): Promise<{ secret: string; recoveryCodes: string[] | null }> {
    if (!this.email) {
      const current = await this.get('/auth/session');
      if (current.status !== 200) throw new Error(`enrollMfa: no session (${current.status})`);
    }
    let started = await this.post('/auth/mfa/totp/enroll', {});
    if (started.body?.error?.code === 'REAUTHENTICATION_REQUIRED') {
      await this.reauthenticate();
      started = await this.post('/auth/mfa/totp/enroll', {});
    }
    if (started.status !== 200) {
      throw new Error(`enroll failed: ${started.status} ${JSON.stringify(started.body)}`);
    }
    const secret: string = started.body.data.secret;
    const step = totpStep(this.clock.now());
    rememberMfaSecret(this.email!, secret, step);
    const verified = await this.post('/auth/mfa/totp/verify', {
      enrollmentId: started.body.data.enrollmentId,
      code: totpCode(base32Decode(secret), step),
    });
    if (verified.status !== 200) {
      throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
    }
    return { secret, recoveryCodes: verified.body.data.recoveryCodes };
  }

  /** A fresh code for this client's user. */
  totp(): string {
    if (!this.email) throw new Error('totp: unknown user');
    return nextTotpCode(this.email, this.clock.now());
  }

  stepUp(code?: string) {
    return this.post('/auth/mfa/step-up', { method: 'totp', code: code ?? this.totp() });
  }

  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}) => this.request<T>('POST', url, body);
  put = <T = any>(url: string, body: unknown = {}) => this.request<T>('PUT', url, body);
  patch = <T = any>(url: string, body: unknown = {}) => this.request<T>('PATCH', url, body);
  delete = <T = any>(url: string) => this.request<T>('DELETE', url);

  /** Raw file upload as the web client sends it (S5-21). */
  upload<T = any>(
    url: string,
    content: Buffer,
    fileName: string,
    headers: Record<string, string> = {},
  ) {
    return this.request<T>('POST', url, content, {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(fileName),
      ...headers,
    });
  }

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

  /**
   * Signs in. With `autoMfa`, a challenge for a harness-enrolled user is answered (remembering
   * the device), so the result is a complete session like a pre-MFA sign-in.
   */
  async login(email: string, password = TEST_PASSWORD) {
    this.email = email;
    this.deviceToken ??= harnessDevices.get(email.toLowerCase());
    const response = await this.post('/auth/login', { email, password });
    if (
      this.autoMfa &&
      response.status === 200 &&
      response.body?.data?.authentication === 'mfa_required' &&
      harnessMfa.has(email.toLowerCase())
    ) {
      return this.post('/auth/mfa/challenge', {
        method: 'totp',
        code: this.totp(),
        rememberDevice: true,
      });
    }
    return response;
  }

  reauthenticate(password = TEST_PASSWORD) {
    return this.post('/auth/reauthenticate', { password });
  }
}

/** Extracts the raw token from the most recent mock email link sent to an address. */
export function tokenFromEmail(email: MockEmailProvider, to: string): string {
  // The latest message with a link (MFA notices may arrive after it, S7-26).
  const normalized = to.trim().toLowerCase();
  const message = email.sent.findLast(
    (m) => m.to.trim().toLowerCase() === normalized && /#token=/.test(m.text),
  );
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
