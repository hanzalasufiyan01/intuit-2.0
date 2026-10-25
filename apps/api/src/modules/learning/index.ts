/**
 * Learning (migration 0096): each member's progress through the in-app tutorials. The module owns
 * `tutorial_progress`. A row belongs to one member of one organization; row-level security pins
 * both, and every query below repeats the organization and the user, so a mistake in one layer is
 * caught by the other. Nothing here is financial: no accounting table is read or written.
 */
import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

export const tutorialStatuses = ['in_progress', 'completed', 'skipped'] as const;
export type TutorialStatus = (typeof tutorialStatuses)[number];

export type TutorialProgress = {
  tutorialId: string;
  status: TutorialStatus;
  currentStep: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
};

type Row = {
  tutorialId: string;
  status: TutorialStatus;
  currentStep: number;
  startedAt: Date | string;
  completedAt: Date | string | null;
  updatedAt: Date | string;
};

const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const view = (row: Row): TutorialProgress => ({
  tutorialId: row.tutorialId,
  status: row.status,
  currentStep: row.currentStep,
  startedAt: iso(row.startedAt),
  completedAt: row.completedAt === null ? null : iso(row.completedAt),
  updatedAt: iso(row.updatedAt),
});

const COLUMNS = sql`tutorial_id AS "tutorialId", status, current_step AS "currentStep",
  started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"`;

export async function listTutorialProgress(
  tx: Transaction,
  organizationId: string,
  userId: string,
): Promise<TutorialProgress[]> {
  const result = await tx.execute<Row>(sql`
    SELECT ${COLUMNS} FROM tutorial_progress
     WHERE organization_id = ${organizationId} AND user_id = ${userId}
     ORDER BY tutorial_id`);
  return result.rows.map(view);
}

/**
 * Records where the member is in a tutorial. Starting again after a completed or skipped run
 * (status in_progress) restarts the clock; otherwise the start time is kept. `completed_at` is set
 * exactly when the status is completed (a database check also enforces this).
 */
export async function upsertTutorialProgress(
  tx: Transaction,
  input: {
    organizationId: string;
    userId: string;
    tutorialId: string;
    status: TutorialStatus;
    currentStep: number;
    now: Date;
  },
): Promise<TutorialProgress> {
  const result = await tx.execute<Row>(sql`
    INSERT INTO tutorial_progress
      (organization_id, user_id, tutorial_id, status, current_step, started_at, completed_at, updated_at)
    VALUES (${input.organizationId}, ${input.userId}, ${input.tutorialId}, ${input.status},
            ${input.currentStep}, ${input.now},
            ${input.status === 'completed' ? input.now : null}, ${input.now})
    ON CONFLICT (organization_id, user_id, tutorial_id) DO UPDATE SET
      status       = EXCLUDED.status,
      current_step = EXCLUDED.current_step,
      started_at   = CASE
                       WHEN EXCLUDED.status = 'in_progress' AND tutorial_progress.status <> 'in_progress'
                       THEN EXCLUDED.started_at ELSE tutorial_progress.started_at END,
      completed_at = CASE WHEN EXCLUDED.status = 'completed'
                          THEN COALESCE(tutorial_progress.completed_at, EXCLUDED.completed_at)
                          ELSE NULL END,
      updated_at   = EXCLUDED.updated_at
    RETURNING ${COLUMNS}`);
  return view(result.rows[0]!);
}

/** Forgets the member's progress in one tutorial (so it can be repeated from the start). */
export async function deleteTutorialProgress(
  tx: Transaction,
  organizationId: string,
  userId: string,
  tutorialId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    DELETE FROM tutorial_progress
     WHERE organization_id = ${organizationId} AND user_id = ${userId}
       AND tutorial_id = ${tutorialId}`);
  return (result.rowCount ?? 0) > 0;
}
