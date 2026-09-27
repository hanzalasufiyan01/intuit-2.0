import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  approvalDecisions,
  approvalPolicies,
  approvalPolicySteps,
  approvalRequests,
  approvalStepEligibleMembers,
  approvalStepEligibleRoles,
  type ApprovalRequestStatus,
  type PolicySnapshot,
  type PolicySnapshotStep,
} from './schema.js';

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type ApprovalDecision = typeof approvalDecisions.$inferSelect;

export interface ApprovalPolicy {
  id: string;
  actionKey: string;
  updatedAt: Date;
  steps: PolicySnapshotStep[];
}

export interface ApprovalStepInput {
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function listApprovalPolicies(
  tx: Transaction,
  organizationId: string,
): Promise<ApprovalPolicy[]> {
  const policies = await tx
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.organizationId, organizationId))
    .orderBy(asc(approvalPolicies.actionKey));
  if (policies.length === 0) return [];
  const steps = await tx
    .select()
    .from(approvalPolicySteps)
    .where(
      and(
        eq(approvalPolicySteps.organizationId, organizationId),
        inArray(
          approvalPolicySteps.policyId,
          policies.map((p) => p.id),
        ),
      ),
    )
    .orderBy(asc(approvalPolicySteps.stepOrder));
  const stepIds = steps.map((s) => s.id);
  const roles = stepIds.length
    ? await tx
        .select()
        .from(approvalStepEligibleRoles)
        .where(
          and(
            eq(approvalStepEligibleRoles.organizationId, organizationId),
            inArray(approvalStepEligibleRoles.stepId, stepIds),
          ),
        )
    : [];
  const members = stepIds.length
    ? await tx
        .select()
        .from(approvalStepEligibleMembers)
        .where(
          and(
            eq(approvalStepEligibleMembers.organizationId, organizationId),
            inArray(approvalStepEligibleMembers.stepId, stepIds),
          ),
        )
    : [];
  return policies.map((policy) => ({
    id: policy.id,
    actionKey: policy.actionKey,
    updatedAt: policy.updatedAt,
    steps: steps
      .filter((s) => s.policyId === policy.id)
      .map((s) => ({
        order: s.stepOrder,
        name: s.name,
        requiredApprovals: s.requiredApprovals,
        roleIds: roles
          .filter((r) => r.stepId === s.id)
          .map((r) => r.roleId)
          .sort(),
        membershipIds: members
          .filter((m) => m.stepId === s.id)
          .map((m) => m.membershipId)
          .sort(),
      })),
  }));
}

export async function getApprovalPolicy(
  tx: Transaction,
  organizationId: string,
  actionKey: string,
): Promise<ApprovalPolicy | undefined> {
  const all = await listApprovalPolicies(tx, organizationId);
  return all.find((p) => p.actionKey === actionKey);
}

/** Creates or replaces the policy for an action (steps are replaced as a whole). */
export async function replaceApprovalPolicy(
  tx: Transaction,
  input: { organizationId: string; actionKey: string; steps: ApprovalStepInput[] },
): Promise<void> {
  const [existing] = await tx
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.organizationId, input.organizationId),
        eq(approvalPolicies.actionKey, input.actionKey),
      ),
    );
  let policyId = existing?.id;
  if (policyId) {
    await tx
      .delete(approvalPolicySteps)
      .where(
        and(
          eq(approvalPolicySteps.organizationId, input.organizationId),
          eq(approvalPolicySteps.policyId, policyId),
        ),
      );
    await tx
      .update(approvalPolicies)
      .set({ updatedAt: new Date() })
      .where(eq(approvalPolicies.id, policyId));
  } else {
    const [created] = await tx
      .insert(approvalPolicies)
      .values({ organizationId: input.organizationId, actionKey: input.actionKey })
      .returning({ id: approvalPolicies.id });
    policyId = created!.id;
  }
  for (const [index, step] of input.steps.entries()) {
    const [row] = await tx
      .insert(approvalPolicySteps)
      .values({
        organizationId: input.organizationId,
        policyId,
        stepOrder: index + 1,
        name: step.name.trim(),
        requiredApprovals: step.requiredApprovals,
      })
      .returning({ id: approvalPolicySteps.id });
    const stepId = row!.id;
    const roleIds = [...new Set(step.roleIds)];
    const membershipIds = [...new Set(step.membershipIds)];
    if (roleIds.length) {
      await tx
        .insert(approvalStepEligibleRoles)
        .values(
          roleIds.map((roleId) => ({ stepId, organizationId: input.organizationId, roleId })),
        );
    }
    if (membershipIds.length) {
      await tx.insert(approvalStepEligibleMembers).values(
        membershipIds.map((membershipId) => ({
          stepId,
          organizationId: input.organizationId,
          membershipId,
        })),
      );
    }
  }
}

export async function deleteApprovalPolicy(
  tx: Transaction,
  organizationId: string,
  actionKey: string,
): Promise<boolean> {
  const rows = await tx
    .delete(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.organizationId, organizationId),
        eq(approvalPolicies.actionKey, actionKey),
      ),
    )
    .returning({ id: approvalPolicies.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Requests and decisions
// ---------------------------------------------------------------------------

export async function createApprovalRequest(
  tx: Transaction,
  input: {
    organizationId: string;
    actionKey: string;
    subjectType: string;
    subjectId: string;
    snapshot: PolicySnapshot;
    requestedByUserId: string;
    excludedUserIds: string[];
    reason: string | null;
    now: Date;
  },
): Promise<ApprovalRequest | undefined> {
  const [row] = await tx
    .insert(approvalRequests)
    .values({
      organizationId: input.organizationId,
      actionKey: input.actionKey,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      policySnapshot: input.snapshot,
      requestedByUserId: input.requestedByUserId,
      excludedUserIds: [...new Set(input.excludedUserIds)],
      reason: input.reason,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function getApprovalRequest(
  tx: Transaction,
  organizationId: string,
  requestId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ApprovalRequest | undefined> {
  const query = tx
    .select()
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.id, requestId)),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listApprovalRequests(
  tx: Transaction,
  organizationId: string,
  filter: { status?: ApprovalRequestStatus; actionKeys?: string[]; limit: number },
): Promise<ApprovalRequest[]> {
  const conditions = [eq(approvalRequests.organizationId, organizationId)];
  if (filter.status) conditions.push(eq(approvalRequests.status, filter.status));
  if (filter.actionKeys) {
    if (filter.actionKeys.length === 0) return [];
    conditions.push(inArray(approvalRequests.actionKey, filter.actionKeys));
  }
  return tx
    .select()
    .from(approvalRequests)
    .where(and(...conditions))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(filter.limit);
}

export async function listApprovalDecisions(
  tx: Transaction,
  organizationId: string,
  requestIds: readonly string[],
): Promise<ApprovalDecision[]> {
  if (requestIds.length === 0) return [];
  return tx
    .select()
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.organizationId, organizationId),
        inArray(approvalDecisions.requestId, [...requestIds]),
      ),
    )
    .orderBy(asc(approvalDecisions.decidedAt));
}

export async function recordApprovalDecision(
  tx: Transaction,
  input: {
    organizationId: string;
    requestId: string;
    stepOrder: number;
    approverMembershipId: string;
    approverUserId: string;
    decision: 'approved' | 'rejected';
    comment: string | null;
    now: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(approvalDecisions)
    .values({
      organizationId: input.organizationId,
      requestId: input.requestId,
      stepOrder: input.stepOrder,
      approverMembershipId: input.approverMembershipId,
      approverUserId: input.approverUserId,
      decision: input.decision,
      comment: input.comment,
      decidedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: approvalDecisions.id });
  return rows.length > 0;
}

/** Resolves a pending request. Returns false if it was no longer pending. */
export async function resolveApprovalRequest(
  tx: Transaction,
  input: {
    organizationId: string;
    requestId: string;
    status: Exclude<ApprovalRequestStatus, 'pending'>;
    now: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .update(approvalRequests)
    .set({ status: input.status, resolvedAt: input.now })
    .where(
      and(
        eq(approvalRequests.organizationId, input.organizationId),
        eq(approvalRequests.id, input.requestId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .returning({ id: approvalRequests.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

export interface Approver {
  userId: string;
  membershipId: string;
  roleIds: readonly string[];
}

export function snapshotPolicy(policy: ApprovalPolicy | undefined): PolicySnapshot {
  return { steps: policy?.steps.map((s) => ({ ...s })) ?? [] };
}

export interface StepProgress {
  order: number;
  name: string;
  requiredApprovals: number;
  approvals: number;
  satisfied: boolean;
}

/** Approval progress: every step (AND) needs its required number of distinct approvals. */
export function evaluateApprovals(
  snapshot: PolicySnapshot,
  decisions: readonly Pick<ApprovalDecision, 'stepOrder' | 'decision'>[],
): { satisfied: boolean; steps: StepProgress[] } {
  const steps = snapshot.steps.map((step) => {
    const approvals = decisions.filter(
      (d) => d.decision === 'approved' && d.stepOrder === step.order,
    ).length;
    return {
      order: step.order,
      name: step.name,
      requiredApprovals: step.requiredApprovals,
      approvals,
      satisfied: approvals >= step.requiredApprovals,
    };
  });
  return { satisfied: steps.every((s) => s.satisfied), steps };
}

function eligibleForStep(step: PolicySnapshotStep, approver: Approver): boolean {
  return (
    step.membershipIds.includes(approver.membershipId) ||
    step.roleIds.some((roleId) => approver.roleIds.includes(roleId))
  );
}

export type EligibilityProblem = 'self_approval' | 'already_decided' | 'not_eligible';

/**
 * The step an approver's approval counts toward: the lowest-ordered unsatisfied step they
 * are eligible for. Self-approval (requester or other excluded users) is prohibited.
 */
export function selectApprovalStep(
  request: Pick<ApprovalRequest, 'policySnapshot' | 'excludedUserIds' | 'requestedByUserId'>,
  decisions: readonly Pick<ApprovalDecision, 'stepOrder' | 'decision' | 'approverMembershipId'>[],
  approver: Approver,
): { ok: true; stepOrder: number } | { ok: false; problem: EligibilityProblem } {
  if (
    approver.userId === request.requestedByUserId ||
    request.excludedUserIds.includes(approver.userId)
  ) {
    return { ok: false, problem: 'self_approval' };
  }
  if (decisions.some((d) => d.approverMembershipId === approver.membershipId)) {
    return { ok: false, problem: 'already_decided' };
  }
  const progress = evaluateApprovals(request.policySnapshot, decisions);
  for (const step of request.policySnapshot.steps) {
    const satisfied = progress.steps.find((s) => s.order === step.order)?.satisfied ?? false;
    if (!satisfied && eligibleForStep(step, approver)) return { ok: true, stepOrder: step.order };
  }
  return { ok: false, problem: 'not_eligible' };
}
