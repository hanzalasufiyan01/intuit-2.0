import { ConflictError, NotFoundError } from '../../domain/errors.js';
import {
  finishedImportStatuses,
  getBatch,
  getExport,
  updateBatch,
} from '../../modules/data-exchange/index.js';
import type { FileLinkType } from '../../modules/files/index.js';
import type { AttachmentTarget } from '../attachment-targets.js';
import { requirePermission } from '../authorization.js';
import { assertExportAccess } from './export-service.js';
import { importDomains } from './imports/index.js';

/**
 * S5 attachment targets added by S6 (S5-04, S6-31). Both authorize per record against the
 * caller's current permissions: an import file needs the import's domain permission (its
 * creator may view it), an export file the export's permissions (correction 3).
 */
export const dataExchangeTargets: ReadonlyMap<FileLinkType, AttachmentTarget> = new Map<
  FileLinkType,
  AttachmentTarget
>([
  [
    'import_batch',
    {
      linkType: 'import_batch',
      // L-3: CSV only until XLSX is approved under Decision 62.
      allowedTypes: ['csv'],
      viewPermission: null,
      changePermission: null,
      async authorize(tx, ctx, linkId, access) {
        const batch = linkId
          ? await getBatch(tx, ctx.organizationId, linkId, { forUpdate: access === 'upload' })
          : undefined;
        if (!batch) throw new NotFoundError('Import not found.');
        if (access === 'view' && batch.createdByUserId === ctx.userId) return;
        requirePermission(ctx, importDomains.get(batch.domain)!.permission);
        // One file per import: a second upload is refused (the row lock serializes uploads).
        if (access === 'upload' && (batch.status !== 'awaiting_file' || batch.fileId !== null)) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'This import already has a file. Start a new import to use another file.',
          );
        }
      },
      async resolve(tx, organizationId, linkId) {
        const batch = linkId ? await getBatch(tx, organizationId, linkId) : undefined;
        if (!batch) return null;
        return finishedImportStatuses.includes(batch.status)
          ? { removable: true }
          : {
              removable: false,
              removableReason: 'The file of an active import cannot be removed.',
            };
      },
      async onUploaded(tx, ctx, linkId, file) {
        const batch = (await getBatch(tx, ctx.organizationId, linkId!))!;
        await updateBatch(tx, ctx.organizationId, batch.id, {
          fileId: file.id,
          fileSha256: file.sha256,
          status: 'ready',
          summary: { ...batch.summary, fileName: file.originalName },
        });
      },
    },
  ],
  [
    'export',
    {
      linkType: 'export',
      allowedTypes: [],
      uploads: false,
      viewPermission: null,
      changePermission: null,
      async authorize(tx, ctx, linkId) {
        const found = linkId ? await getExport(tx, ctx.organizationId, linkId) : undefined;
        if (!found || found.status === 'expired') throw new NotFoundError('Export not found.');
        await assertExportAccess(tx, ctx, found);
      },
      async resolve(tx, organizationId, linkId) {
        const found = linkId ? await getExport(tx, organizationId, linkId) : undefined;
        return found ? { removable: true } : null;
      },
    },
  ],
]);
