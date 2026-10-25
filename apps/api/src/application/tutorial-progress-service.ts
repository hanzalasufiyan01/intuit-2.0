import {
  deleteTutorialProgress,
  listTutorialProgress,
  upsertTutorialProgress,
  type TutorialStatus,
} from '../modules/learning/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Tutorial progress (Help centre). Any active member of the organization may read and change their
 * OWN progress: there is nothing to authorize beyond membership, because the rows are keyed by the
 * member and never shown to anyone else (the database policy enforces the same rule). The tutorial
 * identifier is an opaque key owned by the web catalogue.
 */
export class TutorialProgressService {
  constructor(private readonly deps: AppDependencies) {}

  list(principal: Principal) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => ({
      items: await listTutorialProgress(tx, ctx.organizationId, ctx.userId),
    }));
  }

  set(principal: Principal, tutorialId: string, input: { status: TutorialStatus; step: number }) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => ({
      progress: await upsertTutorialProgress(tx, {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        tutorialId,
        status: input.status,
        currentStep: input.step,
        now: this.deps.clock.now(),
      }),
    }));
  }

  reset(principal: Principal, tutorialId: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => ({
      reset: await deleteTutorialProgress(tx, ctx.organizationId, ctx.userId, tutorialId),
    }));
  }
}
