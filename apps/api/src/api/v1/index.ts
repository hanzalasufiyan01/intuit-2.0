import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AccountingService } from '../../application/accounting-service.js';
import type { ApprovalService } from '../../application/approval-service.js';
import type { AuthService } from '../../application/auth-service.js';
import type { AppDependencies } from '../../application/dependencies.js';
import type { InvitationService } from '../../application/invitation-service.js';
import type { JournalService } from '../../application/journal-service.js';
import type { OrganizationService } from '../../application/organization-service.js';
import type { RoleService } from '../../application/role-service.js';
import { registerAccountingRoutes } from './accounting.routes.js';
import { registerApprovalRoutes } from './approvals.routes.js';
import { registerAuthRoutes } from './auth.routes.js';
import { registerInvitationRoutes } from './invitations.routes.js';
import { registerOrganizationRoutes } from './organizations.routes.js';

export interface ApiV1Services {
  auth: AuthService;
  organizations: OrganizationService;
  invitations: InvitationService;
  roles: RoleService;
  approvals: ApprovalService;
  accounting: AccountingService;
  journals: JournalService;
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
    registerOrganizationRoutes(app, services);
    registerInvitationRoutes(app, {
      invitations: services.invitations,
      auth: services.auth,
      config: deps.config,
    });
    registerApprovalRoutes(app, services);
    registerAccountingRoutes(app, services);
  };
}
