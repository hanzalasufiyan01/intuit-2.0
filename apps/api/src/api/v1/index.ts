import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AccountingService } from '../../application/accounting-service.js';
import type { ApprovalService } from '../../application/approval-service.js';
import type { AuthService } from '../../application/auth-service.js';
import type { DimensionService } from '../../application/dimension-service.js';
import type { ReportService } from '../../application/report-service.js';
import type { OrganizationProfileService } from '../../application/organization-profile-service.js';
import type { PartyService } from '../../application/party-service.js';
import type { FileService } from '../../application/file-service.js';
import type { JobService } from '../../application/job-service.js';
import type { ExportService } from '../../application/data-exchange/export-service.js';
import type { ImportService } from '../../application/data-exchange/import-service.js';
import type { AppDependencies } from '../../application/dependencies.js';
import type { InvitationService } from '../../application/invitation-service.js';
import type { JournalService } from '../../application/journal-service.js';
import type { MfaService } from '../../application/mfa-service.js';
import type { OpeningBalanceService } from '../../application/opening-balance-service.js';
import type { OrganizationSecurityService } from '../../application/organization-security-service.js';
import type { OrganizationService } from '../../application/organization-service.js';
import type { RoleService } from '../../application/role-service.js';
import { registerAccountingRoutes } from './accounting.routes.js';
import { registerApprovalRoutes } from './approvals.routes.js';
import { registerAuthRoutes } from './auth.routes.js';
import { registerInvitationRoutes } from './invitations.routes.js';
import { registerMfaRoutes } from './mfa.routes.js';
import { registerOrganizationRoutes } from './organizations.routes.js';
import { registerReportRoutes } from './reports.routes.js';
import { registerPartyRoutes } from './parties.routes.js';
import { registerFileRoutes } from './files.routes.js';
import { registerJobRoutes } from './jobs.routes.js';
import { registerDataExchangeRoutes } from './data-exchange.routes.js';

export interface ApiV1Services {
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
  mfa: MfaService;
  organizationSecurity: OrganizationSecurityService;
  openingBalances: OpeningBalanceService;
}

/** Version 1 of the REST API, mounted at /api/v1. */
export function apiV1(deps: AppDependencies, services: ApiV1Services) {
  return async (app: FastifyInstance) => {
    app.get('/health', async (_request, reply) => {
      try {
        await deps.db.execute(sql`SELECT 1`);
        return { data: { status: 'ok', database: 'ok' } };
      } catch {
        return reply.status(503).send({ data: { status: 'degraded', database: 'unavailable' } });
      }
    });
    registerAuthRoutes(app, { auth: services.auth, config: deps.config });
    registerMfaRoutes(app, { auth: services.auth, mfa: services.mfa, config: deps.config });
    registerOrganizationRoutes(app, services);
    registerInvitationRoutes(app, {
      invitations: services.invitations,
      auth: services.auth,
      config: deps.config,
    });
    registerApprovalRoutes(app, services);
    registerAccountingRoutes(app, services);
    registerReportRoutes(app, services);
    registerPartyRoutes(app, services);
    registerFileRoutes(app, services);
    registerJobRoutes(app, services);
    registerDataExchangeRoutes(app, services);
  };
}
