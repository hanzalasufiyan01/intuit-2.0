import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './api/http/errors.js';
import { registerSessionSecurity } from './api/http/session.js';
import { apiV1 } from './api/v1/index.js';
import { AccountingService } from './application/accounting-service.js';
import { ApprovalService } from './application/approval-service.js';
import { AuthService } from './application/auth-service.js';
import type { AppDependencies } from './application/dependencies.js';
import { InvitationService } from './application/invitation-service.js';
import { JournalService } from './application/journal-service.js';
import { OrganizationService } from './application/organization-service.js';
import { RoleService } from './application/role-service.js';
import { loggerOptions, type LogDestination } from './infrastructure/logging/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export interface BuildAppOptions {
  deps: Omit<AppDependencies, 'logger'>;
  /** Optional log destination (tests capture logs to assert no secrets are written). */
  logStream?: LogDestination;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: {
    auth: AuthService;
    organizations: OrganizationService;
    invitations: InvitationService;
    roles: RoleService;
    approvals: ApprovalService;
    accounting: AccountingService;
    journals: JournalService;
  };
}

/** Composition root for the HTTP application. */
export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options.deps;
  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    // Reuse a well-formed incoming request id (e.g. from a proxy), otherwise mint one.
    genReqId: (request) => {
      const incoming = request.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const deps: AppDependencies = { ...options.deps, logger: app.log };
  const auth = new AuthService(deps);
  const approvals = new ApprovalService(deps);
  const services = {
    auth,
    organizations: new OrganizationService(deps),
    invitations: new InvitationService(deps, auth),
    roles: new RoleService(deps),
    approvals,
    accounting: new AccountingService(deps, approvals),
    journals: new JournalService(deps, approvals),
  };

  // JSON only. Dropping the default text/plain parser also means every write needs a
  // CORS-preflighted content type, which cross-site forms cannot send.
  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    return payload;
  });

  await app.register(
    async (api) => {
      registerSessionSecurity(api, { config, auth });
      await api.register(apiV1(deps, services));
    },
    { prefix: '/api/v1' },
  );

  return { app, services };
}
