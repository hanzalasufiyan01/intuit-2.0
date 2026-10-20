import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { EmailMessage, EmailProvider } from './email-provider.js';

/**
 * Production e-mail provider over SMTP (master context section 24, ADR 0003 U18 / ADR 0012). It
 * implements the provider interface with Node's own `net` and `tls`: no dependency and no vendor
 * is baked in, so any SMTP service (a relay, a transactional provider's SMTP endpoint, an own
 * server) can be configured through the environment.
 *
 * Security rules:
 *  - `starttls` (default) refuses to continue unless the server offers STARTTLS and the upgrade
 *    succeeds, `tls` connects with implicit TLS, `none` is for loopback relays only;
 *  - certificates are verified (`rejectUnauthorized`) unless explicitly switched off by config;
 *  - credentials are never sent over an unencrypted connection to a non-loopback host;
 *  - header values containing CR or LF are refused (header injection);
 *  - message bodies, recipients and credentials are never logged by this class.
 *
 * A reply of 4xx is a transient failure (the job queue retries), 5xx a permanent one.
 */

export interface SmtpOptions {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user: string | null;
  password: string | null;
  timeoutMs: number;
  rejectUnauthorized: boolean;
  /** Test seam: extra CA certificates (never set in production). */
  ca?: string | Buffer | undefined;
  /** Test seam: the name to verify the certificate against when `host` is an IP address. */
  tlsServerName?: string | undefined;
  /** The name announced in EHLO. */
  clientName?: string | undefined;
}

export interface AttachmentRef {
  organizationId?: string | undefined;
  fileId: string;
  fileName: string;
  contentType: string;
}

/** Loads an attachment's bytes when the message is delivered (the message carries only a file id). */
export type AttachmentResolver = (ref: AttachmentRef) => Promise<Buffer>;

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly smtpCode: number | null = null,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

const CRLF = '\r\n';
const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '[::1]';

/** Credentials only travel over an encrypted connection, or to a loopback relay. */
export const mayAuthenticateOver = (host: string, encrypted: boolean) =>
  encrypted || isLoopback(host);

function assertHeaderValue(name: string, value: string) {
  if (/[\r\n]/.test(value) || value.includes('\0')) {
    throw new EmailDeliveryError(`The ${name} header contains a line break.`, false);
  }
}

const encodeWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const wrapBase64 = (buffer: Buffer) =>
  (buffer.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);

/** The address part of "Name <a@b>" or "a@b"; refuses anything that is not one plain address. */
function plainAddress(value: string): string {
  assertHeaderValue('address', value);
  const match =
    /^[^<>\s]+@[^<>\s]+$/.exec(value.trim()) ?? /<([^<>\s]+@[^<>\s]+)>$/.exec(value.trim());
  if (!match) throw new EmailDeliveryError('The e-mail address is not valid.', false);
  return match[1] ?? match[0];
}

/** Builds the RFC 5322 message. Exported for tests. */
export function buildMimeMessage(input: {
  from: string;
  message: EmailMessage;
  attachments: readonly { fileName: string; contentType: string; content: Buffer }[];
  messageId?: string;
  date?: Date;
}): string {
  const { from, message } = input;
  assertHeaderValue('From', from);
  assertHeaderValue('To', message.to);
  assertHeaderValue('Subject', message.subject);
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${input.messageId ?? randomUUID()}@${(from.split('@')[1] ?? 'localhost').replace(/[^\w.-]/g, '')}>`,
    'MIME-Version: 1.0',
    `X-Template: ${message.template.replace(/[^\w.-]/g, '')}`,
  ];
  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.text, 'utf8')),
  ].join(CRLF);
  if (input.attachments.length === 0) return [...headers, textPart].join(CRLF);
  const boundary = `=_${randomUUID().replaceAll('-', '')}`;
  const parts = [`--${boundary}`, textPart];
  for (const a of input.attachments) {
    assertHeaderValue('attachment name', a.fileName);
    assertHeaderValue('attachment type', a.contentType);
    const name = encodeWord(a.fileName).replaceAll('"', "'");
    parts.push(
      `--${boundary}`,
      [
        `Content-Type: ${a.contentType}; name="${name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${name}"`,
        '',
        wrapBase64(a.content),
      ].join(CRLF),
    );
  }
  parts.push(`--${boundary}--`, '');
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    parts.join(CRLF),
  ].join(CRLF);
}

/** Dot-stuffing and the terminator of the DATA command. */
export const dataBody = (raw: string) =>
  `${raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..')}${CRLF}.${CRLF}`;

interface Reply {
  code: number;
  lines: string[];
}

/** One SMTP conversation over a socket that may be upgraded to TLS. */
class Session {
  private buffer = '';
  private waiting: ((reply: Reply) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private pending: Reply[] = [];
  private partial: string[] = [];
  private error: Error | null = null;

  constructor(
    private socket: net.Socket | tls.TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach();
  }

  private attach() {
    this.socket.setTimeout(this.timeoutMs, () =>
      this.fail(new EmailDeliveryError('The SMTP server timed out.', true)),
    );
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    this.socket.on('error', (error) =>
      this.fail(new EmailDeliveryError(`SMTP connection error: ${error.message}`, true)),
    );
    this.socket.on('close', () =>
      this.fail(new EmailDeliveryError('The SMTP connection closed unexpectedly.', true)),
    );
  }

  private fail(error: Error) {
    if (this.error) return;
    this.error = error;
    this.failed?.(error);
    this.waiting = null;
  }

  private onData(text: string) {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.partial.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.partial };
        this.partial = [];
        if (this.waiting) {
          const resolve = this.waiting;
          this.waiting = null;
          resolve(reply);
        } else this.pending.push(reply);
      }
    }
  }

  reply(): Promise<Reply> {
    if (this.error) return Promise.reject(this.error);
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Reply>((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
    });
  }

  async command(line: string, expect: readonly number[]): Promise<Reply> {
    this.socket.write(`${line}${CRLF}`);
    return this.expect(await this.reply(), expect);
  }

  expect(reply: Reply, expect: readonly number[]): Reply {
    if (expect.includes(reply.code)) return reply;
    const transient = reply.code >= 400 && reply.code < 500;
    throw new EmailDeliveryError(
      `The SMTP server answered ${reply.code}: ${reply.lines.join(' ').slice(0, 200)}`,
      transient,
      reply.code,
    );
  }

  write(data: string) {
    this.socket.write(data);
  }

  /** Replaces the plain socket with a TLS one over it (STARTTLS). */
  async upgrade(options: tls.ConnectionOptions) {
    const plain = this.socket as net.Socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.setTimeout(0);
    this.buffer = '';
    this.pending = [];
    this.partial = [];
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect({ ...options, socket: plain }, () => resolve(secure));
      secure.once('error', (error) =>
        reject(new EmailDeliveryError(`TLS upgrade failed: ${error.message}`, true)),
      );
    });
    this.attach();
  }

  get encrypted() {
    return this.socket instanceof tls.TLSSocket;
  }

  close() {
    this.socket.removeAllListeners('close');
    this.socket.on('error', () => undefined);
    this.socket.destroy();
  }
}

export class SmtpEmailProvider implements EmailProvider {
  constructor(
    private readonly options: SmtpOptions,
    private readonly from: string,
    private readonly resolveAttachment: AttachmentResolver,
  ) {}

  private tlsOptions(): tls.ConnectionOptions {
    return {
      host: this.options.host,
      servername:
        this.options.tlsServerName ?? (net.isIP(this.options.host) ? undefined : this.options.host),
      rejectUnauthorized: this.options.rejectUnauthorized,
      ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
    };
  }

  private connect(): Promise<net.Socket | tls.TLSSocket> {
    const { host, port, security, timeoutMs } = this.options;
    return new Promise((resolve, reject) => {
      const socket =
        security === 'tls'
          ? tls.connect({ ...this.tlsOptions(), host, port }, () => resolve(socket))
          : net.connect({ host, port }, () => resolve(socket));
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new EmailDeliveryError('Connecting to the SMTP server timed out.', true));
      });
      socket.once('error', (error) =>
        reject(new EmailDeliveryError(`Cannot connect to the SMTP server: ${error.message}`, true)),
      );
    });
  }

  async send(message: EmailMessage): Promise<void> {
    const to = plainAddress(message.to);
    const from = plainAddress(this.from);
    const attachments = [];
    for (const ref of message.attachments ?? []) {
      attachments.push({
        fileName: ref.fileName,
        contentType: ref.contentType,
        content: await this.resolveAttachment(ref),
      });
    }
    const raw = buildMimeMessage({ from: this.from, message, attachments });
    const session = new Session(await this.connect(), this.options.timeoutMs);
    try {
      session.expect(await session.reply(), [220]);
      const hello = `EHLO ${this.options.clientName ?? 'intuit2.local'}`;
      let features = (await session.command(hello, [250])).lines.map((l) =>
        l.slice(4).toUpperCase(),
      );
      if (this.options.security === 'starttls') {
        if (!features.some((f) => f === 'STARTTLS')) {
          throw new EmailDeliveryError(
            'The SMTP server does not offer STARTTLS; refusing to send.',
            false,
          );
        }
        await session.command('STARTTLS', [220]);
        await session.upgrade(this.tlsOptions());
        features = (await session.command(hello, [250])).lines.map((l) => l.slice(4).toUpperCase());
      }
      if (this.options.user) {
        if (!mayAuthenticateOver(this.options.host, session.encrypted)) {
          throw new EmailDeliveryError(
            'Refusing to send SMTP credentials over an unencrypted connection.',
            false,
          );
        }
        await this.authenticate(session, features);
      }
      await session.command(`MAIL FROM:<${from}>`, [250]);
      await session.command(`RCPT TO:<${to}>`, [250, 251]);
      await session.command('DATA', [354]);
      session.write(dataBody(raw));
      session.expect(await session.reply(), [250]);
      await session.command('QUIT', [221]).catch(() => undefined);
    } finally {
      session.close();
    }
  }

  private async authenticate(session: Session, features: readonly string[]) {
    const auth =
      features
        .find((f) => f.startsWith('AUTH '))
        ?.slice(5)
        .split(/\s+/) ?? [];
    const user = this.options.user!;
    const password = this.options.password ?? '';
    if (auth.includes('PLAIN')) {
      const token = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
      await session.command(`AUTH PLAIN ${token}`, [235]);
    } else if (auth.includes('LOGIN')) {
      await session.command('AUTH LOGIN', [334]);
      await session.command(Buffer.from(user, 'utf8').toString('base64'), [334]);
      await session.command(Buffer.from(password, 'utf8').toString('base64'), [235]);
    } else {
      throw new EmailDeliveryError(
        'The SMTP server offers no supported authentication method.',
        false,
      );
    }
  }
}
