import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isPublicAddress, validateWebhookUrl, WebhookDestinationError } from './ssrf.js';

/**
 * Outbound webhook transport (ADR 0011 section 11.3; section 13 `WebhookTransport`). The default
 * implementation resolves the host itself, refuses the request unless EVERY resolved address is
 * public, then connects to the validated address (pinned: no second resolution between check and
 * connect, which rules out DNS rebinding) while keeping the original host name for TLS SNI,
 * certificate verification (always on) and `Host`. Redirects are never followed (a 3xx is returned
 * as a response and counts as a failed attempt), the connect timeout is 5 s, the total timeout
 * 10 s, at most 64 KB of the response is read and only a 1 KB excerpt is kept.
 */

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookResponse {
  statusCode: number;
  /** At most 1 KB, control characters replaced. */
  excerpt: string;
  durationMs: number;
}

export type TransportErrorClass =
  'timeout' | 'tls' | 'connect' | 'network' | 'blocked_address' | 'dns' | 'invalid_url';

export class WebhookTransportError extends Error {
  constructor(
    readonly errorClass: TransportErrorClass,
    message: string,
    readonly durationMs: number,
  ) {
    super(message);
  }
}

export interface WebhookTransport {
  /** Throws `WebhookDestinationError` unless the URL is acceptable and resolves only to public addresses. */
  checkDestination(url: string): Promise<void>;
  /** Sends one request. Throws `WebhookDestinationError` or `WebhookTransportError` on failure. */
  send(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface HttpsTransportOptions {
  allowedPorts?: readonly number[];
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Name resolution; the default asks the system resolver for every address. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address policy; the default is `isPublicAddress`. Tests only: nothing in production sets it. */
  isAllowedAddress?: (address: string) => boolean;
  /** Extra TLS options (a test certificate authority). Certificate verification stays mandatory. */
  tls?: Pick<RequestOptions, 'ca'>;
  /** The HTTPS client. Tests only: lets them observe the pinned connection without a handshake. */
  request?: typeof httpsRequest;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const EXCERPT_CHARS = 1024;

export function excerptOf(body: Buffer): string {
  return (
    body
      .subarray(0, MAX_RESPONSE_BYTES)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .slice(0, EXCERPT_CHARS)
  );
}

function classify(error: NodeJS.ErrnoException): TransportErrorClass {
  const code = error.code ?? '';
  if (/CERT|TLS|SSL|EPROTO|UNABLE_TO_VERIFY|SELF_SIGNED|ALTNAME/i.test(code)) return 'tls';
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'connect';
  return 'network';
}

export class HttpsWebhookTransport implements WebhookTransport {
  private readonly options: Required<
    Pick<HttpsTransportOptions, 'connectTimeoutMs' | 'totalTimeoutMs'>
  > &
    HttpsTransportOptions;

  constructor(options: HttpsTransportOptions = {}) {
    this.options = { connectTimeoutMs: 5_000, totalTimeoutMs: 10_000, ...options };
  }

  private async resolveAll(hostname: string): Promise<ResolvedAddress[]> {
    let addresses: ResolvedAddress[];
    try {
      addresses = this.options.resolve
        ? await this.options.resolve(hostname)
        : (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
            address: a.address,
            family: a.family === 6 ? 6 : 4,
          }));
    } catch {
      throw new WebhookDestinationError('dns', 'The host name could not be resolved.');
    }
    if (addresses.length === 0) {
      throw new WebhookDestinationError('dns', 'The host name did not resolve to an address.');
    }
    const allowed = this.options.isAllowedAddress ?? isPublicAddress;
    // Every address must be public: one private answer refuses the destination.
    if (addresses.some((a) => !allowed(a.address))) {
      throw new WebhookDestinationError(
        'blocked_address',
        'The host resolves to an address that is not public.',
      );
    }
    return addresses;
  }

  private async validate(url: string) {
    const validated = validateWebhookUrl(url, { allowedPorts: this.options.allowedPorts ?? [443] });
    return { validated, addresses: await this.resolveAll(validated.hostname) };
  }

  async checkDestination(url: string): Promise<void> {
    await this.validate(url);
  }

  async send(input: WebhookRequest): Promise<WebhookResponse> {
    const started = Date.now();
    const { validated, addresses } = await this.validate(input.url);
    const target = addresses[0]!;
    const { url, hostname, port } = validated;
    const body = Buffer.from(input.body, 'utf8');
    const { connectTimeoutMs, totalTimeoutMs } = this.options;

    return new Promise<WebhookResponse>((resolve, reject) => {
      let settled = false;
      const done = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        action();
      };
      const fail = (errorClass: TransportErrorClass, message: string) =>
        done(() => reject(new WebhookTransportError(errorClass, message, Date.now() - started)));

      const req = (this.options.request ?? httpsRequest)({
        method: 'POST',
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...input.headers,
          host: port === 443 ? hostname : `${hostname}:${port}`,
          'content-length': String(body.length),
        },
        // The connection goes to the address that was just validated (pinned), never to a second
        // resolution of the name; SNI and certificate verification use the original host name.
        lookup: (_host, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [
              { address: target.address, family: target.family },
            ]);
          } else {
            callback(null, target.address, target.family);
          }
        },
        servername: hostname,
        agent: false,
        ...this.options.tls,
      });
      const total = setTimeout(() => {
        req.destroy();
        fail('timeout', 'The request exceeded the total timeout.');
      }, totalTimeoutMs);
      req.on('socket', (socket) => {
        socket.setTimeout(connectTimeoutMs, () => {
          req.destroy();
          fail('timeout', 'The connection timed out.');
        });
        socket.once('secureConnect', () => socket.setTimeout(0));
      });
      req.on('error', (error: NodeJS.ErrnoException) =>
        fail(classify(error), `${error.code ?? 'error'}`),
      );
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const finish = () =>
          done(() =>
            resolve({
              statusCode: res.statusCode ?? 0,
              excerpt: excerptOf(Buffer.concat(chunks)),
              durationMs: Date.now() - started,
            }),
          );
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          else {
            // Enough read: stop downloading; the status is what matters.
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', () => finish());
      });
      req.write(body);
      req.end();
    });
  }
}
