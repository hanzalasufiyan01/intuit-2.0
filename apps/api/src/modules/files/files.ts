import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { fileLinks, files, type FileLinkType } from './schema.js';

/** Persistence for file metadata and links. Only this module writes these tables (S5-01). */

export type FileRecord = typeof files.$inferSelect;
export type FileLink = typeof fileLinks.$inferSelect;

export async function insertFile(
  tx: Transaction,
  file: typeof files.$inferInsert,
  link: { linkType: FileLinkType; linkId: string | null; userId: string },
): Promise<FileRecord> {
  const [row] = await tx.insert(files).values(file).returning();
  await tx.insert(fileLinks).values({
    fileId: file.id,
    organizationId: file.organizationId,
    linkType: link.linkType,
    linkId: link.linkId,
    createdByUserId: link.userId,
  });
  return row!;
}

export async function getFileWithLink(
  tx: Transaction,
  organizationId: string,
  fileId: string,
  options: { forUpdate?: boolean } = {},
): Promise<{ file: FileRecord; link: FileLink } | undefined> {
  const query = tx
    .select({ file: files, link: fileLinks })
    .from(files)
    .innerJoin(
      fileLinks,
      and(eq(fileLinks.fileId, files.id), eq(fileLinks.organizationId, files.organizationId)),
    )
    .where(and(eq(files.organizationId, organizationId), eq(files.id, fileId)))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update', { of: files }) : await query;
  return row;
}

export async function listLinkedFiles(
  tx: Transaction,
  organizationId: string,
  linkType: FileLinkType,
  linkId: string | null,
): Promise<{ file: FileRecord; link: FileLink }[]> {
  return tx
    .select({ file: files, link: fileLinks })
    .from(files)
    .innerJoin(
      fileLinks,
      and(eq(fileLinks.fileId, files.id), eq(fileLinks.organizationId, files.organizationId)),
    )
    .where(
      and(
        eq(files.organizationId, organizationId),
        eq(files.status, 'available'),
        eq(fileLinks.linkType, linkType),
        linkId === null ? isNull(fileLinks.linkId) : eq(fileLinks.linkId, linkId),
      ),
    )
    .orderBy(asc(files.uploadedAt), asc(files.id));
}

/** Soft delete (S5-13): the row stays; the object is removed by the purge after retention. */
export async function markFileDeleted(
  tx: Transaction,
  input: {
    organizationId: string;
    fileId: string;
    userId: string | null;
    now: Date;
    purgeAfter: Date;
  },
): Promise<FileRecord | undefined> {
  const [row] = await tx
    .update(files)
    .set({
      status: 'deleted',
      deletedAt: input.now,
      deletedByUserId: input.userId,
      purgeAfter: input.purgeAfter,
    })
    .where(
      and(
        eq(files.organizationId, input.organizationId),
        eq(files.id, input.fileId),
        inArray(files.status, ['available', 'quarantined']),
        eq(files.legalHold, false),
      ),
    )
    .returning();
  return row;
}

/** Deleted files past retention, not under legal hold, in the current tenant (RLS). */
export async function listDuePurges(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<FileRecord[]> {
  return tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.organizationId, organizationId),
        eq(files.status, 'deleted'),
        eq(files.legalHold, false),
        lte(files.purgeAfter, sql`now()`),
      ),
    )
    .orderBy(asc(files.purgeAfter))
    .limit(limit)
    .for('update', { skipLocked: true });
}

export async function markFilePurged(tx: Transaction, organizationId: string, fileId: string) {
  await tx
    .update(files)
    .set({ status: 'purged', purgedAt: sql`now()` })
    .where(
      and(
        eq(files.organizationId, organizationId),
        eq(files.id, fileId),
        eq(files.status, 'deleted'),
      ),
    );
}

/** Storage keys of the tenant whose objects must be kept (anything not purged). */
export async function liveStorageKeys(
  tx: Transaction,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ key: files.storageKey })
    .from(files)
    .where(
      and(
        eq(files.organizationId, organizationId),
        inArray(files.status, ['available', 'quarantined', 'deleted']),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/** Organizations with due purges, through the narrow SECURITY DEFINER function (S5-19). */
export async function organizationsWithDuePurges(tx: Transaction): Promise<string[]> {
  const result = await tx.execute<{ organization_id: string }>(
    sql`SELECT organization_id FROM app_organizations_with_due_file_purges()`,
  );
  return result.rows.map((r) => r.organization_id);
}
