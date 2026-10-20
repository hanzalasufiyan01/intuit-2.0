import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/infrastructure/config/config.js';
import {
  buildMimeMessage,
  dataBody,
  EmailDeliveryError,
  mayAuthenticateOver,
  SmtpEmailProvider,
  type SmtpOptions,
} from '../src/infrastructure/email/smtp-provider.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './webhook-tls-fixture.js';

/**
 * The production SMTP e-mail provider (master context section 24, ADR 0012) against a small fake
 * SMTP server: protocol, MIME, attachments, authentication, error classes, timeouts and the
 * header-injection and credential-safety rules. The TLS cases need a working local TLS stack and
 * skip themselves when something between the process and the server re-signs certificates (some
 * antivirus products do, as on the development machine).
 */

interface Received {
  commands: string[];
  data: string;
  auth: string[];
}
interface ServerOptions {
  starttls?: boolean;
  implicitTls?: boolean;
  authReply?: string;
  rcptReply?: string;
  dataReply?: string;
  silent?: boolean;
  advertiseAuth?: string;
}

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A scripted SMTP server: records the conversation and answers with configurable replies. */
async function fakeServer(options: ServerOptions = {}) {
  const received: Received = { commands: [], data: '', auth: [] };
  const handle = (initial: net.Socket) => {
    let socket: net.Socket = initial;
    let buffer = '';
    let inData = false;
    let dataBuf = '';
    let loginStep = 0;
    const send = (line: string) => socket.write(`${line}\r\n`);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        dataBuf += buffer;
        buffer = '';
        if (dataBuf.endsWith('\r\n.\r\n')) {
          inData = false;
          received.data = dataBuf.slice(0, -5);
          send(options.dataReply ?? '250 queued');
        }
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (loginStep > 0) {
          // The two base64 answers of AUTH LOGIN (user name, then password).
          received.auth.push(line);
          if (loginStep === 1) {
            loginStep = 2;
            send('334 UGFzc3dvcmQ6');
          } else {
            loginStep = 0;
            send(options.authReply ?? '235 ok');
          }
          continue;
        }
        received.commands.push(line.startsWith('AUTH') ? line.split(' ')[0]! : line);
        if (/^EHLO/i.test(line)) {
          const features = ['250-fake.local'];
          if (options.starttls && !(socket instanceof tls.TLSSocket)) features.push('250-STARTTLS');
          features.push(`250 AUTH ${options.advertiseAuth ?? 'PLAIN LOGIN'}`);
          for (const f of features) send(f);
        } else if (/^STARTTLS/i.test(line)) {
          send('220 go ahead');
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            key: TEST_TLS_KEY,
            cert: TEST_TLS_CERT,
          });
          secure.on('data', onData);
          secure.on('error', () => undefined);
          socket = secure;
          buffer = '';
          return;
        } else if (/^AUTH PLAIN/i.test(line)) {
          received.auth.push(line.slice(11));
          send(options.authReply ?? '235 ok');
        } else if (/^AUTH LOGIN/i.test(line)) {
          loginStep = 1;
          send('334 VXNlcm5hbWU6');
        } else if (/^MAIL FROM/i.test(line)) send('250 ok');
        else if (/^RCPT TO/i.test(line)) send(options.rcptReply ?? '250 ok');
        else if (/^DATA/i.test(line)) {
          send('354 end with .');
          inData = true;
          dataBuf = buffer;
          buffer = '';
          if (dataBuf.endsWith('\r\n.\r\n')) {
            inData = false;
            received.data = dataBuf.slice(0, -5);
            send(options.dataReply ?? '250 queued');
          }
          return;
        } else if (/^QUIT/i.test(line)) {
          send('221 bye');
          socket.end();
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
    if (!options.silent) send('220 fake.local ESMTP');
  };
  const server = options.implicitTls
    ? tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handle)
    : net.createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received };
}

const baseOptions = (port: number, extra: Partial<SmtpOptions> = {}): SmtpOptions => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  user: null,
  password: null,
  timeoutMs: 3000,
  rejectUnauthorized: true,
  ...extra,
});
const noAttachments = () => Promise.reject(new Error('no attachments expected'));
const message = (extra = {}) => ({
  to: 'person@example.com',
  subject: 'Invoice INV-00001',
  text: 'Please find the invoice attached.\n.a line that starts with a dot',
  template: 'sales.invoice',
  ...extra,
});

/** Decodes a base64 MIME body part. */
const decodePart = (part: string) => Buffer.from(part.replace(/\s+/g, ''), 'base64');

describe('MIME and framing', () => {
  it('builds a plain message with base64 UTF-8 text and an encoded non-ASCII subject', () => {
    const raw = buildMimeMessage({
      from: 'billing@example.com',
      message: message({ subject: 'Faktūra – ޑިވެހި' }),
      attachments: [],
      messageId: 'fixed-id',
      date: new Date('2026-10-17T08:00:00Z'),
    });
    expect(raw).toContain('From: billing@example.com');
    expect(raw).toContain('To: person@example.com');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(raw).toContain('Message-ID: <fixed-id@example.com>');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    const body = raw.split('\r\n\r\n')[1]!;
    expect(decodePart(body).toString('utf8')).toBe(message().text);
  });

  it('dot-stuffs the data and ends it with a lone dot', () => {
    expect(dataBody('a\n.b\n..c')).toBe('a\r\n..b\r\n...c\r\n.\r\n');
  });

  it('refuses header injection through the subject, the recipient or the sender', () => {
    const build = (m = {}, from = 'billing@example.com') =>
      buildMimeMessage({ from, message: message(m), attachments: [] });
    expect(() => build({ subject: 'Hi\r\nBcc: attacker@example.com' })).toThrow(EmailDeliveryError);
    expect(() => build({ to: 'a@example.com\r\nBcc: x@example.com' })).toThrow(EmailDeliveryError);
    expect(() => build({}, 'a@example.com\nX: y')).toThrow(EmailDeliveryError);
  });

  it('only sends credentials over an encrypted connection or to a loopback relay', () => {
    expect(mayAuthenticateOver('smtp.example.com', false)).toBe(false);
    expect(mayAuthenticateOver('smtp.example.com', true)).toBe(true);
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1']) {
      expect(mayAuthenticateOver(host, false), host).toBe(true);
    }
  });
});

describe('SmtpEmailProvider over a plain connection', () => {
  it('delivers one message: the SMTP dialogue, the envelope and the content', async () => {
    const { port, received } = await fakeServer();
    const provider = new SmtpEmailProvider(baseOptions(port), 'billing@example.com', noAttachments);
    await provider.send(message());
    expect(received.commands).toEqual([
      'EHLO intuit2.local',
      'MAIL FROM:<billing@example.com>',
      'RCPT TO:<person@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(received.data).toContain('Subject: Invoice INV-00001');
    const body = received.data.split('\r\n\r\n')[1]!;
    expect(decodePart(body).toString('utf8')).toBe(message().text);
  });

  it('attaches the bytes the resolver returns, under the given name and type', async () => {
    const { port, received } = await fakeServer();
    const pdf = Buffer.from('%PDF-1.4 fake bytes \u0000ÿ', 'latin1');
    const asked: unknown[] = [];
    const provider = new SmtpEmailProvider(
      baseOptions(port),
      'billing@example.com',
      async (ref) => {
        asked.push(ref);
        return pdf;
      },
    );
    await provider.send(
      message({
        attachments: [
          {
            organizationId: 'org-1',
            fileId: 'file-1',
            fileName: 'INV-00001.pdf',
            contentType: 'application/pdf',
          },
        ],
      }),
    );
    expect(asked).toEqual([
      {
        organizationId: 'org-1',
        fileId: 'file-1',
        fileName: 'INV-00001.pdf',
        contentType: 'application/pdf',
      },
    ]);
    const boundary = /boundary="([^"]+)"/.exec(received.data)![1]!;
    const parts = received.data.split(`--${boundary}`).filter((p) => p.includes('Content-Type'));
    const attachment = parts.find((p) => p.includes('application/pdf'))!;
    expect(attachment).toContain('Content-Disposition: attachment; filename="INV-00001.pdf"');
    expect(decodePart(attachment.split('\r\n\r\n')[1]!).equals(pdf)).toBe(true);
    expect(received.data).toContain(`--${boundary}--`);
  });

  it('authenticates with AUTH PLAIN or AUTH LOGIN on a loopback relay', async () => {
    const plain = await fakeServer();
    await new SmtpEmailProvider(
      baseOptions(plain.port, { user: 'mailer', password: 's3cret' }),
      'billing@example.com',
      noAttachments,
    ).send(message());
    expect(Buffer.from(plain.received.auth[0]!, 'base64').toString('utf8')).toBe(
      '\0mailer\0s3cret',
    );
    const login = await fakeServer({ advertiseAuth: 'LOGIN' });
    await new SmtpEmailProvider(
      baseOptions(login.port, { user: 'mailer', password: 's3cret' }),
      'billing@example.com',
      noAttachments,
    ).send(message());
    expect(login.received.commands).toContain('AUTH');
    expect(login.received.auth.map((v) => Buffer.from(v, 'base64').toString('utf8'))).toEqual([
      'mailer',
      's3cret',
    ]);
    expect(login.received.commands).toContain('DATA');
  });

  it('classifies failures: 4xx is transient, 5xx is permanent, with the SMTP code', async () => {
    const full = await fakeServer({ rcptReply: '452 mailbox full' });
    const transient = await new SmtpEmailProvider(
      baseOptions(full.port),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(transient).toBeInstanceOf(EmailDeliveryError);
    expect(transient).toMatchObject({ transient: true, smtpCode: 452 });
    const gone = await fakeServer({ rcptReply: '550 no such user' });
    const permanent = await new SmtpEmailProvider(
      baseOptions(gone.port),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(permanent).toMatchObject({ transient: false, smtpCode: 550 });
    const badLogin = await fakeServer({ authReply: '535 authentication failed' });
    const denied = await new SmtpEmailProvider(
      baseOptions(badLogin.port, { user: 'u', password: 'wrong' }),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(denied).toMatchObject({ transient: false, smtpCode: 535 });
    // The failure message never repeats the credentials or the message body.
    expect(String(denied.message)).not.toContain('wrong');
    expect(String(permanent.message)).not.toContain('Please find');
  });

  it('sends nothing for an invalid address or a header injection attempt', async () => {
    const { port, received } = await fakeServer();
    const provider = new SmtpEmailProvider(baseOptions(port), 'billing@example.com', noAttachments);
    await expect(provider.send(message({ to: 'not-an-address' }))).rejects.toMatchObject({
      transient: false,
    });
    await expect(
      provider.send(message({ subject: 'x\r\nBcc: y@example.com' })),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(received.commands).toEqual([]);
  });

  it('times out a server that never answers, and reports a closed port as transient', async () => {
    const quiet = await fakeServer({ silent: true });
    const slow = await new SmtpEmailProvider(
      baseOptions(quiet.port, { timeoutMs: 200 }),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(slow).toMatchObject({ transient: true });
    const closed = new net.Server();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await new SmtpEmailProvider(
      baseOptions(closedPort),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(refused).toMatchObject({ transient: true });
  });

  it('refuses STARTTLS-required delivery when the server does not offer it', async () => {
    const { port, received } = await fakeServer({ starttls: false });
    const error = await new SmtpEmailProvider(
      baseOptions(port, { security: 'starttls' }),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(error).toMatchObject({ transient: false });
    expect(String(error.message)).toMatch(/does not offer STARTTLS/);
    expect(received.commands).not.toContain('DATA');
  });
});

describe('SmtpEmailProvider over TLS', () => {
  async function tlsUsable() {
    const server = tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const ok = await new Promise<boolean>((resolve) => {
      const probe = tls.connect(
        { host: '127.0.0.1', port, servername: 'hooks.example.test', ca: TEST_TLS_CERT },
        () => {
          resolve(probe.authorized);
          probe.destroy();
        },
      );
      probe.on('error', () => resolve(false));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return ok;
  }
  const secure = (port: number, extra: Partial<SmtpOptions>) =>
    baseOptions(port, { ca: TEST_TLS_CERT, tlsServerName: 'hooks.example.test', ...extra });

  it('upgrades with STARTTLS before authenticating, and verifies the certificate', async (t) => {
    if (!(await tlsUsable())) return t.skip();
    const { port, received } = await fakeServer({ starttls: true });
    await new SmtpEmailProvider(
      secure(port, { security: 'starttls', user: 'mailer', password: 's3cret' }),
      'billing@example.com',
      noAttachments,
    ).send(message());
    const order = received.commands.map((c) => c.split(' ')[0]);
    expect(order.indexOf('STARTTLS')).toBeGreaterThan(-1);
    expect(order.indexOf('AUTH')).toBeGreaterThan(order.indexOf('STARTTLS'));
    expect(order).toContain('DATA');
    // An untrusted certificate stops the delivery before any credential is sent.
    const untrusted = await fakeServer({ starttls: true });
    const refused = await new SmtpEmailProvider(
      baseOptions(untrusted.port, { security: 'starttls', user: 'mailer', password: 's3cret' }),
      'billing@example.com',
      noAttachments,
    )
      .send(message())
      .catch((e) => e);
    expect(refused).toBeInstanceOf(EmailDeliveryError);
    expect(untrusted.received.auth).toEqual([]);
  });

  it('connects with implicit TLS', async (t) => {
    if (!(await tlsUsable())) return t.skip();
    const { port, received } = await fakeServer({ implicitTls: true });
    await new SmtpEmailProvider(
      secure(port, { security: 'tls', user: 'mailer', password: 's3cret' }),
      'billing@example.com',
      noAttachments,
    ).send(message());
    expect(received.commands).toContain('DATA');
  });
});

describe('SMTP configuration', () => {
  const env = {
    APP_ENV: 'testing',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    DATABASE_MIGRATION_URL: 'postgres://u:p@localhost:5432/x',
    SESSION_SECRET: 'x'.repeat(40),
    MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    EMAIL_PROVIDER: 'smtp',
  };

  it('needs a host, and credentials only as a pair', () => {
    expect(() => loadConfig(env)).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...env, SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u' })).toThrow(
      /SMTP_PASSWORD/,
    );
    expect(() => loadConfig({ ...env, SMTP_HOST: 'smtp.example.com', SMTP_PASSWORD: 'p' })).toThrow(
      /SMTP_USER/,
    );
  });

  it('applies safe defaults: STARTTLS on 587 with certificate verification', () => {
    const config = loadConfig({
      ...env,
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
    });
    expect(config.email).toMatchObject({
      provider: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        user: 'u',
        password: 'p',
        rejectUnauthorized: true,
      },
    });
    expect(loadConfig({ ...env, EMAIL_PROVIDER: 'mock' }).email.smtp).toBeNull();
    expect(() => loadConfig({ ...env, SMTP_HOST: 'h', SMTP_SECURITY: 'plaintext' })).toThrow(
      ConfigError,
    );
  });
});
