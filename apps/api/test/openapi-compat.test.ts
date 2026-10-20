import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/api/public/openapi.js';
import {
  canonical,
  compareOpenApi,
  evaluate,
  formatFindings,
  hasBreaking,
  hasErrors,
  validateOpenApiDocument,
  type Finding,
  type Severity,
} from '../scripts/openapi-compat.js';

/**
 * ADR 0011 Step 7, WS1: the OpenAPI compatibility classifier, on synthetic before/after documents
 * and on the real contract. Pure unit tests: no database. The generated-contract drift test stays
 * in public-api.test.ts.
 */

type Doc = any;

/** A small but representative document: paths, parameters, a body, responses, refs, scopes. */
function baseDoc(): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    servers: [{ url: '/public/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'things' }],
    paths: {
      '/things': {
        get: {
          tags: ['things'],
          summary: 'List things',
          'x-required-scope': 'things:read',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
            },
          ],
          responses: {
            '200': {
              description: 'A page',
              headers: { 'RateLimit-Limit': { schema: { type: 'integer' } } },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['data'],
                    additionalProperties: false,
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
                    },
                  },
                },
              },
            },
            '401': {
              description: 'No',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
        post: {
          tags: ['things'],
          summary: 'Create a thing',
          'x-required-scope': 'things:write',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ThingCreate' } },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
          },
        },
      },
      '/things/{id}': {
        get: {
          tags: ['things'],
          summary: 'Get a thing',
          'x-required-scope': 'things:read',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'A thing',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Thing: {
          type: 'object',
          required: ['id', 'name'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            note: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
            owner: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            parent: { $ref: '#/components/schemas/Thing' }, // recursive
          },
        },
        ThingCreate: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            kind: { type: 'string', enum: ['A', 'B'] },
            note: { type: ['string', 'null'] },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'object', properties: { code: { type: 'string' } } } },
        },
      },
    },
  };
}

const okGet = (d: Doc) => d.paths['/things'].get;
const thing = (d: Doc) => d.components.schemas.Thing;
const create = (d: Doc) => d.components.schemas.ThingCreate;

function classify(mutate: (d: Doc) => void): Finding[] {
  const after = baseDoc();
  mutate(after);
  return compareOpenApi(baseDoc(), after);
}
const has = (findings: Finding[], severity: Severity, code: string) =>
  findings.some((f) => f.severity === severity && f.code === code);

describe('OpenAPI compatibility classifier: synthetic documents', () => {
  it('reports nothing for identical documents, whatever the key order', () => {
    expect(compareOpenApi(baseDoc(), baseDoc())).toEqual([]);
    const shuffled = JSON.parse(JSON.stringify(baseDoc()), function (_k, v) {
      return v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v;
    });
    expect(compareOpenApi(baseDoc(), shuffled)).toEqual([]);
    expect(canonical(baseDoc())).toBe(canonical(shuffled));
  });

  describe('breaking changes', () => {
    const breaking: [string, (d: Doc) => void, string][] = [
      ['a removed path', (d) => delete d.paths['/things/{id}'], 'path.removed'],
      ['a removed method', (d) => delete d.paths['/things'].post, 'method.removed'],
      ['a removed response code', (d) => delete okGet(d).responses['401'], 'response.removed'],
      [
        'a removed response header',
        (d) => delete okGet(d).responses['200'].headers['RateLimit-Limit'],
        'header.removed',
      ],
      [
        'a removed media type',
        (d) => (okGet(d).responses['200'].content = {}),
        'mediaType.removed',
      ],
      ['a removed response property', (d) => delete thing(d).properties.name, 'property.removed'],
      [
        'a response property no longer guaranteed',
        (d) => (thing(d).required = ['id']),
        'required.removed',
      ],
      ['a removed request property', (d) => delete create(d).properties.kind, 'property.removed'],
      [
        'a newly required request property',
        (d) => (create(d).required = ['name', 'kind']),
        'required.added',
      ],
      [
        'a new required request property',
        (d) => {
          create(d).properties.extra = { type: 'string' };
          create(d).required = ['name', 'extra'];
        },
        'required.added',
      ],
      ['a removed parameter', (d) => okGet(d).parameters.pop(), 'parameter.removed'],
      [
        'a new required parameter',
        (d) =>
          okGet(d).parameters.push({
            name: 'tenant',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          }),
        'parameter.required.added',
      ],
      [
        'an optional parameter made required',
        (d) => (okGet(d).parameters[1].required = true),
        'parameter.required.added',
      ],
      [
        'a parameter that moved location',
        (d) => (okGet(d).parameters[1].in = 'header'),
        'parameter.removed',
      ],
      ['a narrowed request enum', (d) => (create(d).properties.kind.enum = ['A']), 'enum.narrowed'],
      [
        'a narrowed response enum',
        (d) => (thing(d).properties.status.enum = ['ACTIVE']),
        'enum.narrowed',
      ],
      [
        'a narrowed query enum',
        (d) => (okGet(d).parameters[1].schema.enum = ['ACTIVE']),
        'enum.narrowed',
      ],
      [
        'an enum added to a request field',
        (d) => (create(d).properties.note.enum = ['x', null]),
        'enum.added',
      ],
      [
        'a changed request type',
        (d) => (create(d).properties.name.type = 'integer'),
        'type.changed',
      ],
      [
        'a narrowed request type',
        (d) => (create(d).properties.note.type = 'string'),
        'type.changed',
      ],
      [
        'a response type widened to nullable',
        (d) => (thing(d).properties.name.type = ['string', 'null']),
        'type.changed',
      ],
      [
        'a changed response type',
        (d) => (thing(d).properties.name.type = 'integer'),
        'type.changed',
      ],
      ['a changed format', (d) => (thing(d).properties.id.format = 'date-time'), 'format.changed'],
      [
        'a request pattern added',
        (d) => (create(d).properties.name.pattern = '^[a-z]+$'),
        'format.changed',
      ],
      [
        'a raised request minimum',
        (d) => (okGet(d).parameters[0].schema.minimum = 5),
        'bound.changed',
      ],
      [
        'a lowered request maximum',
        (d) => (create(d).properties.name.maxLength = 50),
        'bound.changed',
      ],
      ['a request bound added', (d) => (create(d).properties.name.minLength = 3), 'bound.changed'],
      [
        'a changed request default',
        (d) => (okGet(d).parameters[0].schema.default = 50),
        'default.changed',
      ],
      [
        'a removed request body',
        (d) => delete d.paths['/things'].post.requestBody,
        'requestBody.removed',
      ],
      [
        'a changed security scheme',
        (d) => (d.components.securitySchemes.bearerAuth.scheme = 'basic'),
        'securityScheme.changed',
      ],
      [
        'a removed security scheme',
        (d) => delete d.components.securitySchemes.bearerAuth,
        'securityScheme.removed',
      ],
      [
        'a changed operation security',
        (d) => (okGet(d).security = [{ other: [] }]),
        'security.changed',
      ],
      ['a changed document security', (d) => (d.security = []), 'security.changed'],
      [
        'a changed required scope',
        (d) => (okGet(d)['x-required-scope'] = 'things:admin'),
        'scope.changed',
      ],
      ['a changed server', (d) => (d.servers = [{ url: '/public/v2' }]), 'servers.changed'],
      [
        'a changed operationId',
        (d) => (okGet(d).operationId = 'listThings'),
        'operationId.changed',
      ],
      [
        'a change inside a referenced schema',
        (d) => (thing(d).properties.id.type = 'integer'),
        'type.changed',
      ],
      [
        'a response alternative added',
        (d) => thing(d).properties.owner.anyOf.push({ type: 'integer' }),
        'anyOf.alternative.added',
      ],
      [
        'an unmodelled schema keyword',
        (d) => (thing(d).oneOf = [{ type: 'object' }]),
        'unclassified',
      ],
      ['an unmodelled operation key', (d) => (okGet(d).callbacks = { x: {} }), 'unclassified'],
      ['an unmodelled top-level key', (d) => (d.webhooks = { x: {} }), 'unclassified'],
      ['a readOnly flag', (d) => (thing(d).properties.id.readOnly = true), 'access.changed'],
    ];
    for (const [name, mutate, code] of breaking) {
      it(`flags ${name}`, () => {
        const findings = classify(mutate);
        expect(hasBreaking(findings), formatFindings(findings).join('\n')).toBe(true);
        expect(has(findings, 'breaking', code), formatFindings(findings).join('\n')).toBe(true);
      });
    }

    it('flags a request body that became required, an added required scope and a removed request alternative', () => {
      const optionalBody = baseDoc();
      optionalBody.paths['/things'].post.requestBody.required = false;
      expect(
        has(compareOpenApi(optionalBody, baseDoc()), 'breaking', 'requestBody.required.added'),
      ).toBe(true);
      const unscoped = baseDoc();
      delete unscoped.paths['/things'].get['x-required-scope'];
      expect(has(compareOpenApi(unscoped, baseDoc()), 'breaking', 'scope.changed')).toBe(true);
      const alternatives = baseDoc();
      create(alternatives).properties.note = { anyOf: [{ type: 'string' }, { type: 'null' }] };
      const narrowed = baseDoc();
      create(narrowed).properties.note = { anyOf: [{ type: 'string' }] };
      expect(
        has(compareOpenApi(alternatives, narrowed), 'breaking', 'anyOf.alternative.removed'),
      ).toBe(true);
    });

    it('flags a request object that now refuses unknown fields, and accepts the reverse', () => {
      const open = baseDoc();
      delete create(open).additionalProperties;
      const refused = compareOpenApi(open, baseDoc());
      expect(has(refused, 'breaking', 'additionalProperties.changed')).toBe(true);
      const accepted = compareOpenApi(baseDoc(), open);
      expect(has(accepted, 'additive', 'additionalProperties.changed')).toBe(true);
      expect(hasBreaking(accepted)).toBe(false);
    });

    it('flags a new required body only when it is required', () => {
      const without = baseDoc();
      delete without.paths['/things'].post.requestBody;
      expect(
        has(compareOpenApi(without, baseDoc()), 'breaking', 'requestBody.required.added'),
      ).toBe(true);
      const optional = baseDoc();
      optional.paths['/things'].post.requestBody.required = false;
      const f = compareOpenApi(without, optional);
      expect(has(f, 'additive', 'requestBody.added')).toBe(true);
      expect(hasBreaking(f)).toBe(false);
    });
  });

  describe('additive changes', () => {
    const additive: [string, (d: Doc) => void, string][] = [
      [
        'an added path',
        (d) => (d.paths['/others'] = { get: { responses: { '200': { description: 'ok' } } } }),
        'path.added',
      ],
      [
        'an added method',
        (d) => (d.paths['/things/{id}'].delete = { responses: { '204': { description: 'gone' } } }),
        'method.added',
      ],
      [
        'an added response code',
        (d) => (okGet(d).responses['429'] = { description: 'slow down' }),
        'response.added',
      ],
      [
        'an added response header',
        (d) => (okGet(d).responses['200'].headers['Retry-After'] = { schema: { type: 'integer' } }),
        'header.added',
      ],
      [
        'an added response property',
        (d) => (thing(d).properties.extra = { type: 'string' }),
        'property.added',
      ],
      [
        'a response property that is now always present',
        (d) => (thing(d).required = ['id', 'name', 'status']),
        'required.added',
      ],
      [
        'an added optional request property',
        (d) => (create(d).properties.extra = { type: 'string' }),
        'property.added',
      ],
      ['a request property made optional', (d) => (create(d).required = []), 'required.removed'],
      [
        'an added optional parameter',
        (d) => okGet(d).parameters.push({ name: 'q', in: 'query', schema: { type: 'string' } }),
        'parameter.added',
      ],
      ['a widened enum', (d) => thing(d).properties.status.enum.push('DRAFT'), 'enum.widened'],
      ['a widened request enum', (d) => create(d).properties.kind.enum.push('C'), 'enum.widened'],
      [
        'a removed request enum constraint',
        (d) => delete create(d).properties.kind.enum,
        'enum.removed',
      ],
      [
        'a widened request type',
        (d) => (create(d).properties.name.type = ['string', 'null']),
        'type.compatible',
      ],
      [
        'a narrowed response type',
        (d) => (thing(d).properties.note.type = 'string'),
        'type.compatible',
      ],
      [
        'a lowered request minimum',
        (d) => (okGet(d).parameters[0].schema.minimum = 0),
        'bound.changed',
      ],
      [
        'a raised request maximum',
        (d) => (create(d).properties.name.maxLength = 500),
        'bound.changed',
      ],
      [
        'a removed request bound',
        (d) => delete create(d).properties.name.minLength,
        'bound.changed',
      ],
      ['a removed required scope', (d) => delete okGet(d)['x-required-scope'], 'scope.removed'],
      [
        'an added security scheme',
        (d) => (d.components.securitySchemes.apiKey = { type: 'apiKey', in: 'header', name: 'k' }),
        'securityScheme.added',
      ],
      [
        'an added request media type',
        (d) =>
          (d.paths['/things'].post.requestBody.content['application/xml'] = {
            schema: { type: 'string' },
          }),
        'mediaType.added',
      ],
    ];
    for (const [name, mutate, code] of additive) {
      it(`classifies ${name} as additive`, () => {
        const findings = classify(mutate);
        expect(hasBreaking(findings), formatFindings(findings).join('\n')).toBe(false);
        expect(has(findings, 'additive', code), formatFindings(findings).join('\n')).toBe(true);
      });
    }

    it('classifies a required parameter made optional and an added request alternative as additive', () => {
      const required = baseDoc();
      okGet(required).parameters[0].required = true;
      const f = compareOpenApi(required, baseDoc());
      expect(has(f, 'additive', 'parameter.required.removed')).toBe(true);
      expect(hasBreaking(f)).toBe(false);
      const narrow = baseDoc();
      create(narrow).properties.note = { anyOf: [{ type: 'string' }] };
      const wide = baseDoc();
      create(wide).properties.note = { anyOf: [{ type: 'string' }, { type: 'null' }] };
      const alternatives = compareOpenApi(narrow, wide);
      expect(has(alternatives, 'additive', 'anyOf.alternative.added')).toBe(true);
      expect(hasBreaking(alternatives)).toBe(false);
    });

    it('treats a response alternative removed or an optional response field changing nothing else as additive', () => {
      const f = classify((d) => thing(d).properties.owner.anyOf.pop());
      expect(has(f, 'additive', 'anyOf.alternative.removed')).toBe(true);
      expect(hasBreaking(f)).toBe(false);
    });
  });

  describe('informational changes', () => {
    it('reports documentation, tag and version changes without failing anything', () => {
      const findings = classify((d) => {
        d.info.version = '1.1.0';
        d.openapi = '3.1.1';
        okGet(d).summary = 'List all things';
        thing(d).properties.name.description = 'The name';
        d.tags.push({ name: 'more' });
        d.components.schemas.Extra = { type: 'object' };
      });
      expect(findings.every((f) => f.severity === 'info')).toBe(true);
      expect(findings.map((f) => f.code).sort()).toEqual(
        [
          'docs.changed',
          'docs.changed',
          'info.version.changed',
          'openapi.version.changed',
          'schema.added',
          'tags.changed',
        ].sort(),
      );
    });
  });

  describe('structure', () => {
    it('terminates on recursive schemas and compares each referenced pair once', () => {
      const findings = classify((d) => (thing(d).properties.id.type = 'integer'));
      // Thing is referenced from the list response, the create response, the detail response and
      // recursively by itself, yet each distinct (direction, before, after) pair is compared once.
      expect(findings.filter((f) => f.code === 'type.changed').length).toBeLessThanOrEqual(2);
      expect(hasBreaking(findings)).toBe(true);
    });

    it('compares a path-level parameter with the same parameter moved to the operation', () => {
      const before = baseDoc();
      const after = baseDoc();
      const parameter = after.paths['/things/{id}'].get.parameters.pop();
      after.paths['/things/{id}'].parameters = [parameter];
      expect(compareOpenApi(before, after)).toEqual([]);
    });

    it('resolves parameter and response references', () => {
      const withRefs = (response: unknown) => {
        const d = baseDoc();
        d.components.parameters = { Limit: okGet(d).parameters[0] };
        d.components.responses = { Unauthorized: response };
        okGet(d).parameters[0] = { $ref: '#/components/parameters/Limit' };
        okGet(d).responses['401'] = { $ref: '#/components/responses/Unauthorized' };
        return d;
      };
      const response = {
        description: 'No',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
      const before = withRefs(response);
      const after = withRefs(response);
      expect(compareOpenApi(before, after)).toEqual([]);
      const changed = withRefs({ ...response, content: {} });
      expect(has(compareOpenApi(before, changed), 'breaking', 'mediaType.removed')).toBe(true);
    });

    it('is deterministic and orders findings the same way every time', () => {
      const mutate = (d: Doc) => {
        delete d.paths['/things/{id}'];
        create(d).required = ['name', 'kind'];
        d.info.version = '2';
      };
      expect(classify(mutate)).toEqual(classify(mutate));
    });
  });
});

describe('evaluate(): the decision of the check', () => {
  it('passes when the baseline equals the generated document', () => {
    const result = evaluate({ committed: baseDoc(), generated: baseDoc() });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('matches');
  });

  it('fails when the committed baseline is stale, even for an additive difference', () => {
    const generated = baseDoc();
    thing(generated).properties.extra = { type: 'string' };
    const result = evaluate({ committed: baseDoc(), generated });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('openapi:generate');
    expect(result.lines.join('\n')).toContain('[additive] property.added');
  });

  it('with a base revision: additive passes, breaking fails, and --allow-breaking is an explicit exception', () => {
    const additive = baseDoc();
    thing(additive).properties.extra = { type: 'string' };
    const ok = evaluate({ committed: additive, generated: additive, base: baseDoc() });
    expect(ok.exitCode).toBe(0);
    expect(ok.lines.join('\n')).toContain('0 breaking, 1 additive');

    const breaking = baseDoc();
    delete breaking.paths['/things/{id}'];
    const refused = evaluate({ committed: breaking, generated: breaking, base: baseDoc() });
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join('\n')).toContain('[BREAKING] path.removed');
    const allowed = evaluate({
      committed: breaking,
      generated: breaking,
      base: baseDoc(),
      allowBreaking: true,
    });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.lines.join('\n')).toContain('ALLOWED');
  });

  it('still fails for a stale baseline when breaking changes are allowed', () => {
    const generated = baseDoc();
    delete generated.paths['/things/{id}'];
    const result = evaluate({
      committed: baseDoc(),
      generated,
      base: baseDoc(),
      allowBreaking: true,
    });
    expect(result.exitCode).toBe(1);
  });
});

/**
 * WS1 hardening: the four false negatives found in the verification review, each reproduced here.
 * The tool fails closed: what it cannot analyse is `unclassified` (breaking) or an `error`.
 */
describe('fail-closed classification (WS1 hardening)', () => {
  /** A document whose only use of schema `A` is through an unmodelled keyword. */
  const reachedThrough = (keyword: 'oneOf' | 'allOf' | 'not' | 'if'): Doc => {
    const target = { $ref: '#/components/schemas/A' };
    return {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      [keyword]: keyword === 'not' || keyword === 'if' ? target : [target],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: { A: { type: 'object', properties: { name: { type: 'string' } } } },
      },
    };
  };

  describe('1. schemas referenced only through unmodelled keywords', () => {
    for (const keyword of ['oneOf', 'allOf', 'not', 'if'] as const) {
      it(`detects a change in a schema used only through ${keyword}`, () => {
        const before = reachedThrough(keyword);
        const after = reachedThrough(keyword);
        expect(compareOpenApi(before, after)).toEqual([]);
        after.components.schemas.A.properties.name.type = 'integer';
        const findings = compareOpenApi(before, after);
        const hit = findings.find(
          (f) => f.code === 'unclassified' && f.path.endsWith(`.${keyword}`),
        );
        expect(hit, formatFindings(findings).join('\n')).toBeDefined();
        expect(hit!.severity).toBe('breaking');
      });
    }

    it('detects a change deeper in the reference chain (a schema referenced by a schema referenced through allOf)', () => {
      const deep = (type: string) => {
        const d = reachedThrough('allOf');
        d.components.schemas.A.properties.deep = { $ref: '#/components/schemas/Deep' };
        d.components.schemas.Deep = { type: 'object', properties: { n: { type } } };
        return d;
      };
      expect(compareOpenApi(deep('string'), deep('string'))).toEqual([]);
      const findings = compareOpenApi(deep('string'), deep('integer'));
      expect(has(findings, 'breaking', 'unclassified'), formatFindings(findings).join('\n')).toBe(
        true,
      );
    });

    it('does not report an unchanged schema behind an unmodelled keyword, including a recursive one', () => {
      const recursive = () => {
        const d = reachedThrough('oneOf');
        d.components.schemas.A.properties.self = { $ref: '#/components/schemas/A' };
        return d;
      };
      expect(compareOpenApi(recursive(), recursive())).toEqual([]);
    });

    it('keeps a change in the generator-style $defs form visible behind an unmodelled keyword', () => {
      const withDefs = (type: string) => {
        const d = reachedThrough('oneOf');
        d.components.schemas.A = {
          $ref: '#/$defs/A',
          $defs: { A: { type: 'object', properties: { name: { type } } } },
        };
        return d;
      };
      expect(compareOpenApi(withDefs('string'), withDefs('string'))).toEqual([]);
      expect(
        has(compareOpenApi(withDefs('string'), withDefs('integer')), 'breaking', 'unclassified'),
      ).toBe(true);
    });
  });

  describe('2. unmodelled keys of parameters, bodies, responses, media types and headers', () => {
    const cases: [string, (d: Doc) => void][] = [
      ['a parameter style', (d) => (okGet(d).parameters[1].style = 'pipeDelimited')],
      ['a parameter explode', (d) => (okGet(d).parameters[1].explode = false)],
      ['a parameter allowEmptyValue', (d) => (okGet(d).parameters[1].allowEmptyValue = true)],
      ['a parameter content form', (d) => (okGet(d).parameters[1].content = { 'text/plain': {} })],
      ['an unknown parameter key', (d) => (okGet(d).parameters[1]['x-unit'] = 'ms')],
      [
        'a request body unknown key',
        (d) => (d.paths['/things'].post.requestBody['x-sensitive'] = true),
      ],
      [
        'a media type encoding',
        (d) =>
          (d.paths['/things'].post.requestBody.content['application/json'].encoding = { a: {} }),
      ],
      [
        'a response links',
        (d) => (okGet(d).responses['200'].links = { next: { operationId: 'x' } }),
      ],
      ['a response unknown key', (d) => (okGet(d).responses['200']['x-cache'] = 'no')],
      [
        'a response header style',
        (d) => (okGet(d).responses['200'].headers['RateLimit-Limit'].style = 'simple'),
      ],
      [
        'a response header unknown key',
        (d) => (okGet(d).responses['200'].headers['RateLimit-Limit']['x-unit'] = 's'),
      ],
    ];
    for (const [name, mutate] of cases) {
      it(`reports ${name} as unclassified and breaking`, () => {
        const findings = classify(mutate);
        expect(has(findings, 'breaking', 'unclassified'), formatFindings(findings).join('\n')).toBe(
          true,
        );
      });
    }

    it('detects a referenced object changing behind an unmodelled key', () => {
      const withLink = (operationId: string) => {
        const d = baseDoc();
        d.components.links = { Next: { operationId } };
        okGet(d).responses['200'].links = { next: { $ref: '#/components/links/Next' } };
        return d;
      };
      expect(compareOpenApi(withLink('a'), withLink('a'))).toEqual([]);
      expect(has(compareOpenApi(withLink('a'), withLink('b')), 'breaking', 'unclassified')).toBe(
        true,
      );
    });

    it('keeps documentation-only keys informational, and models header requiredness by direction', () => {
      const docs = classify((d) => {
        okGet(d).parameters[1].description = 'Filter by status';
        d.paths['/things'].post.requestBody.description = 'The new thing';
        d.paths['/things'].post.requestBody.content['application/json'].example = { name: 'x' };
        okGet(d).responses['200'].description = 'A page of things';
        okGet(d).responses['200'].headers['RateLimit-Limit'].description = 'Requests allowed';
      });
      expect(docs.length).toBeGreaterThan(0);
      expect(
        docs.every((f) => f.severity === 'info'),
        formatFindings(docs).join('\n'),
      ).toBe(true);
      const guaranteed = baseDoc();
      okGet(guaranteed).responses['200'].headers['RateLimit-Limit'].required = true;
      expect(
        has(compareOpenApi(guaranteed, baseDoc()), 'breaking', 'header.required.removed'),
      ).toBe(true);
      expect(has(compareOpenApi(baseDoc(), guaranteed), 'additive', 'header.required.added')).toBe(
        true,
      );
    });
  });

  describe('3. unresolved references', () => {
    const positions: [string, (d: Doc, ref: string) => void][] = [
      ['a parameter', (d, ref) => okGet(d).parameters.push({ $ref: ref })],
      ['a request body', (d, ref) => (d.paths['/things'].post.requestBody = { $ref: ref })],
      ['a response', (d, ref) => (okGet(d).responses['404'] = { $ref: ref })],
      ['a response header', (d, ref) => (okGet(d).responses['200'].headers.Broken = { $ref: ref })],
      ['a schema', (d, ref) => (thing(d).properties.parent = { $ref: ref })],
    ];
    for (const [name, place] of positions) {
      it(`reports an unresolved reference in ${name} as an error, never as equal`, () => {
        const broken = (ref: string) => {
          const d = baseDoc();
          place(d, ref);
          return d;
        };
        // Different broken references on the two sides: an error for each side.
        const different = compareOpenApi(
          broken('#/components/x/One'),
          broken('#/components/x/Two'),
        );
        expect(hasErrors(different), formatFindings(different).join('\n')).toBe(true);
        expect(different.filter((f) => f.code === 'ref.unresolved').length).toBeGreaterThanOrEqual(
          2,
        );
        // The very same broken reference on both sides is still an error: it is not "unchanged".
        const identical = compareOpenApi(
          broken('#/components/x/One'),
          broken('#/components/x/One'),
        );
        expect(hasErrors(identical), formatFindings(identical).join('\n')).toBe(true);
        // A broken reference appearing, and one disappearing, stop the check (exit 2) as well.
        for (const [committed, generated] of [
          [baseDoc(), broken('#/components/x/One')],
          [broken('#/components/x/One'), baseDoc()],
        ]) {
          expect(evaluate({ committed, generated }).exitCode).toBe(2);
          expect(
            evaluate({
              committed: baseDoc(),
              generated: baseDoc(),
              base: broken('#/components/x/One'),
            }).exitCode,
          ).toBe(2);
        }
      });
    }

    it('never waives an unresolved reference with --allow-breaking', () => {
      const broken = baseDoc();
      okGet(broken).parameters.push({ $ref: '#/components/parameters/Gone' });
      for (const allowBreaking of [false, true]) {
        const result = evaluate({
          committed: broken,
          generated: broken,
          base: baseDoc(),
          allowBreaking,
        });
        expect(result.exitCode, result.lines.join('\n')).toBe(2);
        expect(result.lines.join('\n')).toContain('unresolved reference');
      }
    });
  });

  describe('4. input validation', () => {
    const invalid: [string, unknown][] = [
      ['null', null],
      ['an array', []],
      ['a string', 'openapi'],
      ['a number', 3],
      ['an empty object', {}],
      ['an OpenAPI 2 document', { swagger: '2.0', openapi: '2.0', paths: {} }],
      ['a document without paths', { openapi: '3.1.0', info: {} }],
      ['a document whose paths is an array', { openapi: '3.1.0', paths: [] }],
      ['a numeric openapi version', { openapi: 3.1, paths: {} }],
    ];
    for (const [name, document] of invalid) {
      it(`rejects ${name} in any of the three positions, with and without --allow-breaking`, () => {
        expect(validateOpenApiDocument(document, 'x').length).toBeGreaterThan(0);
        for (const allowBreaking of [false, true]) {
          const asBase = evaluate({
            committed: baseDoc(),
            generated: baseDoc(),
            base: document,
            allowBreaking,
          });
          const asCommitted = evaluate({
            committed: document,
            generated: baseDoc(),
            allowBreaking,
          });
          const asGenerated = evaluate({
            committed: baseDoc(),
            generated: document,
            allowBreaking,
          });
          for (const result of [asBase, asCommitted, asGenerated]) {
            expect(
              result.exitCode,
              `${name} allow=${allowBreaking}: ${result.lines.join(' | ')}`,
            ).toBe(2);
          }
        }
      });
    }

    it('rejects the reported case: a null base with --allow-breaking (it used to pass)', () => {
      const result = evaluate({
        committed: baseDoc(),
        generated: baseDoc(),
        base: null,
        allowBreaking: true,
      });
      expect(result.exitCode).toBe(2);
      expect(result.lines.join('\n')).toContain('not a JSON object');
    });

    it('accepts a valid 3.x document, and checks references anywhere in it', () => {
      expect(validateOpenApiDocument(baseDoc(), 'x')).toEqual([]);
      for (const version of ['3.0.3', '3.1.0', '3.2.0']) {
        expect(validateOpenApiDocument({ openapi: version, paths: {} }, 'x')).toEqual([]);
      }
      const unreferenced = baseDoc();
      unreferenced.components.schemas.Orphan = { $ref: '#/components/schemas/Missing' };
      expect(validateOpenApiDocument(unreferenced, 'x').join()).toContain('unresolved reference');
      const external = baseDoc();
      external.components.schemas.Remote = { $ref: 'https://example.com/schema.json' };
      expect(validateOpenApiDocument(external, 'x').join()).toContain('external reference');
      const outsideScope = baseDoc();
      outsideScope.components.schemas.Lost = { $ref: '#/$defs/Nothing' };
      expect(validateOpenApiDocument(outsideScope, 'x').join()).toContain('unresolved reference');
    });

    it('still fails a stale baseline with --allow-breaking, and waives only reviewed breaking findings', () => {
      const generated = baseDoc();
      delete generated.paths['/things/{id}'];
      const stale = evaluate({
        committed: baseDoc(),
        generated,
        base: baseDoc(),
        allowBreaking: true,
      });
      expect(stale.exitCode).toBe(1);
      const waived = evaluate({
        committed: generated,
        generated,
        base: baseDoc(),
        allowBreaking: true,
      });
      expect(waived.exitCode).toBe(0);
      expect(evaluate({ committed: generated, generated, base: baseDoc() }).exitCode).toBe(1);
    });
  });
});

/** The command line, as CI and `pnpm verify` run it (a real process). */
describe('openapi:check command line', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const baseline = () =>
    JSON.parse(
      readFileSync(new URL('../../../docs/openapi/public-v1.json', import.meta.url), 'utf8'),
    );
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/check-openapi.ts', ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const withFile = (content: string, work: (file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-check-'));
    try {
      const file = join(dir, 'base.json');
      writeFileSync(file, content);
      work(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 for the committed baseline, alone and against an identical base file', () => {
    expect(run().status).toBe(0);
    withFile(JSON.stringify(baseline()), (file) => expect(run('--base-file', file).status).toBe(0));
  }, 240_000);

  it('exits 1 for a breaking change and 0 only when it is explicitly allowed', () => {
    const base = baseline();
    base.paths['/removed-path'] = base.paths['/customers'];
    withFile(JSON.stringify(base), (file) => {
      const refused = run('--base-file', file);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain('[BREAKING] path.removed');
      expect(run('--base-file', file, '--allow-breaking').status).toBe(0);
    });
  }, 240_000);

  // Each case starts a real process (tsx + the contract builder), which is slow under the load of
  // a full parallel run: keep the number of processes small and the timeout explicit. The complete
  // input matrix is covered in-process through evaluate() above.
  it('exits 2 for invalid input even with --allow-breaking (the dangerous combination)', () => {
    for (const content of ['null', '{}', 'not json', '']) {
      withFile(content, (file) => {
        const result = run('--base-file', file, '--allow-breaking');
        expect(
          result.status,
          `${JSON.stringify(content)}
${result.output}`,
        ).toBe(2);
      });
    }
    withFile('null', (file) => expect(run('--base-file', file).status).toBe(2));
    const broken = baseline();
    broken.paths['/customers'].get.parameters.push({ $ref: '#/components/parameters/Gone' });
    withFile(JSON.stringify(broken), (file) => {
      expect(run('--base-file', file, '--allow-breaking').status).toBe(2);
    });
  }, 240_000);

  it('exits 2 for bad arguments, a missing file, an unknown revision and both bases at once', () => {
    for (const args of [
      ['--bogus'],
      ['--base-file'],
      ['--base-file', join(tmpdir(), 'does-not-exist-openapi.json'), '--allow-breaking'],
      ['--base-ref', 'no-such-revision-xyz', '--allow-breaking'],
      ['--base-ref', 'HEAD', '--base-file', 'x.json'],
    ]) {
      const result = run(...args);
      expect(
        result.status,
        `${args.join(' ')}
${result.output}`,
      ).toBe(2);
    }
  }, 240_000);
});

describe('the real contract', () => {
  const committed = () =>
    JSON.parse(
      readFileSync(new URL('../../../docs/openapi/public-v1.json', import.meta.url), 'utf8'),
    );
  const generated = () => JSON.parse(JSON.stringify(buildOpenApiDocument()));

  it('agrees with the drift test: committed baseline and generated document are identical', () => {
    expect(compareOpenApi(committed(), generated())).toEqual([]);
    expect(
      evaluate({ committed: committed(), generated: generated(), base: committed() }).exitCode,
    ).toBe(0);
  });

  it('detects realistic breaking changes in the real document', () => {
    const cases: [string, (d: Doc) => void, string][] = [
      ['removing a public path', (d) => delete d.paths['/customers'], 'path.removed'],
      ['removing a method', (d) => delete d.paths['/customers'].post, 'method.removed'],
      [
        'changing a required scope',
        (d) => (d.paths['/customers'].get['x-required-scope'] = 'invoices:read'),
        'scope.changed',
      ],
      [
        'removing a response code',
        (d) => delete d.paths['/customers'].get.responses['401'],
        'response.removed',
      ],
      [
        'making a query parameter required',
        (d) => (d.paths['/customers'].get.parameters[0].required = true),
        'parameter.required.added',
      ],
      [
        'narrowing the status filter',
        (d) =>
          (d.paths['/customers'].get.parameters.find((p: Doc) => p.name === 'status').schema.enum =
            ['ACTIVE']),
        'enum.narrowed',
      ],
      [
        'removing a field from the customer',
        (d) => delete d.components.schemas.Customer.$defs.Customer.properties.id,
        'property.removed',
      ],
    ];
    for (const [name, mutate, code] of cases) {
      const after = generated();
      mutate(after);
      const findings = compareOpenApi(committed(), after);
      expect(
        has(findings, 'breaking', code),
        `${name}: ${formatFindings(findings).join('\n')}`,
      ).toBe(true);
    }
  });

  it('accepts realistic additive changes in the real document', () => {
    const after = generated();
    after.paths['/customers'].get.parameters.push({
      name: 'q',
      in: 'query',
      schema: { type: 'string' },
    });
    after.components.schemas.Customer.$defs.Customer.properties.nickname = { type: 'string' };
    after.paths['/customers'].get.responses['503'] = { description: 'Unavailable' };
    const findings = compareOpenApi(committed(), after);
    expect(findings.length).toBeGreaterThan(0);
    expect(hasBreaking(findings), formatFindings(findings).join('\n')).toBe(false);
  });
});
