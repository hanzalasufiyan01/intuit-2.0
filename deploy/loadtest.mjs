#!/usr/bin/env node
// A small, dependency-free load test for a running instance (read paths of a signed-in user).
//
//   BASE_URL=http://localhost:3000 LOAD_EMAIL=load@example.test LOAD_PASSWORD='...' \
//   DURATION_SECONDS=30 CONCURRENCY=20 node deploy/loadtest.mjs
//
// With REGISTER=yes it first registers LOAD_EMAIL (a throwaway account in a throwaway organization)
// so a fresh development database can be exercised. Never point it at production with REGISTER=yes.
// It only issues GET requests after the sign-in, reports requests per second and latency
// percentiles per endpoint, and exits 1 when the error rate exceeds MAX_ERROR_RATE (default 1%) or
// the p95 of any endpoint exceeds P95_BUDGET_MS (default 1500).
const base = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const api = `${base}/api/v1`;
const email = process.env.LOAD_EMAIL ?? `load-${Date.now()}@example.test`;
const password = process.env.LOAD_PASSWORD ?? 'Load-test-passw0rd!x';
const duration = Number(process.env.DURATION_SECONDS ?? 30) * 1000;
const concurrency = Number(process.env.CONCURRENCY ?? 20);
const maxErrorRate = Number(process.env.MAX_ERROR_RATE ?? 0.01);
const p95Budget = Number(process.env.P95_BUDGET_MS ?? 1500);
const paths = (
  process.env.LOAD_PATHS ??
  '/auth/session,/organizations/current,/organizations/current/roles,/customers?limit=20,/parties?limit=20'
).split(',');

let cookie = '';
let csrf = '';

import { createHmac } from 'node:crypto';
const base32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (secret) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
};
const remember = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = `${c.split(';')[0]}`;
};
const json = (method, path, body) =>
  fetch(`${api}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

if (process.env.REGISTER === 'yes') {
  const res = await json('POST', '/auth/register', {
    email,
    password,
    displayName: 'Load Test',
    organizationName: `Load Test ${Date.now()}`,
  });
  if (res.status !== 201 && res.status !== 200) {
    console.error(`register failed: ${res.status} ${await res.text()}`);
    process.exit(2);
  }
  remember(res);
}
if (process.env.REGISTER === 'yes') {
  // A new organization requires two-step verification: enrol a throwaway authenticator.
  const session = await (await json('GET', '/auth/session')).json();
  csrf = session.data.csrfToken;
  const started = await (await json('POST', '/auth/mfa/totp/enroll', {})).json();
  const verified = await json('POST', '/auth/mfa/totp/verify', {
    enrollmentId: started.data.enrollmentId,
    code: totp(started.data.secret),
  });
  if (!verified.ok) {
    console.error(`MFA enrolment failed: ${verified.status} ${await verified.text()}`);
    process.exit(2);
  }
  remember(verified);
}
if (!cookie) {
  const login = await json('POST', '/auth/login', { email, password });
  if (!login.ok) {
    console.error(`login failed: ${login.status} ${await login.text()}`);
    process.exit(2);
  }
  remember(login);
}

const samples = new Map(paths.map((p) => [p, { ok: 0, bad: 0, ms: [] }]));
const stopAt = Date.now() + duration;
const started = Date.now();
async function worker(offset) {
  let i = offset;
  while (Date.now() < stopAt) {
    const path = paths[i++ % paths.length];
    const s = samples.get(path);
    const t0 = performance.now();
    try {
      const res = await fetch(`${api}${path}`, { headers: { cookie } });
      await res.arrayBuffer();
      s.ms.push(performance.now() - t0);
      if (res.status >= 200 && res.status < 400) s.ok += 1;
      else s.bad += 1;
    } catch {
      s.bad += 1;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, n) => worker(n)));
const seconds = (Date.now() - started) / 1000;

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
let total = 0;
let bad = 0;
let worstP95 = 0;
console.log(`base=${base} concurrency=${concurrency} duration=${seconds.toFixed(1)}s`);
console.log(
  'endpoint'.padEnd(46),
  'req'.padStart(7),
  'err'.padStart(5),
  'p50'.padStart(7),
  'p95'.padStart(7),
  'p99'.padStart(7),
);
for (const [path, s] of samples) {
  const sorted = [...s.ms].sort((a, b) => a - b);
  total += s.ok + s.bad;
  bad += s.bad;
  worstP95 = Math.max(worstP95, pct(sorted, 0.95));
  console.log(
    path.padEnd(46),
    String(s.ok + s.bad).padStart(7),
    String(s.bad).padStart(5),
    pct(sorted, 0.5).toFixed(0).padStart(7),
    pct(sorted, 0.95).toFixed(0).padStart(7),
    pct(sorted, 0.99).toFixed(0).padStart(7),
  );
}
const rate = total ? bad / total : 1;
console.log(
  `total=${total} rps=${(total / seconds).toFixed(1)} errorRate=${(rate * 100).toFixed(2)}% worstP95=${worstP95.toFixed(0)}ms`,
);
if (rate > maxErrorRate || worstP95 > p95Budget) {
  console.error('LOAD TEST FAILED: error rate or latency budget exceeded');
  process.exit(1);
}
console.log('Load test passed.');
