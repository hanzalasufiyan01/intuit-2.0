import { EventEmitter } from 'node:events';
import { createServer, type request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MfaKeyRing } from '../src/infrastructure/security/mfa-keyring.js';
import {
  HttpsWebhookTransport,
  isPublicAddress,
  SIGNATURE_TOLERANCE_SECONDS,
  signatureHeader,
  signWebhook,
  validateWebhookUrl,
  verifyWebhookSignature,
  WebhookDestinationError,
  WebhookSecretCipher,
  WebhookTransportError,
} from '../src/modules/webhooks/index.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './webhook-tls-fixture.js';

/**
 * ADR 0011 Step 6: the security-critical building blocks of webhooks — destination rules (D7),
 * signing, the secret cipher and the pinned-address transport — with no database.
 */

const refused = (url: string, options?: { allowedPorts?: readonly number[] }) =>
  expect(() => validateWebhookUrl(url, options), url).toThrow(WebhookDestinationError);

describe('webhook destination rules (D7)', () => {
  it('accepts public https DNS names on an allowed port', () => {
    for (const url of [
      'https://hooks.example.com/webhooks',
      'https://hooks.example.com:443/a/b?c=d',
      'https://a.b-c.example.co.uk/x',
      'https://HOOKS.EXAMPLE.COM./x',
    ]) {
      expect(validateWebhookUrl(url).hostname).toMatch(/^[a-z0-9.-]+$/);
    }
    expect(
      validateWebhookUrl('https://hooks.example.com:8443/x', { allowedPorts: [443, 8443] }).port,
    ).toBe(8443);
  });

  it('refuses everything else: scheme, userinfo, fragment, port, IP literals, internal names', () => {
    const bad = [
      'http://hooks.example.com/x',
      'ftp://hooks.example.com/x',
      'https://user:pass@hooks.example.com/x',
      'https://user@hooks.example.com/x',
      'https://hooks.example.com/x#frag',
      'https://hooks.example.com:8443/x',
      'https://hooks.example.com:22/x',
      // IP literals in every notation (the URL parser normalizes the numeric forms)
      'https://127.0.0.1/x',
      'https://8.8.8.8/x',
      'https://2130706433/x',
      'https://0x7f.0.0.1/x',
      'https://0177.0.0.1/x',
      'https://127.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://[2001:4860:4860::8888]/x',
      'https://[::ffff:127.0.0.1]/x',
      // names that are not public DNS names
      'https://localhost/x',
      'https://localhost./x',
      'https://intranet/x',
      'https://printer.local/x',
      'https://db.internal/x',
      'https://nas.lan/x',
      'https://app.localhost/x',
      'https://corp.corp/x',
      'https://-bad.example.com/x',
      'https://exa_mple.com/x',
      'not a url',
      '',
      `https://${'a'.repeat(300)}.example.com/x`,
    ];
    for (const url of bad) refused(url);
    refused(`https://hooks.example.com/${'x'.repeat(2100)}`);
  });
});

describe('public address classification', () => {
  it('allows public unicast addresses', () => {
    for (const a of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '2a00:1450:4009:81f::200e',
    ]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });

  it('refuses loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges', () => {
    for (const a of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '169.254.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
      '192.88.99.1',
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('refuses IPv6 loopback, unspecified, ULA, link-local, multicast and every IPv4-mapped/translated form', () => {
    for (const a of [
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'fe80::1%eth0',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '::ffff:7f00:1',
      '::ffff:0808:0808',
      '64:ff9b::808:808',
      '64:ff9b::7f00:1',
      '100::1',
      '2001:db8::1',
      '2001::1',
      '2002:7f00:1::1',
      '2002:0808:0808::1',
      '2001:10::1',
      '::127.0.0.1',
      '1::1',
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('refuses anything that is not an address', () => {
    for (const a of [
      '',
      'example.com',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '08.8.8.8',
      'zzzz::1',
      '::1::2',
      '1.2.3.4/8',
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });
});

describe('webhook signing (section 11.4)', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"evt_1","type":"customer.created"}';
  const now = 1_800_000_000;

  it('signs "<timestamp>.<delivery id>.<raw body>" with HMAC-SHA256 and verifies it', () => {
    const header = signatureHeader([secret], now, 'delivery-1', body);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(header).toContain(signWebhook(secret, now, 'delivery-1', body));
    const input = { secret, header, deliveryId: 'delivery-1', rawBody: body, nowSeconds: now };
    expect(verifyWebhookSignature(input)).toBe(true);
    // The raw body, the delivery id, the timestamp and the secret are all bound.
    expect(verifyWebhookSignature({ ...input, rawBody: `${body} ` })).toBe(false);
    expect(verifyWebhookSignature({ ...input, deliveryId: 'delivery-2' })).toBe(false);
    expect(verifyWebhookSignature({ ...input, secret: 'whsec_other' })).toBe(false);
    expect(
      verifyWebhookSignature({ ...input, header: header.replace('t=1800000000', 't=1800000001') }),
    ).toBe(false);
    expect(verifyWebhookSignature({ ...input, header: 'v1=abcd' })).toBe(false);
    expect(verifyWebhookSignature({ ...input, header: '' })).toBe(false);
  });

  it('rejects timestamps outside the 5-minute replay window', () => {
    const header = signatureHeader([secret], now, 'd', body);
    const input = { secret, header, deliveryId: 'd', rawBody: body };
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    expect(verifyWebhookSignature({ ...input, nowSeconds: now + 300 })).toBe(true);
    expect(verifyWebhookSignature({ ...input, nowSeconds: now + 301 })).toBe(false);
    expect(verifyWebhookSignature({ ...input, nowSeconds: now - 301 })).toBe(false);
  });

  it('sends both signatures during a rotation overlap, and either secret verifies', () => {
    const header = signatureHeader(['whsec_new', 'whsec_old'], now, 'd', body);
    expect(header.match(/v1=/g)).toHaveLength(2);
    for (const s of ['whsec_new', 'whsec_old']) {
      expect(
        verifyWebhookSignature({
          secret: s,
          header,
          deliveryId: 'd',
          rawBody: body,
          nowSeconds: now,
        }),
      ).toBe(true);
    }
    expect(
      verifyWebhookSignature({
        secret: 'whsec_third',
        header,
        deliveryId: 'd',
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });
});

describe('webhook secret cipher', () => {
  const keys = `a:${Buffer.alloc(32, 1).toString('base64')},b:${Buffer.alloc(32, 2).toString('base64')}`;
  const cipher = new WebhookSecretCipher(MfaKeyRing.parse(keys, 'a'));

  it('seals with AES-256-GCM, never stores the plaintext and opens only for its own endpoint and role', () => {
    const sealed = cipher.seal('whsec_super_secret', 'endpoint-1', 1);
    expect(sealed.keyId).toBe('a');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('super_secret');
    expect(sealed.ciphertext.toString('base64')).not.toContain('super_secret');
    expect(cipher.open(sealed, 'endpoint-1', 1)).toBe('whsec_super_secret');
    // Bound to its endpoint, rotation and role.
    expect(() => cipher.open(sealed, 'endpoint-2', 1)).toThrow();
    expect(() => cipher.open(sealed, 'endpoint-1', 2)).toThrow();
    expect(() => cipher.open(sealed, 'endpoint-1', 1, 'previous')).toThrow();
    // Tampering is detected.
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;
    expect(() => cipher.open(tampered, 'endpoint-1', 1)).toThrow();
    // Fresh IV every time.
    expect(cipher.seal('whsec_super_secret', 'endpoint-1', 1).iv.equals(sealed.iv)).toBe(false);
  });

  it('opens what an earlier key sealed after the active key changed (key rotation)', () => {
    const sealed = cipher.seal('whsec_x', 'e', 1);
    const rotated = new WebhookSecretCipher(MfaKeyRing.parse(keys, 'b'));
    expect(rotated.open(sealed, 'e', 1)).toBe('whsec_x');
    expect(rotated.seal('whsec_x', 'e', 1).keyId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// The transport without a handshake: a fake HTTPS client observes exactly what is connected to
// ---------------------------------------------------------------------------

interface FakeCall {
  options: Record<string, any>;
  written: string;
  pinned: { address: string; family: number } | null;
}

/** A stand-in for `https.request` that answers with a scripted response and records the call. */
function fakeHttps(
  script: (call: FakeCall) => { status: number; chunks?: Buffer[]; hang?: boolean },
) {
  const calls: FakeCall[] = [];
  const request = ((options: Record<string, any>) => {
    const req = new EventEmitter() as EventEmitter & Record<string, any>;
    const call: FakeCall = { options, written: '', pinned: null };
    // The connection resolves the host through the supplied lookup: that is where the pin shows.
    options.lookup('ignored.example.test', {}, (_e: null, address: string, family: number) => {
      call.pinned = { address, family };
    });
    calls.push(call);
    req.write = (data: string | Buffer) => {
      call.written += data.toString();
      return true;
    };
    req.destroy = () => undefined;
    req.end = () => {
      const result = script(call);
      if (result.hang) return;
      setImmediate(() => {
        const res = new PassThrough() as PassThrough & { statusCode?: number };
        res.statusCode = result.status;
        req.emit('response', res);
        for (const chunk of result.chunks ?? []) res.write(chunk);
        res.end();
      });
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, calls };
}

describe('webhook transport (pinning, redirects, limits; no handshake)', () => {
  const publicResolve = async () => [
    { address: '93.184.216.34', family: 4 as const },
    { address: '93.184.216.35', family: 4 as const },
  ];
  const message = {
    url: 'https://hooks.example.com/in/coming?x=1',
    body: '{"a":1}',
    headers: { 'content-type': 'application/json' },
  };

  it('connects to the validated address, keeping the host name for SNI and Host', async () => {
    const fake = fakeHttps(() => ({ status: 200, chunks: [Buffer.from('{"ok":true}')] }));
    const transport = new HttpsWebhookTransport({ resolve: publicResolve, request: fake.request });
    const response = await transport.send(message);
    expect(response).toMatchObject({ statusCode: 200, excerpt: '{"ok":true}' });
    const [call] = fake.calls;
    expect(call!.options).toMatchObject({
      method: 'POST',
      hostname: 'hooks.example.com',
      port: 443,
      path: '/in/coming?x=1',
      servername: 'hooks.example.com',
      agent: false,
    });
    expect(call!.options.headers).toMatchObject({
      host: 'hooks.example.com',
      'content-length': '7',
      'content-type': 'application/json',
    });
    // The connection is pinned to a validated answer, never to a second resolution of the name.
    expect(call!.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    expect(call!.written).toBe('{"a":1}');
    // Certificate verification is never switched off.
    expect(call!.options).not.toHaveProperty('rejectUnauthorized');
  });

  it('never follows a redirect: a 3xx is the response and no second request is made', async () => {
    const fake = fakeHttps(() => ({ status: 301, chunks: [Buffer.from('moved')] }));
    const transport = new HttpsWebhookTransport({ resolve: publicResolve, request: fake.request });
    expect(await transport.send(message)).toMatchObject({ statusCode: 301 });
    expect(fake.calls).toHaveLength(1);
  });

  it('reads at most 64 KB and keeps a 1 KB excerpt without control characters', async () => {
    const big = fakeHttps(() => ({
      status: 500,
      chunks: Array.from({ length: 12 }, () => Buffer.alloc(16 * 1024, 'x')),
    }));
    const response = await new HttpsWebhookTransport({
      resolve: publicResolve,
      request: big.request,
    }).send(message);
    expect(response.statusCode).toBe(500);
    expect(response.excerpt.length).toBe(1024);
    const binary = fakeHttps(() => ({
      status: 200,
      chunks: [Buffer.from([0, 1, 2, 7, 27, 65, 66, 10])],
    }));
    const text = (
      await new HttpsWebhookTransport({ resolve: publicResolve, request: binary.request }).send(
        message,
      )
    ).excerpt;
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(text).toContain('AB');
  });

  it('applies the total timeout', async () => {
    const fake = fakeHttps(() => ({ status: 200, hang: true }));
    const transport = new HttpsWebhookTransport({
      resolve: publicResolve,
      request: fake.request,
      totalTimeoutMs: 100,
    });
    await expect(transport.send(message)).rejects.toMatchObject({ errorClass: 'timeout' });
  });

  it('refuses a destination when ANY resolved address is not public, before connecting', async () => {
    const fake = fakeHttps(() => ({ status: 200 }));
    const strict = (addresses: string[]) =>
      new HttpsWebhookTransport({
        resolve: async () =>
          addresses.map((address) => ({
            address,
            family: address.includes(':') ? (6 as const) : (4 as const),
          })),
        request: fake.request,
      });
    for (const addresses of [
      ['127.0.0.1'],
      ['10.0.0.5'],
      ['169.254.169.254'],
      ['::1'],
      ['::ffff:10.0.0.1'],
      // one public answer does not excuse a private one
      ['93.184.216.34', '10.0.0.5'],
      ['10.0.0.5', '93.184.216.34'],
    ]) {
      const t = strict(addresses);
      await expect(t.checkDestination(message.url), addresses.join()).rejects.toMatchObject({
        errorClass: 'blocked_address',
      });
      await expect(t.send(message), addresses.join()).rejects.toMatchObject({
        errorClass: 'blocked_address',
      });
    }
    expect(fake.calls).toHaveLength(0); // nothing was ever connected to
    for (const resolve of [
      async () => {
        throw new Error('nx');
      },
      async () => [],
    ]) {
      await expect(
        new HttpsWebhookTransport({ resolve, request: fake.request }).checkDestination(message.url),
      ).rejects.toMatchObject({ errorClass: 'dns' });
    }
  });

  it('resolves again on every send, so a DNS rebinding answer is caught at delivery time', async () => {
    let calls = 0;
    const fake = fakeHttps(() => ({ status: 200 }));
    const rebinding = new HttpsWebhookTransport({
      // Public at the first check (create/update), private afterwards.
      resolve: async () => [{ address: calls++ === 0 ? '93.184.216.34' : '10.0.0.5', family: 4 }],
      request: fake.request,
    });
    await expect(rebinding.checkDestination(message.url)).resolves.toBeUndefined();
    await expect(rebinding.send(message)).rejects.toMatchObject({ errorClass: 'blocked_address' });
    expect(calls).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it('applies the syntactic rules before resolving anything', async () => {
    let resolved = false;
    const t = new HttpsWebhookTransport({
      resolve: async () => {
        resolved = true;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    for (const bad of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://a.example.com:9999/x',
    ]) {
      await expect(t.send({ url: bad, body: '{}', headers: {} }), bad).rejects.toMatchObject({
        errorClass: 'invalid_url',
      });
    }
    expect(resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The transport against a real local TLS server. Skipped where something between this process
// and the server re-signs certificates (some antivirus products do); the fake-client tests above
// cover the same behavior without a handshake.
// ---------------------------------------------------------------------------

describe('webhook transport over real TLS', () => {
  let server: Server;
  let port: number;
  let tlsUsable = false;
  let redirectTargetHits = 0;
  const seen: { host: string | undefined; sni: string | false | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const socket = req.socket as unknown as { servername?: string | false };
        seen.push({
          host: req.headers.host,
          sni: socket.servername,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/redirect-target' }).end('moved');
        } else if (req.url === '/redirect-target') {
          redirectTargetHits += 1;
          res.writeHead(200).end('ok');
        } else if (req.url === '/slow') {
          // never answers
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    tlsUsable = await new Promise<boolean>((resolve) => {
      const probe = connect(
        { host: '127.0.0.1', port, servername: 'hooks.example.test', ca: TEST_TLS_CERT },
        () => {
          resolve(probe.authorized);
          probe.destroy();
        },
      );
      probe.on('error', () => resolve(false));
    });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const transport = (overrides: ConstructorParameters<typeof HttpsWebhookTransport>[0] = {}) =>
    new HttpsWebhookTransport({
      allowedPorts: [port],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      // Only the test lets loopback through; the default policy refuses it (tested above).
      isAllowedAddress: () => true,
      tls: { ca: TEST_TLS_CERT },
      ...overrides,
    });
  const request = (path = '/hook', host = 'hooks.example.test') => ({
    url: `https://${host}:${port}${path}`,
    body: '{"hello":"world"}',
    headers: { 'content-type': 'application/json' },
  });

  it('delivers over verified TLS with SNI and Host of the original name', async (t) => {
    if (!tlsUsable) return t.skip();
    const response = await transport().send(request());
    expect(response).toMatchObject({ statusCode: 200, excerpt: '{"received":true}' });
    expect(seen.at(-1)).toEqual({
      host: `hooks.example.test:${port}`,
      sni: 'hooks.example.test',
      body: '{"hello":"world"}',
    });
  });

  it('does not follow a redirect, and times out a server that never answers', async (t) => {
    if (!tlsUsable) return t.skip();
    const before = redirectTargetHits;
    expect((await transport().send(request('/redirect'))).statusCode).toBe(302);
    expect(redirectTargetHits).toBe(before);
    await expect(transport({ totalTimeoutMs: 300 }).send(request('/slow'))).rejects.toMatchObject({
      errorClass: 'timeout',
    });
  });

  it('fails on an untrusted authority and on a name the certificate does not cover', async () => {
    // Holds whether or not something intercepts TLS: neither case may succeed.
    const untrusted = new HttpsWebhookTransport({
      allowedPorts: [port],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isAllowedAddress: () => true,
    });
    await expect(untrusted.send(request())).rejects.toMatchObject({ errorClass: 'tls' });
    await expect(transport().send(request('/hook', 'other.example.test'))).rejects.toBeInstanceOf(
      WebhookTransportError,
    );
  });
});
