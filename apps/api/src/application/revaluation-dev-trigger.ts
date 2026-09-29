import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError } from '../domain/errors.js';
import type { AppEnv } from '../infrastructure/config/config.js';
import { AccountingPermissions } from '../modules/accounting/index.js';
import { findUserByEmail } from '../modules/identity/index.js';
import { listUserOrganizations } from '../modules/organizations/index.js';
import { requirePermission, resolveActingUserContext } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { RevaluationService } from './revaluation-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Development/testing trigger for revaluation runs (S9, N6). S9 has no HTTP route or UI, so the
 * browser end-to-end test starts runs with this trigger and checks the results in the existing
 * journal and report pages.
 *
 * - Refused outright outside APP_ENV development/testing, before anything is read.
 * - Acts as a real user: the membership must be active, permissions and the Decision 57a MFA
 *   requirement are evaluated exactly as for background work (`resolveActingUserContext`), and
 *   posting needs `accounting.journals.post`, cancelling `accounting.journals.reverse`.
 * - Uses the real RevaluationService, so it creates real accounting records.
 *
 * Re-authentication: the production RevaluationService methods (`post`, `cancel`) require a
 * recent password re-authentication of the caller's session and are unchanged. The trigger has no
 * browser session, so it uses a TEST-ONLY session re-authentication bypass: it calls the
 * in-transaction methods with `reauthentication: 'dev_trigger_bypass'`, which is recorded on the
 * audit event. The bypass exists only here, behind the environment guard, and never skips the
 * identity, permission or MFA checks above.
 */

export const DEV_TRIGGER_ENVIRONMENTS: ReadonlySet<AppEnv> = new Set(['development', 'testing']);

export type DevRevaluationAction =
  | { kind: 'post'; revaluationDate: string; runKey?: string | null }
  | { kind: 'cancel'; runId: string; version: number; reason: string };

export async function runDevRevaluation(
  deps: Pick<AppDependencies, 'db' | 'config'>,
  revaluations: RevaluationService,
  input: { email: string; organizationName?: string | null; action: DevRevaluationAction },
) {
  if (!DEV_TRIGGER_ENVIRONMENTS.has(deps.config.appEnv)) {
    throw new ForbiddenError(
      `The revaluation development trigger is disabled in APP_ENV=${deps.config.appEnv}.`,
    );
  }
  const user = await inTransaction(deps.db, {}, (tx) => findUserByEmail(tx, input.email));
  if (!user) throw new NotFoundError('No user has that email address.');
  const organizations = await inTransaction(deps.db, { userId: user.id }, (tx) =>
    listUserOrganizations(tx, user.id),
  );
  const matches = input.organizationName
    ? organizations.filter((o) => o.organizationName === input.organizationName)
    : organizations;
  if (matches.length !== 1) {
    throw new NotFoundError(
      matches.length === 0
        ? 'The user has no matching active organization.'
        : 'The user belongs to several organizations; name one.',
    );
  }
  const organizationId = matches[0]!.organizationId;
  const origin = {
    requestId: `dev-revaluation-${randomUUID()}`,
    ipAddress: null,
    userAgent: 'revaluation-dev-trigger',
  };
  const { action } = input;
  return inTransaction(deps.db, { userId: user.id, organizationId }, async (tx) => {
    const ctx = await resolveActingUserContext(tx, user.id, organizationId);
    if (action.kind === 'post') {
      requirePermission(ctx, AccountingPermissions.JournalsPost);
      return revaluations.postInTransaction(
        tx,
        ctx,
        { revaluationDate: action.revaluationDate, runKey: action.runKey ?? null },
        origin,
        { trigger: 'user', jobId: null, reauthentication: 'dev_trigger_bypass' },
      );
    }
    requirePermission(ctx, AccountingPermissions.JournalsReverse);
    return revaluations.cancelInTransaction(
      tx,
      ctx,
      action.runId,
      { version: action.version, reason: action.reason },
      origin,
      { reauthentication: 'dev_trigger_bypass' },
    );
  });
}
