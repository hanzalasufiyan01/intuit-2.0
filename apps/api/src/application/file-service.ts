import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getUserProfiles } from '../modules/identity/index.js';
import {
  deriveDownloadKey,
  detectFileType,
  getFileWithLink,
  insertFile,
  listDuePurges,
  listLinkedFiles,
  liveStorageKeys,
  markFileDeleted,
  markFilePurged,
  MAX_FILE_BYTES,
  MIME_TYPES,
  sanitizeFileName,
  signDownloadToken,
  storageKeyFor,
  tenantPrefix,
  verifyDownloadToken,
  type FileLink,
  type FileLinkType,
  type FileRecord,
  type FileScanner,
  type StorageProvider,
} from '../modules/files/index.js';
import {
  getOrganizationProfile,
  OrganizationPermissions,
  setOrganizationLogo,
} from '../modules/organizations/index.js';
import { attachmentTargets, type AttachmentTarget } from './attachment-targets.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import { systemOrigin, type JobContext } from './job-service.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * File storage service (Decisions 6, 29, 61, 65; S5-01..S5-13, S5-18, S5-20, S5-21).
 * Uploads stream to a temporary file (25 MB cap, hashed as they arrive), are type-checked by
 * content, scanned by the configured scanner, stored under a server-generated tenant key and
 * recorded with their single link. Access always inherits the linked record's permission.
 */

/** The static permission option, when the target has one. */
const staticPermission = (permission: string | null) => (permission ? { permission } : {});

/** Objects younger than this are never treated as orphans (their upload may be committing). */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export class FileTooLargeError extends AppError {
  constructor() {
    super('FILE_TOO_LARGE', 413, 'Files can be at most 25 MB.');
  }
}

export class UnsupportedFileTypeError extends AppError {
  constructor() {
    super(
      'UNSUPPORTED_FILE_TYPE',
      415,
      'This file type is not accepted here, or its content does not match its extension.',
    );
  }
}

export function fileView(
  file: FileRecord,
  link: FileLink,
  uploaders: ReadonlyMap<string, { displayName: string }> = new Map(),
) {
  return {
    id: file.id,
    name: file.originalName,
    type: file.detectedType,
    mimeType: file.mimeType,
    size: file.sizeBytes,
    sha256: file.sha256,
    status: file.status,
    scanStatus: file.scanStatus,
    uploadedAt: file.uploadedAt.toISOString(),
    // Display name only (no email): shown in attachment lists (S5 §13).
    uploadedBy: {
      id: file.uploadedByUserId,
      displayName: uploaders.get(file.uploadedByUserId)?.displayName ?? null,
    },
    link: { type: link.linkType, id: link.linkId },
  };
}

/** Streams into `target`, hashing and enforcing the size cap as bytes arrive. */
async function receive(
  source: Readable,
  target: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        callback(new FileTooLargeError());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(source, meter, createWriteStream(target, { flags: 'wx' }));
  return { size, sha256: hash.digest('hex') };
}

export class FileService {
  private readonly downloadKey: Buffer;

  constructor(
    private readonly deps: AppDependencies,
    private readonly storage: StorageProvider,
    private readonly scanner: FileScanner,
    private readonly targets: ReadonlyMap<FileLinkType, AttachmentTarget> = attachmentTargets,
  ) {
    this.downloadKey = deriveDownloadKey(deps.config.session.secret);
  }

  private get now() {
    return this.deps.clock.now();
  }

  private target(linkType: FileLinkType): AttachmentTarget {
    const target = this.targets.get(linkType);
    if (!target)
      throw new ValidationError([{ path: 'linkType', message: 'Unknown attachment target.' }]);
    return target;
  }

  /** Static or per-record authorization of a target (S6: per record for batches and exports). */
  private async authorizeTarget(
    tx: Transaction,
    ctx: AuthorizationContext,
    target: AttachmentTarget,
    linkId: string | null,
    access: 'view' | 'change' | 'upload',
  ) {
    if (access === 'upload' && target.uploads === false) {
      throw new ForbiddenError('Files cannot be uploaded here.');
    }
    if (target.authorize) {
      await target.authorize(tx, ctx, linkId, access);
      return;
    }
    const permission = access === 'view' ? target.viewPermission : target.changePermission;
    if (permission) requirePermission(ctx, permission);
  }

  private async resolveTarget(
    tx: Transaction,
    ctx: AuthorizationContext,
    target: AttachmentTarget,
    linkId: string | null,
  ) {
    const resolved = await target.resolve(tx, ctx.organizationId, linkId);
    if (!resolved) throw new NotFoundError('The record to attach to was not found.');
    return resolved;
  }

  /** Loads a file with its link and checks the linked record's permission (Decision 65). */
  private async loadAuthorized(
    tx: Transaction,
    ctx: AuthorizationContext,
    fileId: string,
    access: 'view' | 'change',
    options: { forUpdate?: boolean } = {},
  ) {
    const found = await getFileWithLink(tx, ctx.organizationId, fileId, options);
    if (!found || found.file.status === 'deleted' || found.file.status === 'purged') {
      throw new NotFoundError('File not found.');
    }
    const target = this.target(found.link.linkType);
    await this.authorizeTarget(tx, ctx, target, found.link.linkId, access);
    return { ...found, target };
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    fileId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'file',
      resourceId: fileId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Upload (S5-04, S5-06, S5-07, S5-21)
  // ---------------------------------------------------------------------------

  /** Authorizes an upload before any of its body is read (no anonymous or unauthorized bytes). */
  authorizeUpload(principal: Principal, linkType: FileLinkType, linkId: string | null) {
    const target = this.target(linkType);
    return withOrganization(
      this.deps,
      principal,
      staticPermission(target.changePermission),
      async (tx, ctx) => {
        await this.authorizeTarget(tx, ctx, target, linkId, 'upload');
        await this.resolveTarget(tx, ctx, target, linkId);
      },
    );
  }

  async upload(
    principal: Principal,
    input: { linkType: FileLinkType; linkId: string | null; fileName: string; content: Readable },
    origin: EventOrigin,
  ) {
    const target = this.target(input.linkType);
    const temporary = path.join(tmpdir(), `intuit2-upload-${randomUUID()}`);
    try {
      const { size, sha256 } = await receive(input.content, temporary);
      if (size === 0)
        throw new ValidationError([{ path: '(body)', message: 'The file is empty.' }]);
      const name = sanitizeFileName(input.fileName);
      const type = await detectFileType(temporary, size, name);
      if (!type || !target.allowedTypes.includes(type)) throw new UnsupportedFileTypeError();
      const scan = await this.scanner.scan(temporary);

      return await withOrganization(
        this.deps,
        principal,
        staticPermission(target.changePermission),
        async (tx, ctx) => {
          await this.authorizeTarget(tx, ctx, target, input.linkId, 'upload');
          await this.resolveTarget(tx, ctx, target, input.linkId);
          const id = randomUUID();
          const now = this.now;
          const key = storageKeyFor(ctx.organizationId, id, now);
          // Stored before commit; if the transaction fails, the purge's orphan sweep removes it.
          await this.storage.put(key, createReadStream(temporary));
          const file = await insertFile(
            tx,
            {
              id,
              organizationId: ctx.organizationId,
              storageProvider: this.storage.name,
              storageKey: key,
              originalName: name,
              detectedType: type,
              mimeType: MIME_TYPES[type],
              sizeBytes: size,
              sha256,
              status: scan === 'infected' ? 'quarantined' : 'available',
              scanStatus: scan,
              uploadedByUserId: ctx.userId,
              uploadedAt: now,
            },
            { linkType: input.linkType, linkId: input.linkId, userId: ctx.userId },
          );
          await this.audit(
            tx,
            ctx,
            'file.uploaded',
            id,
            { linkType: input.linkType, linkId: input.linkId, type, size, sha256, name },
            origin,
          );
          await target.onUploaded?.(tx, ctx, input.linkId, file);
          const found = await getFileWithLink(tx, ctx.organizationId, id);
          return fileView(file, found!.link, await getUserProfiles(tx, [ctx.userId]));
        },
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  list(principal: Principal, linkType: FileLinkType, linkId: string | null) {
    const target = this.target(linkType);
    return withOrganization(
      this.deps,
      principal,
      staticPermission(target.viewPermission),
      async (tx, ctx) => {
        await this.authorizeTarget(tx, ctx, target, linkId, 'view');
        await this.resolveTarget(tx, ctx, target, linkId);
        const rows = await listLinkedFiles(tx, ctx.organizationId, linkType, linkId);
        const uploaders = await getUserProfiles(tx, [
          ...new Set(rows.map((r) => r.file.uploadedByUserId)),
        ]);
        return rows.map((r) => fileView(r.file, r.link, uploaders));
      },
    );
  }

  get(principal: Principal, fileId: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { file, link } = await this.loadAuthorized(tx, ctx, fileId, 'view');
      return fileView(file, link, await getUserProfiles(tx, [file.uploadedByUserId]));
    });
  }

  /** A 5-minute signed URL bound to the file, organization and user (S5-08). */
  downloadUrl(principal: Principal, fileId: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { file } = await this.loadAuthorized(tx, ctx, fileId, 'view');
      if (file.status !== 'available') throw new NotFoundError('File not found.');
      const expiresAt = this.now.getTime() + this.deps.config.storage.downloadTokenTtlMs;
      const token = signDownloadToken(this.downloadKey, {
        fileId: file.id,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        expiresAt,
      });
      return {
        url: `/api/v1/files/content?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
  }

  /**
   * Resolves a signed token to a readable file. The token alone authorizes the read; when a
   * session is present it must belong to the same user. Deleted, purged or quarantined files
   * are not served.
   */
  async openContent(principal: Principal | null, token: string) {
    const claims = verifyDownloadToken(this.downloadKey, token, this.now);
    if (!claims) throw new ForbiddenError('This download link is invalid or has expired.');
    if (principal && principal.user.id !== claims.userId) {
      throw new ForbiddenError('This download link belongs to another user.');
    }
    const found = await inTransaction(
      this.deps.db,
      { userId: claims.userId, organizationId: claims.organizationId },
      (tx) => getFileWithLink(tx, claims.organizationId, claims.fileId),
    );
    if (!found || found.file.status !== 'available') throw new NotFoundError('File not found.');
    return { file: found.file, stream: await this.storage.get(found.file.storageKey) };
  }

  // ---------------------------------------------------------------------------
  // Delete (S5-13, S5-20)
  // ---------------------------------------------------------------------------

  delete(principal: Principal, fileId: string, origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { file, link, target } = await this.loadAuthorized(tx, ctx, fileId, 'change', {
        forUpdate: true,
      });
      const resolved = await this.resolveTarget(tx, ctx, target, link.linkId);
      if (!resolved.removable) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          resolved.removableReason ?? 'This file cannot be removed.',
        );
      }
      if (file.legalHold) {
        throw new ConflictError(
          'LEGAL_HOLD',
          'This file is under legal hold and cannot be deleted.',
        );
      }
      if (link.linkType === 'organization_logo') {
        const profile = await getOrganizationProfile(tx, ctx.organizationId);
        if (profile?.profile.logoFileId === file.id) {
          throw new ConflictError(
            'CONFLICT',
            'This file is the current logo. Remove the logo instead.',
          );
        }
      }
      await this.softDelete(tx, ctx, file, origin);
    });
  }

  /**
   * Stores a server-generated file (S6 exports) with the same key, type-detection, hash and
   * scanning rules as uploads, linked to its record, inside the caller's transaction. The
   * export's own audit event (export.generated) records it.
   */
  async storeGeneratedInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      linkType: FileLinkType;
      linkId: string;
      fileName: string;
      sourcePath: string;
      /** Phase 3B (Decisions 21, 29): issued Sales PDFs cannot be removed by users. */
      legalHold?: boolean;
    },
  ): Promise<FileRecord> {
    const { size } = await stat(input.sourcePath);
    if (size > MAX_FILE_BYTES) throw new FileTooLargeError();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(input.sourcePath)) hash.update(chunk as Buffer);
    const sha256 = hash.digest('hex');
    const name = sanitizeFileName(input.fileName);
    const type = await detectFileType(input.sourcePath, size, name);
    if (!type) throw new UnsupportedFileTypeError();
    const scan = await this.scanner.scan(input.sourcePath);
    const id = randomUUID();
    const now = this.now;
    const key = storageKeyFor(ctx.organizationId, id, now);
    await this.storage.put(key, createReadStream(input.sourcePath));
    return insertFile(
      tx,
      {
        id,
        organizationId: ctx.organizationId,
        storageProvider: this.storage.name,
        storageKey: key,
        originalName: name,
        detectedType: type,
        mimeType: MIME_TYPES[type],
        sizeBytes: size,
        sha256,
        status: scan === 'infected' ? 'quarantined' : 'available',
        scanStatus: scan,
        uploadedByUserId: ctx.userId,
        uploadedAt: now,
        legalHold: input.legalHold === true,
      },
      { linkType: input.linkType, linkId: input.linkId, userId: ctx.userId },
    );
  }

  /** Streams the content of an available file of the current tenant (S6 import parsing). */
  async openStreamInTransaction(tx: Transaction, organizationId: string, fileId: string) {
    const found = await getFileWithLink(tx, organizationId, fileId);
    if (!found || found.file.status !== 'available') throw new NotFoundError('File not found.');
    return { file: found.file, stream: await this.storage.get(found.file.storageKey) };
  }

  /** Soft-deletes a file as the system (S6 cleanup: expired exports, finished imports). */
  async systemDeleteInTransaction(
    tx: Transaction,
    organizationId: string,
    fileId: string,
    origin: EventOrigin,
  ): Promise<boolean> {
    const now = this.now;
    const deleted = await markFileDeleted(tx, {
      organizationId,
      fileId,
      userId: null,
      now,
      purgeAfter: new Date(now.getTime() + this.deps.config.storage.retentionMs),
    });
    if (!deleted) return false;
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'file.deleted',
      resourceType: 'file',
      resourceId: fileId,
      metadata: {
        name: deleted.originalName,
        purgeAfter: deleted.purgeAfter?.toISOString() ?? null,
      },
      origin,
    });
    return true;
  }

  private async softDelete(
    tx: Transaction,
    ctx: AuthorizationContext,
    file: FileRecord,
    origin: EventOrigin,
  ) {
    const now = this.now;
    const deleted = await markFileDeleted(tx, {
      organizationId: ctx.organizationId,
      fileId: file.id,
      userId: ctx.userId,
      now,
      purgeAfter: new Date(now.getTime() + this.deps.config.storage.retentionMs),
    });
    if (!deleted) throw new ConflictError('LEGAL_HOLD', 'This file cannot be deleted.');
    await this.audit(
      tx,
      ctx,
      'file.deleted',
      file.id,
      { name: file.originalName, purgeAfter: deleted.purgeAfter?.toISOString() ?? null },
      origin,
    );
  }

  // ---------------------------------------------------------------------------
  // Purge (S5-13, S5-19): the `files.purge` job handler
  // ---------------------------------------------------------------------------

  /**
   * Removes the stored objects of deleted files past retention (never under legal hold) and
   * marks them purged, then sweeps orphaned objects: stored under the tenant prefix, unknown to
   * the database and older than the one-hour grace that covers uploads still committing.
   */
  async purge(job: JobContext): Promise<{ purged: number; orphansRemoved: number }> {
    const { organizationId } = job;
    const batchSize = 100;
    let purged = 0;
    for (;;) {
      const count = await job.run(async (tx) => {
        const due = await listDuePurges(tx, organizationId, batchSize);
        for (const file of due) {
          await this.storage.delete(file.storageKey);
          await markFilePurged(tx, organizationId, file.id);
          await recordAuditEvent(tx, {
            occurredAt: this.now,
            organizationId,
            actorUserId: null,
            actorType: 'system',
            action: 'file.purged',
            resourceType: 'file',
            resourceId: file.id,
            metadata: { name: file.originalName, sha256: file.sha256, size: file.sizeBytes },
            origin: systemOrigin(job.job.id),
          });
        }
        return due.length;
      });
      purged += count;
      if (count < batchSize) break;
    }
    await job.progress(50, 'Purged deleted files');

    const objects = await this.storage.list(tenantPrefix(organizationId));
    const live = await job.run((tx) => liveStorageKeys(tx, organizationId));
    const cutoff = this.now.getTime() - ORPHAN_GRACE_MS;
    let orphansRemoved = 0;
    for (const object of objects) {
      if (live.has(object.key) || object.modifiedAt.getTime() > cutoff) continue;
      await this.storage.delete(object.key);
      orphansRemoved += 1;
    }
    if (orphansRemoved > 0) {
      this.deps.logger.info({ organizationId, orphansRemoved }, 'Removed orphaned file objects');
    }
    return { purged, orphansRemoved };
  }

  // ---------------------------------------------------------------------------
  // Organization logo (S4-03, S5-11, S5-12)
  // ---------------------------------------------------------------------------

  setLogo(principal: Principal, fileId: string | null, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationUpdate },
      async (tx, ctx) => {
        const current = await getOrganizationProfile(tx, ctx.organizationId, { forUpdate: true });
        if (!current) {
          throw new ConflictError('CONFLICT', 'Save the company profile before adding a logo.');
        }
        const previous = current.profile.logoFileId;
        if (fileId !== null) {
          const found = await getFileWithLink(tx, ctx.organizationId, fileId);
          if (
            !found ||
            found.file.status !== 'available' ||
            found.link.linkType !== 'organization_logo'
          ) {
            throw new ValidationError([
              { path: 'fileId', message: 'Upload the image as a logo file first.' },
            ]);
          }
        }
        if (previous === fileId) return { logo: fileId ? { fileId } : null };
        await setOrganizationLogo(tx, ctx.organizationId, fileId);
        if (previous) {
          const old = await getFileWithLink(tx, ctx.organizationId, previous, { forUpdate: true });
          if (
            old &&
            (old.file.status === 'available' || old.file.status === 'quarantined') &&
            !old.file.legalHold
          ) {
            await this.softDelete(tx, ctx, old.file, origin);
          }
        }
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'organization.logo_changed',
          resourceType: 'organization',
          resourceId: ctx.organizationId,
          metadata: { from: previous, to: fileId },
          origin,
        });
        return { logo: fileId ? { fileId } : null };
      },
    );
  }
}
