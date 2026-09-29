import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FileTooLargeError,
  UnsupportedFileTypeError,
  type FileService,
} from '../../application/file-service.js';
import { ValidationError } from '../../domain/errors.js';
import { fileLinkTypes, MAX_FILE_BYTES, type FileLinkType } from '../../modules/files/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * File endpoints (S5 approved API, §6). Uploads are raw `application/octet-stream` bodies with
 * the name in `X-File-Name` (S5-21); that parser exists only inside this plugin, so every other
 * route stays JSON-only. Every upload names its link target (K-4).
 */

const linkQuery = z
  .object({
    linkType: z.enum(fileLinkTypes),
    linkId: fields.id.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if ((q.linkType === 'organization_logo') !== (q.linkId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['linkId'],
        message:
          q.linkType === 'organization_logo'
            ? 'The organization logo takes no link id.'
            : 'A link id is required.',
      });
    }
  });
const fileParams = z.object({ id: fields.id }).strict();
const contentQuery = z.object({ token: z.string().min(1).max(1000) }).strict();
const logoBody = z.object({ fileId: fields.id }).strict();

/** `X-File-Name` is percent-encoded UTF-8 (headers are Latin-1 only). */
function fileNameHeader(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new ValidationError([
      { path: 'x-file-name', message: 'The file name header is required.' },
    ]);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError([{ path: 'x-file-name', message: 'The file name is not valid.' }]);
  }
}

/** RFC 6266 / RFC 5987 attachment disposition with an ASCII fallback. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function registerFileRoutes(app: FastifyInstance, deps: { files: FileService }): void {
  const { files } = deps;

  void app.register(async (scoped) => {
    // The body is handed over unread; FileService streams it with the 25 MB cap (Decision 61).
    scoped.addContentTypeParser('application/octet-stream', (request, payload, done) => {
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
        done(new FileTooLargeError(), undefined);
        return;
      }
      done(null, payload);
    });

    scoped.post('/files', async (request, reply) => {
      const principal = requirePrincipal(request);
      const query = parseInput(linkQuery, request.query);
      const fileName = fileNameHeader(request.headers['x-file-name']);
      if (!(request.body instanceof Readable)) {
        throw new UnsupportedFileTypeError();
      }
      const linkType: FileLinkType = query.linkType;
      const linkId = query.linkId ?? null;
      // Authorize before reading a single byte of the body.
      await files.authorizeUpload(principal, linkType, linkId);
      const data = await files.upload(
        principal,
        { linkType, linkId, fileName, content: request.body },
        eventOrigin(request),
      );
      return reply.status(201).send({ data });
    });
  });

  app.get('/files', async (request) => {
    const query = parseInput(linkQuery, request.query);
    return {
      data: await files.list(requirePrincipal(request), query.linkType, query.linkId ?? null),
    };
  });
  // Registered before /files/:id so the static segment wins.
  app.get('/files/content', async (request, reply) => {
    const { token } = parseInput(contentQuery, request.query);
    const { file, stream } = await files.openContent(request.principal, token);
    // S5-09 delivery headers: never rendered inline, never sniffed, never cached or framed.
    return reply
      .header('content-type', file.mimeType)
      .header('content-length', String(file.sizeBytes))
      .header('content-disposition', contentDisposition(file.originalName))
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'private, no-store')
      .send(stream);
  });
  app.get('/files/:id', async (request) => {
    const { id } = parseInput(fileParams, request.params);
    return { data: await files.get(requirePrincipal(request), id) };
  });
  app.get('/files/:id/download-url', async (request) => {
    const { id } = parseInput(fileParams, request.params);
    return { data: await files.downloadUrl(requirePrincipal(request), id) };
  });
  app.delete('/files/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(fileParams, request.params);
    await files.delete(principal, id, eventOrigin(request));
    return reply.status(204).send();
  });

  // ---- Organization logo (S4-03, S5-11, S5-12) ----
  app.put('/organizations/current/profile/logo', async (request) => {
    const principal = requirePrincipal(request);
    const { fileId } = parseInput(logoBody, request.body);
    return { data: await files.setLogo(principal, fileId, eventOrigin(request)) };
  });
  app.delete('/organizations/current/profile/logo', async (request) => {
    const principal = requirePrincipal(request);
    return { data: await files.setLogo(principal, null, eventOrigin(request)) };
  });
}
