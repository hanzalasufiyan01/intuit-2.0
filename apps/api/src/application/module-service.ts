import { ValidationError } from '../domain/errors.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  listModuleStates,
  optionalModules,
  OrganizationPermissions,
  setModuleEnabled,
  type OptionalModule,
} from '../modules/organizations/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Optional modules (FP-24): payroll, projects and the clinic extension are off until an
 * administrator switches them on. Reading the switches needs `organization.read` (the interface
 * hides disabled modules); changing one needs `organization.update` and a recent password.
 */
export class ModuleService {
  constructor(private readonly deps: AppDependencies) {}

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationRead, readOnlySnapshot: true },
      async (tx, ctx) => ({ modules: await listModuleStates(tx, ctx.organizationId) }),
    );
  }

  set(principal: Principal, moduleKey: string, enabled: boolean, origin: EventOrigin) {
    if (!(optionalModules as readonly string[]).includes(moduleKey)) {
      throw new ValidationError([{ path: 'module', message: 'Unknown module.' }]);
    }
    const key = moduleKey as OptionalModule;
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationUpdate, sensitive: true },
      async (tx, ctx) => {
        const before = (await listModuleStates(tx, ctx.organizationId))[key];
        const now = this.deps.clock.now();
        await setModuleEnabled(tx, {
          organizationId: ctx.organizationId,
          moduleKey: key,
          enabled,
          userId: ctx.userId,
          at: now,
        });
        if (before !== enabled) {
          await recordAuditEvent(tx, {
            occurredAt: now,
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: enabled ? 'organization.module_enabled' : 'organization.module_disabled',
            resourceType: 'organization_module',
            resourceId: key,
            metadata: { module: key },
            origin,
          });
        }
        return { modules: await listModuleStates(tx, ctx.organizationId) };
      },
    );
  }
}
