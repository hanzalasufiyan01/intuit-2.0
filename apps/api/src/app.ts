import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './api/http/errors.js';
import { registerSessionSecurity } from './api/http/session.js';
import { apiV1 } from './api/v1/index.js';
import { AccountingService } from './application/accounting-service.js';
import { DimensionService } from './application/dimension-service.js';
import { ReportService } from './application/report-service.js';
import { OrganizationProfileService } from './application/organization-profile-service.js';
import { PartyService } from './application/party-service.js';
import { FileService } from './application/file-service.js';
import {
  FILES_PURGE_JOB,
  JobService,
  JobWorker,
  type JobHandler,
} from './application/job-service.js';
import { LocalStorageProvider, NoopScanner } from './modules/files/index.js';
import { attachmentTargets } from './application/attachment-targets.js';
import {
  DATA_EXCHANGE_CLEANUP_JOB,
  DataExchangeCleanup,
} from './application/data-exchange/cleanup-service.js';
import { EXPORT_GENERATE_JOB, ExportService } from './application/data-exchange/export-service.js';
import { dataExchangeTargets } from './application/data-exchange/file-targets.js';
import {
  IMPORT_COMMIT_JOB,
  IMPORT_VALIDATE_JOB,
  ImportService,
} from './application/data-exchange/import-service.js';
import { ApprovalService } from './application/approval-service.js';
import { AuthService } from './application/auth-service.js';
import type { AppDependencies } from './application/dependencies.js';
import { InvitationService } from './application/invitation-service.js';
import { JournalService } from './application/journal-service.js';
import { MfaService } from './application/mfa-service.js';
import { MfaVerifier } from './application/mfa-verifier.js';
import { OpeningBalanceService } from './application/opening-balance-service.js';
import { OrganizationSecurityService } from './application/organization-security-service.js';
import { OrganizationService } from './application/organization-service.js';
import { RevaluationExposureRegistry } from './application/revaluation-exposures.js';
import { RevaluationService } from './application/revaluation-service.js';
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
    dimensions: DimensionService;
    reports: ReportService;
    organizationProfile: OrganizationProfileService;
    parties: PartyService;
    files: FileService;
    jobs: JobService;
    imports: ImportService;
    exports: ExportService;
    dataExchangeCleanup: DataExchangeCleanup;
    mfa: MfaService;
    organizationSecurity: OrganizationSecurityService;
    openingBalances: OpeningBalanceService;
    revaluations: RevaluationService;
  };
  /** Every registered route (method + URL), e.g. for the MFA default-deny test (S7-44). */
  routes: { method: string; url: string }[];
  /** The background worker with every registered handler (started by server.ts, S5-17). */
  worker: JobWorker;
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
  const verifier = new MfaVerifier(deps);
  const auth = new AuthService(deps, verifier);
  const approvals = new ApprovalService(deps);
  const accounting = new AccountingService(deps, approvals);
  const journals = new JournalService(deps, approvals);
  const dimensions = new DimensionService(deps);
  const reports = new ReportService(deps);
  const parties = new PartyService(deps);
  // S5-02 / S5-07: local provider and no-op scanner until production adapters are approved.
  // S6 adds the import_batch and export attachment targets (S5-04).
  const files = new FileService(
    deps,
    new LocalStorageProvider(config.storage.localRoot),
    new NoopScanner(),
    new Map([...attachmentTargets, ...dataExchangeTargets]),
  );
  const jobs = new JobService(deps);
  // S8: opening balances are an accounting process posting through the system-journal path.
  const openingBalances = new OpeningBalanceService(deps, approvals, journals, files);
  const domainServices = { accounting, journals, parties, dimensions, reports, openingBalances };
  // S9: revaluation support (engine only; no routes until Phase 4). Later modules register
  // their read-only document exposure providers here.
  const revaluations = new RevaluationService(deps, journals, new RevaluationExposureRegistry());
  const services = {
    auth,
    organizations: new OrganizationService(deps),
    invitations: new InvitationService(deps, auth),
    roles: new RoleService(deps),
    approvals,
    accounting,
    journals,
    dimensions,
    reports,
    organizationProfile: new OrganizationProfileService(deps),
    parties,
    files,
    jobs,
    imports: new ImportService(deps, domainServices, files, jobs),
    exports: new ExportService(deps, domainServices, files, jobs),
    dataExchangeCleanup: new DataExchangeCleanup(deps, files, jobs),
    mfa: new MfaService(deps, auth, verifier),
    organizationSecurity: new OrganizationSecurityService(deps, auth),
    openingBalances,
    revaluations,
  };
  const handlers = new Map<string, JobHandler>([
    [FILES_PURGE_JOB, (job) => services.files.purge(job)],
    // S6-10: import/export work runs under the requesting user's current permissions (L-6).
    [IMPORT_VALIDATE_JOB, (job) => services.imports.runValidation(job)],
    [IMPORT_COMMIT_JOB, (job) => services.imports.runCommit(job)],
    [EXPORT_GENERATE_JOB, (job) => services.exports.runGenerate(job)],
    [DATA_EXCHANGE_CLEANUP_JOB, (job) => services.dataExchangeCleanup.run(job)],
  ]);
  const worker = new JobWorker(deps, handlers);

  // JSON only. Dropping the default text/plain parser also means every write needs a
  // CORS-preflighted content type, which cross-site forms cannot send.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    // Routes may tighten this (file delivery sends `private, no-store`, S5-09).
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
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

  return { app, services, worker, routes };
}
