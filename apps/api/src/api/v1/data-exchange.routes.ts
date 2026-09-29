import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExportService } from '../../application/data-exchange/export-service.js';
import type { ImportService } from '../../application/data-exchange/import-service.js';
import {
  exportDomainKeys,
  importDomainKeys,
  importRowStatuses,
} from '../../modules/data-exchange/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';
import { contentDisposition } from './files.routes.js';

/** Import and export (S6-46). Every schema is strict: unknown fields are rejected. */

const dateFormat = z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);
const decimalSeparator = z.enum(['.', ',']);
const delimiter = z.enum([',', ';', '\t']);
const version = z.number().int().min(1);
const rowNumber = z.number().int().min(1).max(25_000);

const createImportBody = z
  .object({
    domain: z.enum(importDomainKeys),
    options: z
      .object({
        dateFormat: dateFormat.optional(),
        decimalSeparator: decimalSeparator.optional(),
        delimiter: z.enum(['auto', ',', ';', '\t']).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
const inspectBody = z.object({ delimiter: delimiter.optional() }).strict();
const mappingBody = z
  .object({
    version,
    mapping: z.record(z.string().max(120), z.number().int().min(0).max(199).nullable()),
    options: z
      .object({ dateFormat: dateFormat.optional(), decimalSeparator: decimalSeparator.optional() })
      .strict()
      .default({}),
  })
  .strict();
const exclusionsBody = z
  .object({
    version,
    exclude: z.array(rowNumber).max(25_000).default([]),
    include: z.array(rowNumber).max(25_000).default([]),
  })
  .strict();
const commitBody = z
  .object({
    version,
    acknowledgeWarnings: z.boolean().default(false),
    acknowledgeDuplicateFile: z.boolean().default(false),
  })
  .strict();
const versionBody = z.object({ version }).strict();
const emptyBody = z.object({}).strict();
const listQuery = z
  .object({
    domain: z.enum(importDomainKeys).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const rowsQuery = z
  .object({
    status: z.enum([...importRowStatuses, 'excluded']).optional(),
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();
const templateParams = z.object({ domain: z.enum(importDomainKeys) }).strict();
const mappingsQuery = z.object({ domain: z.enum(importDomainKeys).optional() }).strict();
const saveMappingBody = z
  .object({
    domain: z.enum(importDomainKeys),
    name: z.string().trim().min(1).max(100),
    // Field key -> source header text, so the mapping applies to any column order.
    mapping: z.record(z.string().max(120), z.string().trim().min(1).max(200)),
    options: z
      .object({ dateFormat: dateFormat.optional(), decimalSeparator: decimalSeparator.optional() })
      .strict()
      .default({}),
  })
  .strict();
const createExportBody = z
  .object({
    domain: z.enum(exportDomainKeys),
    params: z.record(z.string().max(60), z.unknown()).default({}),
  })
  .strict();
const exportsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export function registerDataExchangeRoutes(
  app: FastifyInstance,
  deps: { imports: ImportService; exports: ExportService },
): void {
  const { imports, exports } = deps;

  // ---- Imports ----
  app.get('/imports/catalog', async (request) => ({
    data: await imports.catalog(requirePrincipal(request)),
  }));
  app.get('/imports/templates/:domain', async (request, reply) => {
    const { domain } = parseInput(templateParams, request.params);
    const template = await imports.template(requirePrincipal(request), domain);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', contentDisposition(template.fileName))
      .send(template.content);
  });
  app.get('/imports', async (request) => ({
    data: await imports.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/imports', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createImportBody, request.body);
    return reply
      .status(201)
      .send({ data: await imports.create(principal, body, eventOrigin(request)) });
  });
  app.get('/imports/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await imports.get(requirePrincipal(request), id) };
  });
  app.post('/imports/:id/inspect', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await imports.inspect(principal, id, parseInput(inspectBody, request.body)) };
  });
  app.put('/imports/:id/mapping', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(mappingBody, request.body);
    return reply.status(202).send({ data: await imports.setMapping(principal, id, body) });
  });
  app.put('/imports/:id/exclusions', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(exclusionsBody, request.body);
    return reply.status(202).send({ data: await imports.setExclusions(principal, id, body) });
  });
  app.get('/imports/:id/rows', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await imports.rows(requirePrincipal(request), id, parseInput(rowsQuery, request.query)),
    };
  });
  app.post('/imports/:id/commit', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(commitBody, request.body);
    return reply.status(202).send({ data: await imports.commit(principal, id, body) });
  });
  app.post('/imports/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await imports.cancel(principal, id, body, eventOrigin(request)) };
  });
  app.post('/imports/:id/discard-drafts', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(emptyBody, request.body);
    return { data: await imports.discardDrafts(principal, id, eventOrigin(request)) };
  });
  app.post('/imports/:id/error-report', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(emptyBody, request.body);
    return reply.status(202).send({
      data: await exports.create(principal, { domain: 'import_errors', params: { batchId: id } }),
    });
  });

  // ---- Saved mappings ----
  app.get('/import-mappings', async (request) => ({
    data: await imports.listMappings(
      requirePrincipal(request),
      parseInput(mappingsQuery, request.query).domain,
    ),
  }));
  app.post('/import-mappings', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(saveMappingBody, request.body);
    return reply
      .status(201)
      .send({ data: await imports.saveMapping(principal, body, eventOrigin(request)) });
  });
  app.delete('/import-mappings/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    await imports.deleteMapping(principal, id, eventOrigin(request));
    return reply.status(204).send();
  });

  // ---- Exports ----
  app.get('/exports', async (request) => ({
    data: await exports.list(requirePrincipal(request), parseInput(exportsQuery, request.query)),
  }));
  app.post('/exports', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createExportBody, request.body);
    return reply.status(202).send({ data: await exports.create(principal, body) });
  });
  app.get('/exports/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await exports.get(requirePrincipal(request), id) };
  });
  app.get('/exports/:id/download-url', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await exports.downloadUrl(requirePrincipal(request), id) };
  });
}
