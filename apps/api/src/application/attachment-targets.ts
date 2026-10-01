import type { Transaction } from '../database/client.js';
import type { FileRecord } from '../modules/files/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { requirePermission, type AuthorizationContext } from './authorization.js';
import { AccountingPermissions, getJournal, getOpeningBatch } from '../modules/accounting/index.js';
import type { DetectedType, FileLinkType } from '../modules/files/index.js';
import { OrganizationPermissions } from '../modules/organizations/index.js';
import { getParty, PartyPermissions } from '../modules/parties/index.js';
import { getCreditNote, getInvoice, getReceipt, SalesPermissions } from '../modules/sales/index.js';

/**
 * Attachment-target registry (S5-01, S5-04, S5-05). Every file is linked to exactly one record,
 * and access to the file inherits that record's permissions (Decision 65). Each target resolves
 * its record through the owning module's public contract; the files module never reads those
 * tables. Later stages register more targets (S6: import batches, exports).
 */
export interface AttachmentTarget {
  linkType: FileLinkType;
  /** Detected types accepted for this target (narrowing Decision 61 where needed). */
  allowedTypes: readonly DetectedType[];
  /** Static permissions; null when `authorize` decides per record (S6 import batches, exports). */
  viewPermission: string | null;
  changePermission: string | null;
  /** False when users may not upload to this target (S6: exports are generated only). */
  uploads?: boolean;
  /**
   * Per-record authorization replacing the static permissions, evaluated against the caller's
   * current permissions on every access (S6).
   */
  authorize?(
    tx: Transaction,
    ctx: AuthorizationContext,
    linkId: string | null,
    access: 'view' | 'change' | 'upload',
  ): Promise<void>;
  /** Runs inside the upload transaction once the file is recorded (S6: import batch file). */
  onUploaded?(
    tx: Transaction,
    ctx: AuthorizationContext,
    linkId: string | null,
    file: FileRecord,
  ): Promise<void>;
  /**
   * Confirms the record exists in the current organization. `removable` says whether its files
   * may be deleted in the record's current state.
   */
  resolve(
    tx: Transaction,
    organizationId: string,
    linkId: string | null,
  ): Promise<{ removable: boolean; removableReason?: string } | null>;
}

const ALL_TYPES: readonly DetectedType[] = ['pdf', 'png', 'jpeg', 'webp', 'csv', 'xlsx'];

export const attachmentTargets: ReadonlyMap<FileLinkType, AttachmentTarget> = new Map<
  FileLinkType,
  AttachmentTarget
>([
  [
    'organization_logo',
    {
      linkType: 'organization_logo',
      // K-6 / S5-11: images only.
      allowedTypes: ['png', 'jpeg', 'webp'],
      viewPermission: OrganizationPermissions.OrganizationRead,
      changePermission: OrganizationPermissions.OrganizationUpdate,
      resolve: async (_tx, _organizationId, linkId) =>
        linkId === null ? { removable: true } : null,
    },
  ],
  [
    'party',
    {
      linkType: 'party',
      allowedTypes: ALL_TYPES,
      viewPermission: PartyPermissions.View,
      changePermission: PartyPermissions.Update,
      resolve: async (tx, organizationId, linkId) =>
        linkId && (await getParty(tx, organizationId, linkId)) ? { removable: true } : null,
    },
  ],
  [
    'journal',
    {
      linkType: 'journal',
      allowedTypes: ALL_TYPES,
      viewPermission: AccountingPermissions.JournalsView,
      changePermission: AccountingPermissions.JournalsEditDraft,
      // S5-20: attach at any status; remove only while the journal is a draft. Attaching never
      // changes the journal itself.
      resolve: async (tx, organizationId, linkId) => {
        const journal = linkId ? await getJournal(tx, organizationId, linkId) : undefined;
        if (!journal) return null;
        return journal.status === 'DRAFT'
          ? { removable: true }
          : {
              removable: false,
              removableReason: 'Attachments of a submitted or posted journal cannot be removed.',
            };
      },
    },
  ],
  // Phase 3B: attachments on Sales documents; issued PDFs are stored here under legal hold.
  ...(
    [
      ['invoice', SalesPermissions.InvoicesView, SalesPermissions.InvoicesCreate, 'Invoice'],
      [
        'credit_note',
        SalesPermissions.CreditNotesView,
        SalesPermissions.CreditNotesCreate,
        'Credit note',
      ],
      ['receipt', SalesPermissions.ReceiptsView, SalesPermissions.ReceiptsCreate, 'Receipt'],
    ] as const
  ).map(([linkType, view, change, label]): [FileLinkType, AttachmentTarget] => [
    linkType,
    {
      linkType,
      allowedTypes: ALL_TYPES,
      viewPermission: view,
      changePermission: change,
      resolve: async (tx, organizationId, linkId) => {
        if (!linkId) return null;
        const record =
          linkType === 'invoice'
            ? await getInvoice(tx, organizationId, linkId)
            : linkType === 'credit_note'
              ? await getCreditNote(tx, organizationId, linkId)
              : await getReceipt(tx, organizationId, linkId);
        if (!record) return null;
        return record.status === 'DRAFT'
          ? { removable: true }
          : {
              removable: false,
              removableReason: `${label} attachments cannot be removed once it is issued or recorded.`,
            };
      },
    },
  ]),
  [
    'opening_balance_batch',
    {
      linkType: 'opening_balance_batch',
      allowedTypes: ALL_TYPES,
      // S8-17: view with accounting.journals.view, change with accounting.setup, and evidence
      // may be added or removed only while the batch is a draft (posted evidence is immutable).
      viewPermission: AccountingPermissions.JournalsView,
      changePermission: AccountingPermissions.Setup,
      authorize: async (tx, ctx, linkId, access) => {
        requirePermission(
          ctx,
          access === 'view' ? AccountingPermissions.JournalsView : AccountingPermissions.Setup,
        );
        if (access !== 'upload') return;
        const batch = linkId ? await getOpeningBatch(tx, ctx.organizationId, linkId) : undefined;
        if (!batch) throw new NotFoundError('Opening batch not found.');
        if (batch.status !== 'DRAFT') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Evidence can only be attached while the opening batch is a draft.',
          );
        }
      },
      resolve: async (tx, organizationId, linkId) => {
        const batch = linkId ? await getOpeningBatch(tx, organizationId, linkId) : undefined;
        if (!batch) return null;
        return batch.status === 'DRAFT'
          ? { removable: true }
          : {
              removable: false,
              removableReason:
                'Attachments of a submitted, posted or reversed opening batch cannot be removed.',
            };
      },
    },
  ],
]);
