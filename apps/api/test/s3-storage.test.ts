import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/infrastructure/config/config.js';
import {
  S3Error,
  S3StorageProvider,
  signRequest,
  storageKeyFor,
  tenantPrefix,
  type FetchLike,
  type S3Config,
} from '../src/modules/files/index.js';

/**
 * S3-compatible storage (FP-19): the SigV4 signer against the published AWS test vector, and the
 * provider against an in-memory fake object store that also re-verifies every signature, so
 * addressing styles, payload hashing, listing pagination, error handling and key safety are
 * exercised without a network.
 */

describe('AWS Signature Version 4', () => {
  it('matches the published AWS get-vanilla test vector', () => {
    const signed = signRequest({
      method: 'GET',
      canonicalPath: '/',
      query: [],
      headers: { host: 'example.amazonaws.com' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('changes the signature when any signed part changes', () => {
    const base = {
      method: 'GET',
      canonicalPath: '/b/k',
      query: [] as [string, string][],
      headers: { host: 'h' },
      payloadHash: 'a'.repeat(64),
      region: 'r',
      service: 's3',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      now: new Date('2026-03-01T00:00:00Z'),
    };
    const sig = (o: Partial<typeof base>) => signRequest({ ...base, ...o }).authorization;
    const reference = sig({});
    expect(sig({})).toBe(reference);
    for (const change of [
      { method: 'PUT' },
      { canonicalPath: '/b/other' },
      { query: [['a', 'b']] as [string, string][] },
      { headers: { host: 'other' } },
      { payloadHash: 'b'.repeat(64) },
      { region: 'x' },
      { secretAccessKey: 'other' },
      { now: new Date('2026-03-01T00:00:01Z') },
    ]) {
      expect(sig(change)).not.toBe(reference);
    }
  });
});

const CONFIG: S3Config = {
  endpoint: 'https://s3.example.test',
  region: 'eu-west-1',
  bucket: 'intuit-files',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'super-secret-value-123',
  forcePathStyle: false,
  timeoutMs: 5000,
};

/** An in-memory S3 that re-verifies the signature of every request. */
function fakeS3(config: S3Config, options: { pageSize?: number; failWith?: number } = {}) {
  const objects = new Map<string, { body: Buffer; modifiedAt: Date }>();
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    requests.push({ method: init.method ?? 'GET', url: input, headers });
    if (options.failWith) {
      return new Response(`<Error>secret ${config.secretAccessKey}</Error>`, {
        status: options.failWith,
      });
    }
    // Re-sign what was received and compare.
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const signedHeaderNames = /SignedHeaders=([^,]+)/.exec(headers.authorization!)![1]!.split(';');
    const resend: Record<string, string> = {};
    for (const name of signedHeaderNames) {
      resend[name] = name === 'host' ? url.host : headers[name]!;
    }
    delete resend['x-amz-date'];
    const expected = signRequest({
      method: init.method ?? 'GET',
      canonicalPath: url.pathname,
      query: [...url.searchParams.entries()].map(([k, v]) => [k, v] as const),
      headers: resend,
      payloadHash: headers['x-amz-content-sha256']!,
      region: config.region,
      service: 's3',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      now: new Date(
        headers['x-amz-date']!.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z',
        ),
      ),
    }).authorization;
    if (expected !== headers.authorization) return new Response('bad signature', { status: 403 });
    const { createHash } = await import('node:crypto');
    if (
      body.length &&
      createHash('sha256').update(body).digest('hex') !== headers['x-amz-content-sha256']
    ) {
      return new Response('bad payload hash', { status: 400 });
    }
    const pathStyle = config.forcePathStyle;
    const bucketOk = pathStyle
      ? url.pathname.startsWith(`/${config.bucket}`)
      : url.host.startsWith(`${config.bucket}.`);
    if (!bucketOk) return new Response('wrong bucket', { status: 404 });
    const key = decodeURIComponent(
      (pathStyle ? url.pathname.slice(config.bucket.length + 1) : url.pathname).replace(/^\//, ''),
    );
    switch (init.method) {
      case 'PUT':
        objects.set(key, { body, modifiedAt: new Date('2026-03-01T00:00:00Z') });
        return new Response(null, { status: 200 });
      case 'GET': {
        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = Number(url.searchParams.get('continuation-token') ?? 0);
          const size = options.pageSize ?? 1000;
          const page = all.slice(start, start + size);
          const more = start + size < all.length;
          return new Response(
            `<?xml version="1.0"?><ListBucketResult>${page
              .map(
                (k) =>
                  `<Contents><Key>${k}</Key><LastModified>${objects.get(k)!.modifiedAt.toISOString()}</LastModified></Contents>`,
              )
              .join('')}<IsTruncated>${more}</IsTruncated>${
              more ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ''
            }</ListBucketResult>`,
            { status: 200 },
          );
        }
        const found = objects.get(key);
        return found
          ? new Response(new Uint8Array(found.body), { status: 200 })
          : new Response('<Error>NoSuchKey</Error>', { status: 404 });
      }
      case 'HEAD':
        return new Response(null, { status: objects.has(key) ? 200 : 404 });
      case 'DELETE':
        objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return new Response('?', { status: 405 });
    }
  };
  return { objects, requests, fetchImpl };
}

const read = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

const newKey = (org = randomUUID()) =>
  storageKeyFor(org, randomUUID(), new Date('2026-03-15T00:00:00Z'));

describe.each([
  ['virtual-hosted style', false],
  ['path style', true],
])('S3 storage provider (%s)', (_label, forcePathStyle) => {
  const config = { ...CONFIG, forcePathStyle };
  const make = (options = {}) => {
    const fake = fakeS3(config, options);
    return {
      fake,
      provider: new S3StorageProvider(
        config,
        fake.fetchImpl,
        () => new Date('2026-03-01T10:00:00Z'),
      ),
    };
  };

  it('stores, reads, checks and deletes an object with verified signatures', async () => {
    const { fake, provider } = make();
    const key = newKey();
    const content = Buffer.from('hello object storage');
    expect(await provider.exists(key)).toBe(false);
    await provider.put(key, Readable.from(content));
    expect(await provider.exists(key)).toBe(true);
    expect((await read(await provider.get(key))).toString()).toBe('hello object storage');
    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
    await provider.delete(key); // deleting a missing object is not an error
    expect(
      fake.requests.every((r) => r.headers.authorization?.startsWith('AWS4-HMAC-SHA256')),
    ).toBe(true);
    // The secret never travels.
    expect(JSON.stringify(fake.requests)).not.toContain(config.secretAccessKey);
  });

  it('lists a tenant prefix across pages and never returns another tenant', async () => {
    const { provider } = make({ pageSize: 2 });
    const orgA = randomUUID();
    const orgB = randomUUID();
    const keysA = [newKey(orgA), newKey(orgA), newKey(orgA), newKey(orgA), newKey(orgA)];
    for (const key of keysA) await provider.put(key, Readable.from(Buffer.from('x')));
    await provider.put(newKey(orgB), Readable.from(Buffer.from('y')));
    const listed = await provider.list(tenantPrefix(orgA));
    expect(listed.map((o) => o.key).sort()).toEqual([...keysA].sort());
    expect(listed[0]!.modifiedAt).toEqual(new Date('2026-03-01T00:00:00Z'));
    expect(await provider.list(tenantPrefix(randomUUID()))).toEqual([]);
  });

  it('refuses keys and prefixes it did not generate', async () => {
    const { fake, provider } = make();
    for (const key of ['../etc/passwd', 'org/x/y', `org/${randomUUID()}/2026/03/not-a-uuid`, '']) {
      await expect(provider.put(key, Readable.from(Buffer.from('x')))).rejects.toThrow(
        /Invalid storage key/,
      );
      await expect(provider.get(key)).rejects.toThrow(/Invalid storage key/);
      await expect(provider.delete(key)).rejects.toThrow(/Invalid storage key/);
      await expect(provider.exists(key)).rejects.toThrow(/Invalid storage key/);
    }
    await expect(provider.list('org/')).rejects.toThrow(/Invalid tenant prefix/);
    await expect(provider.list('')).rejects.toThrow(/Invalid tenant prefix/);
    expect(fake.requests).toEqual([]);
  });

  it('reports failures by status only, without echoing the response or credentials', async () => {
    const { provider } = make({ failWith: 500 });
    const key = newKey();
    const error = await provider.put(key, Readable.from(Buffer.from('x'))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect((error as S3Error).status).toBe(500);
    expect(String((error as Error).message)).not.toContain(config.secretAccessKey);
    await expect(provider.get(key)).rejects.toBeInstanceOf(S3Error);
    await expect(provider.exists(key)).rejects.toBeInstanceOf(S3Error);
    await expect(provider.list(tenantPrefix(randomUUID()))).rejects.toBeInstanceOf(S3Error);
  });

  it('rejects a bad signature (wrong secret)', async () => {
    const fake = fakeS3(config);
    const provider = new S3StorageProvider({ ...config, secretAccessKey: 'wrong' }, fake.fetchImpl);
    await expect(provider.put(newKey(), Readable.from(Buffer.from('x')))).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('S3 configuration', () => {
  const env = {
    APP_ENV: 'testing',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    DATABASE_MIGRATION_URL: 'postgres://u:p@localhost:5432/x',
    SESSION_SECRET: 'x'.repeat(40),
    MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    STORAGE_PROVIDER: 's3',
  };
  const full = {
    ...env,
    S3_ENDPOINT: 'https://s3.example.test',
    S3_REGION: 'eu-west-1',
    S3_BUCKET: 'intuit-files',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('needs every setting, and https in production', () => {
    expect(() => loadConfig(env)).toThrow(/S3_ENDPOINT/);
    for (const name of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      const { [name as keyof typeof full]: _omitted, ...rest } = full;
      expect(() => loadConfig(rest)).toThrow(new RegExp(name));
    }
    expect(() => loadConfig({ ...full, S3_ENDPOINT: 'not a url' })).toThrow(ConfigError);
  });

  it('exposes the settings, and stays local by default', () => {
    expect(loadConfig(full).storage).toMatchObject({
      provider: 's3',
      s3: { bucket: 'intuit-files', region: 'eu-west-1', forcePathStyle: false },
    });
    expect(loadConfig({ ...env, STORAGE_PROVIDER: 'local' }).storage.s3).toBeNull();
    expect(loadConfig({ ...full, S3_FORCE_PATH_STYLE: 'true' }).storage.s3?.forcePathStyle).toBe(
      true,
    );
  });
});
