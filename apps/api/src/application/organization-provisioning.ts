import { randomUUID } from 'node:crypto';
import type { Transaction } from '../database/client.js';
import {
  assignOwnerRole,
  provisionOrganizationRoles,
  RoleTemplateKeys,
} from '../modules/access-control/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  createMembership,
  createOrganization,
  type Membership,
  type Organization,
} from '../modules/organizations/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import { setDbContext } from './unit-of-work.js';

/**
 * Creates an organization with the given user as its single Owner:
 * organization -> membership -> roles provisioned from templates -> Owner role -> audit -> outbox.
 * Leaves the transaction's RLS context set to the new organization.
 */
export async function createOrganizationWithOwner(
  tx: Transaction,
  input: { name: string; ownerUserId: string; now: Date; origin: EventOrigin },
): Promise<{ organization: Organization; membership: Membership }> {
  const organizationId = randomUUID();
  await setDbContext(tx, { userId: input.ownerUserId, organizationId });

  const organization = await createOrganization(tx, {
    id: organizationId,
    name: input.name,
    createdByUserId: input.ownerUserId,
  });
  const membership = await createMembership(tx, { organizationId, userId: input.ownerUserId });
  if (!membership) throw new Error('Owner membership could not be created');

  const roles = await provisionOrganizationRoles(tx, organizationId);
  const ownerRole = roles.get(RoleTemplateKeys.Owner);
  if (!ownerRole) throw new Error('Owner role template is missing');
  await assignOwnerRole(tx, {
    organizationId,
    membershipId: membership.id,
    ownerRole,
    assignedByUserId: input.ownerUserId,
  });

  await recordAuditEvent(tx, {
    occurredAt: input.now,
    organizationId,
    actorUserId: input.ownerUserId,
    action: 'organization.created',
    resourceType: 'organization',
    resourceId: organizationId,
    metadata: { name: organization.name },
    origin: input.origin,
  });
  await recordAuditEvent(tx, {
    occurredAt: input.now,
    organizationId,
    actorUserId: input.ownerUserId,
    action: 'membership.created',
    resourceType: 'membership',
    resourceId: membership.id,
    metadata: { userId: input.ownerUserId, roles: [ownerRole.name], via: 'organization_creation' },
    origin: input.origin,
  });
  await enqueueOutboxEvent(
    tx,
    {
      eventType: 'organizations.organization_created',
      aggregateType: 'organization',
      aggregateId: organizationId,
      organizationId,
      payload: { organizationId, ownerUserId: input.ownerUserId },
    },
    input.now,
  );
  return { organization, membership };
}
