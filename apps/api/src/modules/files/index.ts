/**
 * Public contract of the files module (Decisions 6, 29, 61, 75; S5-01..S5-09, S5-13):
 * storage provider abstraction, local provider, type detection, name sanitization, signed
 * download tokens, the scanning hook and file metadata persistence. It knows nothing about the
 * records files attach to; the application layer registers attachment targets.
 */
export * from './detect.js';
export * from './files.js';
export * from './security.js';
export * from './storage.js';
export { fileLinkTypes, fileStatuses } from './schema.js';
export type { FileLinkType, FileStatus } from './schema.js';

/** Decision 61: maximum general file size, 25 MB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
