import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getRolesByIds } from '../modules/access-control/index.js';
import {
  ApprovalPermissions,
  createApprovalRequest,
  deleteApprovalPolicy,
  evaluateApprovals,
  getApprovalPolicy,
  getApprovalRequest,
  listApprovalDecisions,
  listApprovalPolicies,
  listApprovalRequests,
  recordApprovalDecision,
  replaceApprovalPolicy,
  resolveApprovalRequest,
  selectApprovalStep,
  snapshotPolicy,
  type ApprovalRequest,
  type ApprovalStepInput,
} from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { findMembershipById } from '../modules/organizations/index.js';
import {
  hasPermission,
  requireRecentAuthentication,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * An approvable action registered by a module. The framework is shared: modules never
 * build their own approval mechanisms (Phase 2 brief §9).
 */
export interface ApprovalActionDefinition {
  actionKey: string;
  label: string;
  subjectType: string;
  /** Permission an approver must hold (in addition to being eligible for a step). */
  approverPermission: string;
  /** Whether each approval decision is a sensitive action (re-authentication). */
  decisionRequiresReauth: boolean;
  /** Runs in the deciding transaction when the request becomes fully approved. */
  onApproved?: (tx: Transaction, context: DecisionContext) => Promise<void>;
  /** Runs in the deciding transaction when the request is rejected. */
  onRejected?: (tx: Transaction, context: DecisionContext) => Promise<void>;
}

export interface DecisionContext {
  request: ApprovalRequest;
  authz: AuthorizationContext;
  comment: string | null;
  now: Date;
  origin: EventOrigin;
}

export class ApprovalRequiredError extends AppError {
  constructor(message = 'This action requires approval before it can be completed.') {
    super('APPROVAL_REQUIRED', 409, message);
  }
}

export interface DecisionOutcome {
  requestStatus: ApprovalRequest['status'];
  progress: ReturnType<typeof evaluateApprovals>;
}

export class ApprovalService {
  private readonly actions = new Map<string, ApprovalActionDefinition>();

  constructor(private readonly deps: AppDependencies) {}

  register(definition: ApprovalActionDefinition): void {
    this.actions.set(definition.actionKey, definition);
  }

  action(actionKey: string): ApprovalActionDefinition {
    const definition = this.actions.get(actionKey);
    if (!definition) throw new Error(`Unknown approval action ${actionKey}`);
    return definition;
  }

  listActions() {
    return [...this.actions.values()].map((a) => ({
      actionKey: a.actionKey,
      label: a.label,
      approverPermission: a.approverPermission,
    }));
  }

  // ---------------------------------------------------------------------------
  // Policy administration (approvals.manage + re-authentication)
  // ---------------------------------------------------------------------------

  listPolicies(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApprovalPermissions.ApprovalsManage },
      async (tx, ctx) => {
        const policies = await listApprovalPolicies(tx, ctx.organizationId);
        return {
          actions: this.listActions(),
          policies: policies.map((p) => ({
            actionKey: p.actionKey,
            updatedAt: p.updatedAt.toISOString(),
            steps: p.steps,
          })),
        };
      },
    );
  }

  setPolicy(
    principal: Principal,
    input: { actionKey: string; steps: ApprovalStepInput[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApprovalPermissions.ApprovalsManage, sensitive: true },
      async (tx, ctx) => {
        if (!this.actions.has(input.actionKey)) {
          throw new ValidationError([{ path: 'actionKey', message: 'Unknown approvable action.' }]);
        }
        await this.assertEligibleSetsBelongToOrganization(tx, ctx.organizationId, input.steps);
        const before = await getApprovalPolicy(tx, ctx.organizationId, input.actionKey);
        await replaceApprovalPolicy(tx, { organizationId: ctx.organizationId, ...input });
        const after = await getApprovalPolicy(tx, ctx.organizationId, input.actionKey);
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'approval_policy.updated',
          resourceType: 'approval_policy',
          resourceId: after?.id ?? null,
          metadata: {
            actionKey: input.actionKey,
            before: before?.steps ?? null,
            after: after?.steps ?? [],
          },
          origin,
        });
        return { actionKey: input.actionKey, steps: after?.steps ?? [] };
      },
    );
  }

  deletePolicy(principal: Principal, actionKey: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApprovalPermissions.ApprovalsManage, sensitive: true },
      async (tx, ctx) => {
        const before = await getApprovalPolicy(tx, ctx.organizationId, actionKey);
        if (!before || !(await deleteApprovalPolicy(tx, ctx.organizationId, actionKey))) {
          throw new NotFoundError('Approval policy not found.');
        }
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'approval_policy.deleted',
          resourceType: 'approval_policy',
          resourceId: before.id,
          metadata: { actionKey, before: before.steps },
          origin,
        });
      },
    );
  }

  private async assertEligibleSetsBelongToOrganization(
    tx: Transaction,
    organizationId: string,
    steps: ApprovalStepInput[],
  ) {
    const issues: { path: string; message: string }[] = [];
    if (steps.length === 0)
      issues.push({ path: 'steps', message: 'A policy needs at least one step.' });
    for (const [i, step] of steps.entries()) {
      if (step.roleIds.length === 0 && step.membershipIds.length === 0) {
        issues.push({ path: `steps.${i}`, message: 'Each step needs eligible roles or members.' });
      }
      const roles = await getRolesByIds(tx, organizationId, [...new Set(step.roleIds)]);
      if (roles.length !== new Set(step.roleIds).size) {
        issues.push({ path: `steps.${i}.roleIds`, message: 'One or more roles do not exist.' });
      }
      for (const membershipId of new Set(step.membershipIds)) {
        const membership = await findMembershipById(tx, organizationId, membershipId);
        if (!membership) {
          issues.push({
            path: `steps.${i}.membershipIds`,
            message: 'One or more members do not exist.',
          });
          break;
        }
      }
    }
    if (issues.length) throw new ValidationError(issues);
  }

  // ---------------------------------------------------------------------------
  // Requests (used by modules inside their own transactions)
  // ---------------------------------------------------------------------------

  /** Whether an organization currently requires approval for an action. */
  async isApprovalRequired(tx: Transaction, organizationId: string, actionKey: string) {
    const policy = await getApprovalPolicy(tx, organizationId, actionKey);
    return (policy?.steps.length ?? 0) > 0;
  }

  /**
   * Opens an approval request if the organization has a policy for the action.
   * Returns null when no approval is required.
   */
  async openRequest(
    tx: Transaction,
    input: {
      authz: AuthorizationContext;
      actionKey: string;
      subjectId: string;
      excludedUserIds: string[];
      reason: string | null;
      now: Date;
    },
  ): Promise<ApprovalRequest | null> {
    const definition = this.action(input.actionKey);
    const policy = await getApprovalPolicy(tx, input.authz.organizationId, input.actionKey);
    if (!policy || policy.steps.length === 0) return null;
    const request = await createApprovalRequest(tx, {
      organizationId: input.authz.organizationId,
      actionKey: input.actionKey,
      subjectType: definition.subjectType,
      subjectId: input.subjectId,
      snapshot: snapshotPolicy(policy),
      requestedByUserId: input.authz.userId,
      excludedUserIds: input.excludedUserIds,
      reason: input.reason,
      now: input.now,
    });
    if (!request) throw new ConflictError('CONFLICT', 'An approval request is already pending.');
    return request;
  }

  async withdrawRequest(tx: Transaction, organizationId: string, requestId: string, now: Date) {
    await resolveApprovalRequest(tx, { organizationId, requestId, status: 'withdrawn', now });
  }

  async progress(tx: Transaction, organizationId: string, request: ApprovalRequest) {
    const decisions = await listApprovalDecisions(tx, organizationId, [request.id]);
    return { decisions, progress: evaluateApprovals(request.policySnapshot, decisions) };
  }

  /**
   * Records an approval or rejection by an eligible approver inside the caller's
   * transaction. Enforces: approver permission, re-authentication where required,
   * step eligibility (roles or named members), and the self-approval prohibition.
   */
  async decideInTransaction(
    tx: Transaction,
    input: {
      principal: Principal;
      authz: AuthorizationContext;
      request: ApprovalRequest;
      decision: 'approved' | 'rejected';
      comment: string | null;
      now: Date;
      origin: EventOrigin;
    },
  ): Promise<DecisionOutcome> {
    const { authz, request, now } = input;
    const definition = this.action(request.actionKey);
    if (!hasPermission(authz, definition.approverPermission)) throw new PermissionDeniedError();
    if (definition.decisionRequiresReauth) {
      requireRecentAuthentication(input.principal, now, this.deps.config.session.reauthWindowMs);
    }
    if (request.status !== 'pending') {
      throw new ConflictError(
        'INVALID_STATE_TRANSITION',
        'This approval request is no longer pending.',
      );
    }
    const decisions = await listApprovalDecisions(tx, authz.organizationId, [request.id]);
    const choice = selectApprovalStep(request, decisions, {
      userId: authz.userId,
      membershipId: authz.membershipId,
      roleIds: authz.roleIds,
    });
    if (!choice.ok) {
      if (choice.problem === 'self_approval') {
        throw new AppError(
          'SELF_APPROVAL_PROHIBITED',
          403,
          'You cannot approve or reject your own request.',
        );
      }
      if (choice.problem === 'already_decided') {
        throw new ConflictError('ALREADY_DECIDED', 'You have already decided on this request.');
      }
      throw new AppError(
        'NOT_ELIGIBLE_APPROVER',
        403,
        'You are not an eligible approver for this request.',
      );
    }
    await recordApprovalDecision(tx, {
      organizationId: authz.organizationId,
      requestId: request.id,
      stepOrder: choice.stepOrder,
      approverMembershipId: authz.membershipId,
      approverUserId: authz.userId,
      decision: input.decision,
      comment: input.comment,
      now,
    });
    const after = await listApprovalDecisions(tx, authz.organizationId, [request.id]);
    const progress = evaluateApprovals(request.policySnapshot, after);
    const context: DecisionContext = {
      request,
      authz,
      comment: input.comment,
      now,
      origin: input.origin,
    };

    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: authz.organizationId,
      actorUserId: authz.userId,
      action: input.decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      resourceType: 'approval_request',
      resourceId: request.id,
      metadata: {
        actionKey: request.actionKey,
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        stepOrder: choice.stepOrder,
        comment: input.comment,
        progress: progress.steps,
      },
      origin: input.origin,
    });

    if (input.decision === 'rejected') {
      await resolveApprovalRequest(tx, {
        organizationId: authz.organizationId,
        requestId: request.id,
        status: 'rejected',
        now,
      });
      await definition.onRejected?.(tx, context);
      return { requestStatus: 'rejected', progress };
    }
    if (progress.satisfied) {
      await resolveApprovalRequest(tx, {
        organizationId: authz.organizationId,
        requestId: request.id,
        status: 'approved',
        now,
      });
      await definition.onApproved?.(tx, context);
      return { requestStatus: 'approved', progress };
    }
    return { requestStatus: 'pending', progress };
  }

  // ---------------------------------------------------------------------------
  // Generic request endpoints (e.g. period reopening)
  // ---------------------------------------------------------------------------

  /** Pending requests for actions the caller can approve, with eligibility per request. */
  listPendingRequests(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const actionKeys = [...this.actions.values()]
        .filter((a) => hasPermission(ctx, a.approverPermission))
        .map((a) => a.actionKey);
      const requests = await listApprovalRequests(tx, ctx.organizationId, {
        status: 'pending',
        actionKeys,
        limit: 200,
      });
      const decisions = await listApprovalDecisions(
        tx,
        ctx.organizationId,
        requests.map((r) => r.id),
      );
      return requests.map((request) => {
        const own = decisions.filter((d) => d.requestId === request.id);
        const eligibility = selectApprovalStep(request, own, {
          userId: ctx.userId,
          membershipId: ctx.membershipId,
          roleIds: ctx.roleIds,
        });
        return {
          id: request.id,
          actionKey: request.actionKey,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          reason: request.reason,
          requestedByUserId: request.requestedByUserId,
          createdAt: request.createdAt.toISOString(),
          progress: evaluateApprovals(request.policySnapshot, own).steps,
          canDecide: eligibility.ok,
          ineligibleReason: eligibility.ok ? null : eligibility.problem,
        };
      });
    });
  }

  decide(
    principal: Principal,
    input: { requestId: string; decision: 'approved' | 'rejected'; comment: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const request = await getApprovalRequest(tx, ctx.organizationId, input.requestId, {
        forUpdate: true,
      });
      if (!request || !this.actions.has(request.actionKey)) {
        throw new NotFoundError('Approval request not found.');
      }
      return this.decideInTransaction(tx, {
        principal,
        authz: ctx,
        request,
        decision: input.decision,
        comment: input.comment,
        now: this.deps.clock.now(),
        origin,
      });
    });
  }
}
