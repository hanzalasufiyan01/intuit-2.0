import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvitationService } from '../../application/invitation-service.js';
import type { OrganizationService } from '../../application/organization-service.js';
import type { RoleService } from '../../application/role-service.js';
import { membershipStatuses } from '../../modules/organizations/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

const createOrganizationBody = z.object({ name: fields.organizationName });
const updateOrganizationBody = z.object({ name: fields.organizationName });
const memberParams = z.object({ membershipId: fields.id });
const memberRolesBody = z.object({ roleIds: z.array(fields.id).max(50) });
const memberStatusBody = z.object({ status: z.enum(membershipStatuses) });
const invitationParams = z.object({ invitationId: fields.id });
const createInvitationBody = z.object({ email: fields.email, roleId: fields.id });
const roleParams = z.object({ roleId: fields.id });
const roleBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100),
  description: z.string().trim().max(500).default(''),
  permissionKeys: z.array(z.string().min(1).max(100)).max(200),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Organization-scoped API. `current` always means the session's active organization,
 * resolved and verified by the server; clients never supply a trusted organization id.
 */
export function registerOrganizationRoutes(
  app: FastifyInstance,
  deps: { organizations: OrganizationService; invitations: InvitationService; roles: RoleService },
): void {
  const { organizations, invitations, roles } = deps;

  app.get('/organizations', async (request) => ({
    data: await organizations.listMyOrganizations(requirePrincipal(request)),
  }));

  app.post('/organizations', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createOrganizationBody, request.body);
    const created = await organizations.createOrganization(
      principal,
      body.name,
      eventOrigin(request),
    );
    return reply.status(201).send({ data: created });
  });

  app.get('/organizations/current', async (request) => ({
    data: await organizations.getCurrent(requirePrincipal(request)),
  }));

  app.patch('/organizations/current', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(updateOrganizationBody, request.body);
    return { data: await organizations.updateCurrent(principal, body, eventOrigin(request)) };
  });

  // ---- Members ----

  app.get('/organizations/current/members', async (request) => ({
    data: await organizations.listMembers(requirePrincipal(request)),
  }));

  app.put('/organizations/current/members/:membershipId/roles', async (request) => {
    const principal = requirePrincipal(request);
    const { membershipId } = parseInput(memberParams, request.params);
    const body = parseInput(memberRolesBody, request.body);
    return {
      data: await organizations.setMemberRoles(
        principal,
        { membershipId, roleIds: body.roleIds },
        eventOrigin(request),
      ),
    };
  });

  app.patch('/organizations/current/members/:membershipId', async (request) => {
    const principal = requirePrincipal(request);
    const { membershipId } = parseInput(memberParams, request.params);
    const body = parseInput(memberStatusBody, request.body);
    return {
      data: await organizations.setMemberStatus(
        principal,
        { membershipId, status: body.status },
        eventOrigin(request),
      ),
    };
  });

  // ---- Invitations ----

  app.get('/organizations/current/invitations', async (request) => ({
    data: await invitations.listInvitations(requirePrincipal(request)),
  }));

  app.post('/organizations/current/invitations', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createInvitationBody, request.body);
    const created = await invitations.createInvitation(principal, body, eventOrigin(request));
    return reply.status(201).send({ data: created });
  });

  app.post('/organizations/current/invitations/:invitationId/revoke', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { invitationId } = parseInput(invitationParams, request.params);
    await invitations.revokeInvitation(principal, invitationId, eventOrigin(request));
    return reply.status(204).send();
  });

  // ---- Roles and permissions ----

  app.get('/organizations/current/roles', async (request) => ({
    data: await roles.listRoles(requirePrincipal(request)),
  }));

  app.post('/organizations/current/roles', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(roleBody, request.body);
    const created = await roles.createRole(principal, body, eventOrigin(request));
    return reply.status(201).send({ data: created });
  });

  app.put('/organizations/current/roles/:roleId', async (request) => {
    const principal = requirePrincipal(request);
    const { roleId } = parseInput(roleParams, request.params);
    const body = parseInput(roleBody, request.body);
    return { data: await roles.updateRole(principal, { roleId, ...body }, eventOrigin(request)) };
  });

  app.delete('/organizations/current/roles/:roleId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { roleId } = parseInput(roleParams, request.params);
    await roles.deleteRole(principal, roleId, eventOrigin(request));
    return reply.status(204).send();
  });

  app.get('/permissions', async (request) => ({
    data: await roles.listPermissionCatalog(requirePrincipal(request)),
  }));

  // ---- Audit ----

  app.get('/organizations/current/audit-events', async (request) => {
    const principal = requirePrincipal(request);
    const query = parseInput(auditQuery, request.query);
    const events = await organizations.listAuditEvents(principal, {
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
    const last = events.at(-1);
    return {
      data: events,
      page: { nextBefore: events.length === query.limit && last ? last.occurredAt : null },
    };
  });
}
