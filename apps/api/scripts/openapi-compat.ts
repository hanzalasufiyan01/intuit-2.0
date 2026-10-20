/**
 * OpenAPI compatibility classifier (ADR 0011 Step 7, WS1).
 *
 * Compares two OpenAPI 3.1 documents (a baseline and a candidate) and classifies every difference
 * it understands as `breaking`, `additive` or `info`, from the point of view of an existing API
 * client. It is a deliberately conservative, rule-based tool and NOT an exhaustive compatibility
 * proof: anything it does not understand is reported as `unclassified` and counts as breaking, so
 * that an unreviewed change never passes silently. The rules and limits are documented in
 * `docs/openapi-compatibility.md`.
 *
 *
 * `error` is not a compatibility verdict: it means the input cannot be analysed safely (an
 * unresolved or external `$ref`, a document that is not OpenAPI 3.x). It is never waivable.
 *
 * Direction matters. Parameters and request bodies are `request` positions (the client sends
 * them: tightening breaks clients); response bodies and headers are `response` positions (the
 * client reads them: losing information breaks clients). Pure functions, no I/O.
 */

export type Severity = 'breaking' | 'additive' | 'info' | 'error';

export interface Finding {
  severity: Severity;
  /** A stable machine-readable code, e.g. `property.removed`. */
  code: string;
  /** Where in the document, e.g. `paths./customers.get.responses.200`. */
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;
type Direction = 'request' | 'response';

/** Keys of a parameter object that the comparison models (the rest is `unclassified`). */
const PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'in',
  'required',
  'schema',
  'description',
  'example',
  'examples',
  'deprecated',
]);
const REQUEST_BODY_KEYS: ReadonlySet<string> = new Set(['required', 'content', 'description']);
const RESPONSE_KEYS: ReadonlySet<string> = new Set(['description', 'headers', 'content']);
const MEDIA_TYPE_KEYS: ReadonlySet<string> = new Set(['schema', 'example', 'examples']);
const HEADER_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'required',
  'description',
  'deprecated',
  'example',
  'examples',
]);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** JSON with object keys sorted, so that equal values give equal strings. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Resolves a local reference. `#/$defs/...` resolves against `scope` (the nearest enclosing schema
 * that carries `$defs`, which is how the generator emits shared schemas), every other `#/...`
 * pointer against the document root. Undefined when it cannot be resolved (including external
 * references, which this tool does not follow).
 */
function resolveRef(doc: Obj, ref: string, scope: Obj | undefined): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let target: unknown = parts[0] === '$defs' && scope ? scope : doc;
  for (const part of parts) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    target = isObj(target) ? target[key] : undefined;
  }
  return target;
}

/**
 * The value with every `$ref` replaced by what it points to (recursively), so that two values are
 * equal only if they AND everything they reference are equal. Cycles and unresolved references
 * become explicit markers (an unresolved reference carries its text, so two different broken
 * references are never equal). `$defs` blocks are not emitted: they matter only where referenced.
 */
function expandRefs(doc: Obj, node: unknown, scope: Obj | undefined, stack: unknown[]): unknown {
  if (Array.isArray(node)) return node.map((n) => expandRefs(doc, n, scope, stack));
  if (!isObj(node)) return node;
  const inScope = isObj(node.$defs) ? node : scope;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs' || key === '$ref') continue;
    out[key] = expandRefs(doc, value, inScope, stack);
  }
  if (typeof node.$ref === 'string') {
    const target = resolveRef(doc, node.$ref, inScope);
    if (target === undefined) {
      out.$unresolved = node.$ref;
    } else if (stack.includes(target)) {
      out.$cycle = true;
    } else {
      out.$resolved = expandRefs(doc, target, inScope, [...stack, target]);
    }
  }
  return out;
}

/**
 * Checks that a document can be analysed: an object with an `openapi` 3.x string and a `paths`
 * object, in which every `$ref` is a local reference that resolves. Returns the problems (empty
 * when the document is usable).
 */
export function validateOpenApiDocument(doc: unknown, label: string): string[] {
  if (!isObj(doc)) {
    return [`${label}: not a JSON object (an OpenAPI document is required).`];
  }
  const problems: string[] = [];
  if (typeof doc.openapi !== 'string' || !/^3\.\d+(\.\d+)?([-+].*)?$/.test(doc.openapi)) {
    problems.push(
      `${label}: "openapi" must be a string for OpenAPI 3.x (found ${JSON.stringify(doc.openapi ?? null)}).`,
    );
  }
  if (!isObj(doc.paths)) problems.push(`${label}: "paths" must be an object.`);
  const walk = (node: unknown, scope: Obj | undefined, pointer: string) => {
    if (problems.length >= 20) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, scope, `${pointer}/${i}`));
      return;
    }
    if (!isObj(node)) return;
    const inScope = isObj(node.$defs) ? node : scope;
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#/')) {
        problems.push(
          `${label}: external reference "${node.$ref}" at ${pointer || '/'} is not supported.`,
        );
      } else if (resolveRef(doc, node.$ref, inScope) === undefined) {
        problems.push(`${label}: unresolved reference "${node.$ref}" at ${pointer || '/'}.`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, inScope, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  };
  walk(doc, undefined, '');
  return problems;
}

class Comparison {
  readonly findings: Finding[] = [];
  /** Pairs of `$ref`s already compared (per direction): keeps recursive schemas finite. */
  private readonly seen = new Set<string>();
  /** The `$defs` scopes (before, after) of the schema being compared. */
  private scope: { b: Obj | undefined; a: Obj | undefined } = { b: undefined, a: undefined };
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;

  private idOf(scope: Obj | undefined): number {
    if (!scope) return 0;
    const known = this.ids.get(scope);
    if (known !== undefined) return known;
    const id = this.nextId;
    this.nextId += 1;
    this.ids.set(scope, id);
    return id;
  }

  constructor(
    private readonly before: Obj,
    private readonly after: Obj,
  ) {}

  add(severity: Severity, code: string, path: string, message: string) {
    this.findings.push({ severity, code, path, message });
  }

  // ------------------------------------------------------------------ references

  /**
   * Follows local `$ref`s. A schema may carry its own `$defs` (the generator emits
   * `{ "$ref": "#/$defs/X", "$defs": { ... } }`); a `#/$defs/...` reference resolves against the
   * nearest enclosing schema that has `$defs` (`scope`), every other local reference against the
   * document root. Returns the node, the first reference followed and the scope in force.
   */
  private deref(
    doc: Obj,
    node: unknown,
    scope?: Obj,
  ): { node: unknown; ref: string | null; broken: boolean; scope: Obj | undefined } {
    let current = node;
    let first: string | null = null;
    let inScope = scope;
    for (let depth = 0; depth < 20; depth += 1) {
      if (isObj(current) && isObj(current.$defs)) inScope = current;
      if (!isObj(current) || typeof current.$ref !== 'string') {
        return { node: current, ref: first, broken: false, scope: inScope };
      }
      const ref = current.$ref;
      first ??= ref;
      const target = resolveRef(doc, ref, inScope);
      if (target === undefined) return { node: current, ref: first, broken: true, scope: inScope };
      current = target;
    }
    return { node: current, ref: first, broken: true, scope: inScope };
  }

  /** Equal including everything the two values reference (see `expandRefs`). */
  private sameExpanded(b: unknown, a: unknown, sb?: Obj, sa?: Obj): boolean {
    return (
      canonical(expandRefs(this.before, b, sb, [])) === canonical(expandRefs(this.after, a, sa, []))
    );
  }

  /**
   * Keys this tool does not model on an object: a change (including a change in anything the value
   * references) is `unclassified` and counts as breaking. Fail closed.
   */
  private unmodelled(b: Obj, a: Obj, modelled: ReadonlySet<string>, path: string, what: string) {
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (modelled.has(key)) continue;
      if (!this.sameExpanded(b[key], a[key], this.scope.b, this.scope.a)) {
        this.add(
          'breaking',
          'unclassified',
          `${path}.${key}`,
          `${what} key "${key}" changed (or something it references changed) and is not modelled; review it.`,
        );
      }
    }
  }

  private docs(b: Obj, a: Obj, keys: readonly string[], path: string) {
    if (keys.some((k) => !same(b[k], a[k]))) {
      this.add('info', 'docs.changed', path, 'Description, example or deprecation notes changed.');
    }
  }

  /** An object that may be a `$ref` (parameter, request body, response, header). */
  private objectAt(doc: Obj, raw: unknown, path: string): Obj | undefined {
    if (raw === undefined) return undefined;
    const { node, broken, ref } = this.deref(doc, raw);
    if (broken) {
      this.add('error', 'ref.unresolved', path, `A reference cannot be resolved (${String(ref)}).`);
      return {};
    }
    return asObj(node);
  }

  // ------------------------------------------------------------------ document

  compareDocuments() {
    const b = this.before;
    const a = this.after;
    if (!same(b.openapi, a.openapi)) {
      this.add(
        'info',
        'openapi.version.changed',
        'openapi',
        `${String(b.openapi)} -> ${String(a.openapi)}`,
      );
    }
    if (!same(asObj(b.info).version, asObj(a.info).version)) {
      this.add('info', 'info.version.changed', 'info.version', 'The API document version changed.');
    }
    if (!same(b.servers, a.servers)) {
      this.add('breaking', 'servers.changed', 'servers', 'The server URLs changed.');
    }
    if (!same(b.security, a.security)) {
      this.add(
        'breaking',
        'security.changed',
        'security',
        'The document-level security requirement changed.',
      );
    }
    this.compareSecuritySchemes();
    this.comparePaths();
    this.compareComponentLists();
    // Anything at the top level that this tool does not model: equal, or it needs a human.
    const modelled = new Set([
      'openapi',
      'info',
      'servers',
      'security',
      'tags',
      'paths',
      'components',
    ]);
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (modelled.has(key)) continue;
      if (!this.sameExpanded(b[key], a[key])) {
        this.add(
          'breaking',
          'unclassified',
          key,
          `Top-level "${key}" changed and is not modelled; review it.`,
        );
      }
    }
    if (!same(b.tags, a.tags)) this.add('info', 'tags.changed', 'tags', 'The tag list changed.');
    const bc = asObj(b.components);
    const ac = asObj(a.components);
    for (const key of new Set([...Object.keys(bc), ...Object.keys(ac)])) {
      if (['schemas', 'securitySchemes'].includes(key)) continue;
      if (!same(bc[key], ac[key])) {
        this.add(
          'breaking',
          'unclassified',
          `components.${key}`,
          `components.${key} changed and is not modelled; review it.`,
        );
      }
    }
  }

  private compareSecuritySchemes() {
    const b = asObj(asObj(this.before.components).securitySchemes);
    const a = asObj(asObj(this.after.components).securitySchemes);
    for (const name of Object.keys(b)) {
      if (!(name in a)) {
        this.add(
          'breaking',
          'securityScheme.removed',
          `components.securitySchemes.${name}`,
          'A security scheme was removed.',
        );
      } else if (!same(b[name], a[name])) {
        this.add(
          'breaking',
          'securityScheme.changed',
          `components.securitySchemes.${name}`,
          'A security scheme changed.',
        );
      }
    }
    for (const name of Object.keys(a)) {
      if (!(name in b)) {
        this.add(
          'additive',
          'securityScheme.added',
          `components.securitySchemes.${name}`,
          'A security scheme was added.',
        );
      }
    }
  }

  private compareComponentLists() {
    const b = asObj(asObj(this.before.components).schemas);
    const a = asObj(asObj(this.after.components).schemas);
    for (const name of Object.keys(b)) {
      if (!(name in a)) {
        this.add(
          'info',
          'schema.removed',
          `components.schemas.${name}`,
          'A named schema was removed (its uses are compared where they occur).',
        );
      }
    }
    for (const name of Object.keys(a)) {
      if (!(name in b))
        this.add('info', 'schema.added', `components.schemas.${name}`, 'A named schema was added.');
    }
  }

  // ------------------------------------------------------------------ paths

  private comparePaths() {
    const b = asObj(this.before.paths);
    const a = asObj(this.after.paths);
    for (const path of Object.keys(b)) {
      if (!(path in a)) {
        this.add('breaking', 'path.removed', `paths.${path}`, `Path ${path} was removed.`);
        continue;
      }
      this.comparePathItem(path, asObj(b[path]), asObj(a[path]));
    }
    for (const path of Object.keys(a)) {
      if (!(path in b))
        this.add('additive', 'path.added', `paths.${path}`, `Path ${path} was added.`);
    }
  }

  private comparePathItem(path: string, b: Obj, a: Obj) {
    const base = `paths.${path}`;
    for (const method of METHODS) {
      if (method in b && !(method in a)) {
        this.add(
          'breaking',
          'method.removed',
          `${base}.${method}`,
          `${method.toUpperCase()} ${path} was removed.`,
        );
      } else if (!(method in b) && method in a) {
        this.add(
          'additive',
          'method.added',
          `${base}.${method}`,
          `${method.toUpperCase()} ${path} was added.`,
        );
      } else if (method in b && method in a) {
        this.compareOperation(
          `${base}.${method}`,
          asObj(b[method]),
          asObj(a[method]),
          asArray(b.parameters),
          asArray(a.parameters),
        );
      }
    }
    const modelled = new Set<string>([...METHODS, 'parameters', 'summary', 'description']);
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (modelled.has(key)) continue;
      if (!this.sameExpanded(b[key], a[key])) {
        this.add(
          'breaking',
          'unclassified',
          `${base}.${key}`,
          `Path item key "${key}" changed and is not modelled; review it.`,
        );
      }
    }
  }

  private compareOperation(
    path: string,
    b: Obj,
    a: Obj,
    bPathParameters: unknown[],
    aPathParameters: unknown[],
  ) {
    if (!same(b.operationId, a.operationId)) {
      this.add(
        'breaking',
        'operationId.changed',
        `${path}.operationId`,
        'The operationId changed (generated clients depend on it).',
      );
    }
    if (!same(b.security, a.security)) {
      this.add(
        'breaking',
        'security.changed',
        `${path}.security`,
        'The operation security requirement changed.',
      );
    }
    const bScope = b['x-required-scope'];
    const aScope = a['x-required-scope'];
    if (!same(bScope, aScope)) {
      if (aScope === undefined) {
        this.add(
          'additive',
          'scope.removed',
          `${path}.x-required-scope`,
          'The required scope was removed (less restrictive).',
        );
      } else {
        this.add(
          'breaking',
          'scope.changed',
          `${path}.x-required-scope`,
          `The required scope changed: ${JSON.stringify(bScope ?? null)} -> ${JSON.stringify(aScope)}.`,
        );
      }
    }
    if (!b.deprecated && a.deprecated) {
      this.add(
        'info',
        'operation.deprecated',
        `${path}.deprecated`,
        'The operation was marked deprecated.',
      );
    }
    this.compareParameters(
      path,
      this.effectiveParameters(this.before, path, bPathParameters, asArray(b.parameters)),
      this.effectiveParameters(this.after, path, aPathParameters, asArray(a.parameters)),
    );
    this.compareRequestBody(path, b.requestBody, a.requestBody);
    this.compareResponses(path, asObj(b.responses), asObj(a.responses));
    const modelled = new Set([
      'operationId',
      'security',
      'x-required-scope',
      'deprecated',
      'parameters',
      'requestBody',
      'responses',
      'tags',
      'summary',
      'description',
    ]);
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (modelled.has(key)) continue;
      if (!this.sameExpanded(b[key], a[key])) {
        this.add(
          'breaking',
          'unclassified',
          `${path}.${key}`,
          `Operation key "${key}" changed and is not modelled; review it.`,
        );
      }
    }
    if (
      !same(b.summary, a.summary) ||
      !same(b.description, a.description) ||
      !same(b.tags, a.tags)
    ) {
      this.add('info', 'docs.changed', path, 'Summary, description or tags changed.');
    }
  }

  // ------------------------------------------------------------------ parameters

  /** Path-level parameters overridden by operation-level ones (same name and location). */
  private effectiveParameters(
    doc: Obj,
    path: string,
    pathLevel: unknown[],
    operationLevel: unknown[],
  ) {
    const merged = new Map<string, Obj>();
    for (const raw of [...pathLevel, ...operationLevel]) {
      const parameter = this.objectAt(doc, raw, `${path}.parameters`);
      if (!parameter || Object.keys(parameter).length === 0) continue; // (error already reported)
      merged.set(`${String(parameter.in)}:${String(parameter.name)}`, parameter);
    }
    return merged;
  }

  private compareParameters(path: string, b: Map<string, Obj>, a: Map<string, Obj>) {
    for (const [key, before] of b) {
      const where = `${path}.parameters[${key}]`;
      const after = a.get(key);
      if (!after) {
        this.add('breaking', 'parameter.removed', where, `Parameter ${key} was removed.`);
        continue;
      }
      const wasRequired = before.required === true || before.in === 'path';
      const isRequired = after.required === true || after.in === 'path';
      if (!wasRequired && isRequired) {
        this.add(
          'breaking',
          'parameter.required.added',
          where,
          `Parameter ${key} became required.`,
        );
      } else if (wasRequired && !isRequired) {
        this.add(
          'additive',
          'parameter.required.removed',
          where,
          `Parameter ${key} became optional.`,
        );
      }
      this.compareSchema(before.schema, after.schema, `${where}.schema`, 'request');
      this.unmodelled(before, after, PARAMETER_KEYS, where, 'Parameter');
      this.docs(before, after, ['description', 'example', 'examples', 'deprecated'], where);
    }
    for (const [key, after] of a) {
      if (b.has(key)) continue;
      const where = `${path}.parameters[${key}]`;
      if (after.required === true || after.in === 'path') {
        this.add(
          'breaking',
          'parameter.required.added',
          where,
          `A required parameter ${key} was added.`,
        );
      } else {
        this.add('additive', 'parameter.added', where, `An optional parameter ${key} was added.`);
      }
    }
  }

  // ------------------------------------------------------------------ request body / responses

  private compareRequestBody(path: string, bRaw: unknown, aRaw: unknown) {
    const where = `${path}.requestBody`;
    const b = this.objectAt(this.before, bRaw, where);
    const a = this.objectAt(this.after, aRaw, where);
    if (!b && !a) return;
    if (b && !a) {
      this.add('breaking', 'requestBody.removed', where, 'The request body was removed.');
      return;
    }
    if (!b && a) {
      if (a.required === true) {
        this.add(
          'breaking',
          'requestBody.required.added',
          where,
          'A required request body was added.',
        );
      } else {
        this.add('additive', 'requestBody.added', where, 'An optional request body was added.');
      }
      return;
    }
    if (b!.required !== true && a!.required === true) {
      this.add(
        'breaking',
        'requestBody.required.added',
        where,
        'The request body became required.',
      );
    } else if (b!.required === true && a!.required !== true) {
      this.add(
        'additive',
        'requestBody.required.removed',
        where,
        'The request body became optional.',
      );
    }
    this.compareContent(where, asObj(b!.content), asObj(a!.content), 'request');
    this.unmodelled(b!, a!, REQUEST_BODY_KEYS, where, 'Request body');
    this.docs(b!, a!, ['description'], where);
  }

  private compareContent(where: string, b: Obj, a: Obj, direction: Direction) {
    for (const type of Object.keys(b)) {
      if (!(type in a)) {
        this.add(
          'breaking',
          'mediaType.removed',
          `${where}.content.${type}`,
          `Media type ${type} was removed.`,
        );
        continue;
      }
      const bm = asObj(b[type]);
      const am = asObj(a[type]);
      this.compareSchema(bm.schema, am.schema, `${where}.content.${type}.schema`, direction);
      this.unmodelled(bm, am, MEDIA_TYPE_KEYS, `${where}.content.${type}`, 'Media type');
      this.docs(bm, am, ['example', 'examples'], `${where}.content.${type}`);
    }
    for (const type of Object.keys(a)) {
      if (!(type in b))
        this.add(
          'additive',
          'mediaType.added',
          `${where}.content.${type}`,
          `Media type ${type} was added.`,
        );
    }
  }

  private compareResponses(path: string, b: Obj, a: Obj) {
    for (const code of Object.keys(b)) {
      const where = `${path}.responses.${code}`;
      if (!(code in a)) {
        this.add('breaking', 'response.removed', where, `Response ${code} was removed.`);
        continue;
      }
      const before = this.objectAt(this.before, b[code], where) ?? {};
      const after = this.objectAt(this.after, a[code], where) ?? {};
      const bh = asObj(before.headers);
      const ah = asObj(after.headers);
      for (const name of Object.keys(bh)) {
        if (!(name in ah)) {
          this.add(
            'breaking',
            'header.removed',
            `${where}.headers.${name}`,
            `Response header ${name} was removed.`,
          );
        } else {
          const hw = `${where}.headers.${name}`;
          const bhd = this.objectAt(this.before, bh[name], hw) ?? {};
          const ahd = this.objectAt(this.after, ah[name], hw) ?? {};
          this.compareSchema(bhd.schema, ahd.schema, `${hw}.schema`, 'response');
          if (bhd.required === true && ahd.required !== true) {
            this.add(
              'breaking',
              'header.required.removed',
              hw,
              `Header ${name} is no longer guaranteed.`,
            );
          } else if (bhd.required !== true && ahd.required === true) {
            this.add(
              'additive',
              'header.required.added',
              hw,
              `Header ${name} is now always present.`,
            );
          }
          this.unmodelled(bhd, ahd, HEADER_KEYS, hw, 'Response header');
          this.docs(bhd, ahd, ['description', 'deprecated', 'example', 'examples'], hw);
        }
      }
      for (const name of Object.keys(ah)) {
        if (!(name in bh))
          this.add(
            'additive',
            'header.added',
            `${where}.headers.${name}`,
            `Response header ${name} was added.`,
          );
      }
      this.compareContent(where, asObj(before.content), asObj(after.content), 'response');
      this.unmodelled(before, after, RESPONSE_KEYS, where, 'Response');
      this.docs(before, after, ['description'], where);
    }
    for (const code of Object.keys(a)) {
      if (!(code in b))
        this.add(
          'additive',
          'response.added',
          `${path}.responses.${code}`,
          `Response ${code} was added.`,
        );
    }
  }

  // ------------------------------------------------------------------ schemas

  compareSchema(bRaw: unknown, aRaw: unknown, path: string, direction: Direction) {
    if (bRaw === undefined && aRaw === undefined) return;
    if (bRaw === undefined || aRaw === undefined) {
      // A schema appeared or disappeared altogether.
      this.add('breaking', 'schema.presence.changed', path, 'A schema was added or removed.');
      return;
    }
    const b = this.deref(this.before, bRaw, this.scope.b);
    const a = this.deref(this.after, aRaw, this.scope.a);
    if (b.broken || a.broken) {
      // Never compared as "equal because both are broken": each broken side is its own error.
      if (b.broken)
        this.add(
          'error',
          'ref.unresolved',
          path,
          `A reference cannot be resolved in the baseline (${String(b.ref)}).`,
        );
      if (a.broken)
        this.add(
          'error',
          'ref.unresolved',
          path,
          `A reference cannot be resolved in the candidate (${String(a.ref)}).`,
        );
      return;
    }
    if (b.ref !== null && a.ref !== null) {
      const key = `${direction}|${this.idOf(this.scope.b)}|${b.ref}|${this.idOf(this.scope.a)}|${a.ref}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const bs = b.node;
    const as = a.node;
    if (!isObj(bs) || !isObj(as)) {
      if (!same(bs, as))
        this.add('breaking', 'schema.changed', path, 'A boolean or non-object schema changed.');
      return;
    }
    const saved = this.scope;
    this.scope = { b: b.scope, a: a.scope };
    try {
      this.compareSchemaNodes(bs, as, path, direction);
    } finally {
      this.scope = saved;
    }
  }

  private compareSchemaNodes(bs: Obj, as: Obj, path: string, direction: Direction) {
    this.compareTypes(bs, as, path, direction);
    this.compareEnums(bs, as, path, direction);
    this.compareProperties(bs, as, path, direction);
    this.compareRequired(bs, as, path, direction);
    this.compareAnyOf(bs, as, path, direction);
    if ('items' in bs || 'items' in as)
      this.compareSchema(bs.items, as.items, `${path}.items`, direction);
    this.compareAdditionalProperties(bs, as, path, direction);
    this.compareBounds(bs, as, path, direction);
    this.compareStringRules(bs, as, path, direction);
    if (!same(bs.default, as.default)) {
      this.add(
        direction === 'request' ? 'breaking' : 'info',
        'default.changed',
        `${path}.default`,
        'The default value changed.',
      );
    }
    const modelled = new Set([
      'type',
      'enum',
      'const',
      'properties',
      'required',
      'anyOf',
      'items',
      'additionalProperties',
      'default',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'format',
      'pattern',
      'description',
      'title',
      'example',
      'examples',
      'deprecated',
      'readOnly',
      'writeOnly',
      '$defs',
      '$schema',
    ]);
    for (const key of new Set([...Object.keys(bs), ...Object.keys(as)])) {
      if (modelled.has(key)) continue;
      if (!this.sameExpanded(bs[key], as[key], this.scope.b, this.scope.a)) {
        this.add(
          'breaking',
          'unclassified',
          `${path}.${key}`,
          `Schema keyword "${key}" changed and is not modelled; review it.`,
        );
      }
    }
    if (['description', 'title', 'example', 'examples'].some((k) => !same(bs[k], as[k]))) {
      this.add('info', 'docs.changed', path, 'Description, title or example changed.');
    }
    if (!same(bs.readOnly, as.readOnly) || !same(bs.writeOnly, as.writeOnly)) {
      this.add('breaking', 'access.changed', path, 'readOnly or writeOnly changed.');
    }
  }

  private typeSet(schema: Obj): Set<string> | null {
    const t = schema.type;
    if (typeof t === 'string') return new Set([t]);
    if (Array.isArray(t)) return new Set(t.map(String));
    return null; // no type keyword: any value
  }

  private compareTypes(b: Obj, a: Obj, path: string, direction: Direction) {
    const before = this.typeSet(b);
    const after = this.typeSet(a);
    if (before === null && after === null) return;
    const contains = (outer: Set<string> | null, inner: Set<string> | null) => {
      if (outer === null) return true;
      if (inner === null) return false;
      return [...inner].every((t) => outer.has(t));
    };
    const widened = contains(after, before);
    const narrowed = contains(before, after);
    if (widened && narrowed) return;
    const text = `${[...(before ?? ['any'])].join('|')} -> ${[...(after ?? ['any'])].join('|')}`;
    // A request may be accepted more widely; a response may only get narrower.
    const compatible = direction === 'request' ? widened : narrowed;
    this.add(
      compatible ? 'additive' : 'breaking',
      compatible ? 'type.compatible' : 'type.changed',
      `${path}.type`,
      `The type changed: ${text}.`,
    );
  }

  private enumValues(schema: Obj): Set<string> | null {
    if (Array.isArray(schema.enum)) return new Set(schema.enum.map(canonical));
    if ('const' in schema) return new Set([canonical(schema.const)]);
    return null;
  }

  private compareEnums(b: Obj, a: Obj, path: string, direction: Direction) {
    const before = this.enumValues(b);
    const after = this.enumValues(a);
    if (before === null && after === null) return;
    if (before === null && after !== null) {
      this.add(
        direction === 'request' ? 'breaking' : 'additive',
        'enum.added',
        `${path}.enum`,
        'An enum constraint was added.',
      );
      return;
    }
    if (before !== null && after === null) {
      this.add('additive', 'enum.removed', `${path}.enum`, 'The enum constraint was removed.');
      return;
    }
    const removed = [...before!].filter((v) => !after!.has(v));
    const added = [...after!].filter((v) => !before!.has(v));
    if (removed.length > 0) {
      this.add(
        'breaking',
        'enum.narrowed',
        `${path}.enum`,
        `Enum values were removed: ${removed.join(', ')}.`,
      );
    }
    if (added.length > 0) {
      this.add(
        'additive',
        'enum.widened',
        `${path}.enum`,
        `Enum values were added: ${added.join(', ')}.`,
      );
    }
  }

  private compareProperties(b: Obj, a: Obj, path: string, direction: Direction) {
    const bp = asObj(b.properties);
    const ap = asObj(a.properties);
    for (const name of Object.keys(bp)) {
      if (!(name in ap)) {
        this.add(
          'breaking',
          'property.removed',
          `${path}.properties.${name}`,
          `Property ${name} was removed.`,
        );
      } else {
        this.compareSchema(bp[name], ap[name], `${path}.properties.${name}`, direction);
      }
    }
    for (const name of Object.keys(ap)) {
      if (!(name in bp)) {
        this.add(
          'additive',
          'property.added',
          `${path}.properties.${name}`,
          `Property ${name} was added.`,
        );
      }
    }
  }

  private compareRequired(b: Obj, a: Obj, path: string, direction: Direction) {
    const before = new Set(asArray(b.required).map(String));
    const after = new Set(asArray(a.required).map(String));
    const afterProperties = asObj(a.properties);
    for (const name of after) {
      if (before.has(name)) continue;
      if (direction === 'request') {
        this.add(
          'breaking',
          'required.added',
          `${path}.required`,
          `Property ${name} became required.`,
        );
      } else {
        this.add(
          'additive',
          'required.added',
          `${path}.required`,
          `Property ${name} is now always present.`,
        );
      }
    }
    for (const name of before) {
      if (after.has(name)) continue;
      if (direction === 'request') {
        this.add(
          'additive',
          'required.removed',
          `${path}.required`,
          `Property ${name} became optional.`,
        );
      } else if (name in afterProperties) {
        // (a removed property is reported as property.removed)
        this.add(
          'breaking',
          'required.removed',
          `${path}.required`,
          `Property ${name} is no longer guaranteed.`,
        );
      }
    }
  }

  private compareAnyOf(b: Obj, a: Obj, path: string, direction: Direction) {
    if (!('anyOf' in b) && !('anyOf' in a)) return;
    if (!('anyOf' in b) || !('anyOf' in a)) {
      this.add('breaking', 'anyOf.shape.changed', `${path}.anyOf`, 'anyOf was added or removed.');
      return;
    }
    const before = asArray(b.anyOf);
    const after = asArray(a.anyOf);
    const afterByKey = new Map(after.map((alt) => [canonical(alt), alt]));
    const beforeKeys = new Set(before.map(canonical));
    before.forEach((alt, index) => {
      const key = canonical(alt);
      const match = afterByKey.get(key);
      if (match !== undefined) {
        this.compareSchema(alt, match, `${path}.anyOf[${index}]`, direction);
      } else {
        this.add(
          direction === 'request' ? 'breaking' : 'additive',
          'anyOf.alternative.removed',
          `${path}.anyOf[${index}]`,
          'An alternative was removed (a modified alternative counts as removed plus added).',
        );
      }
    });
    after.forEach((alt, index) => {
      if (beforeKeys.has(canonical(alt))) return;
      this.add(
        direction === 'request' ? 'additive' : 'breaking',
        'anyOf.alternative.added',
        `${path}.anyOf[${index}]`,
        'An alternative was added (a modified alternative counts as removed plus added).',
      );
    });
  }

  private compareAdditionalProperties(b: Obj, a: Obj, path: string, direction: Direction) {
    const where = `${path}.additionalProperties`;
    const closed = (v: unknown) => v === false;
    const before = b.additionalProperties;
    const after = a.additionalProperties;
    if (isObj(before) || isObj(after)) {
      if (isObj(before) && isObj(after)) this.compareSchema(before, after, where, direction);
      else if (!same(before, after)) {
        this.add(
          'breaking',
          'additionalProperties.changed',
          where,
          'additionalProperties changed between a schema and a boolean.',
        );
      }
      return;
    }
    if (closed(before) === closed(after)) return;
    if (direction === 'request') {
      this.add(
        closed(after) ? 'breaking' : 'additive',
        'additionalProperties.changed',
        where,
        closed(after) ? 'Unknown fields are now refused.' : 'Unknown fields are now accepted.',
      );
    } else {
      this.add(
        'info',
        'additionalProperties.changed',
        where,
        'The openness of a response object changed.',
      );
    }
  }

  private compareBounds(b: Obj, a: Obj, path: string, direction: Direction) {
    const lower = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'];
    const upper = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'];
    const check = (keyword: string, isLower: boolean) => {
      const before = typeof b[keyword] === 'number' ? (b[keyword] as number) : null;
      const after = typeof a[keyword] === 'number' ? (a[keyword] as number) : null;
      if (before === after) return;
      // "tighter" = a smaller set of valid values.
      const tighter =
        before === null ? true : after === null ? false : isLower ? after > before : after < before;
      const breaks = direction === 'request' ? tighter : !tighter;
      this.add(
        breaks ? 'breaking' : 'additive',
        'bound.changed',
        `${path}.${keyword}`,
        `${keyword} changed: ${String(before)} -> ${String(after)}.`,
      );
    };
    for (const keyword of lower) check(keyword, true);
    for (const keyword of upper) check(keyword, false);
  }

  private compareStringRules(b: Obj, a: Obj, path: string, direction: Direction) {
    for (const keyword of ['format', 'pattern'] as const) {
      const before = b[keyword];
      const after = a[keyword];
      if (same(before, after)) continue;
      const where = `${path}.${keyword}`;
      const text = `${keyword} changed: ${JSON.stringify(before ?? null)} -> ${JSON.stringify(after ?? null)}.`;
      if (direction === 'request') {
        this.add(after === undefined ? 'additive' : 'breaking', 'format.changed', where, text);
      } else {
        this.add(before === undefined ? 'additive' : 'breaking', 'format.changed', where, text);
      }
    }
  }
}

/** Classifies every difference between two OpenAPI documents. Deterministic order. */
export function compareOpenApi(before: unknown, after: unknown): Finding[] {
  const comparison = new Comparison(asObj(before), asObj(after));
  comparison.compareDocuments();
  return comparison.findings;
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

export function hasBreaking(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'breaking');
}

export function formatFindings(findings: readonly Finding[]): string[] {
  const label: Record<Severity, string> = {
    breaking: 'BREAKING',
    additive: 'additive',
    info: 'info',
    error: 'ERROR',
  };
  return findings.map((f) => `[${label[f.severity]}] ${f.code} ${f.path}: ${f.message}`);
}

export interface CheckOptions {
  /** The committed baseline, `docs/openapi/public-v1.json`. */
  committed: unknown;
  /** The document the code generates now. */
  generated: unknown;
  /** The baseline of the base revision (`--base-ref`), when comparing against one. */
  base?: unknown;
  allowBreaking?: boolean;
}

export interface CheckResult {
  /** 0 fine; 1 stale baseline or breaking change; 2 the input cannot be analysed (never waivable). */
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/**
 * The decision of `pnpm openapi:check`.
 *  - Always: the committed baseline must equal the generated document (otherwise it is stale:
 *    run `pnpm openapi:generate`, review the diff and commit it). The differences are classified.
 *  - With a base revision: the generated document must not contain breaking changes against that
 *    revision's baseline, unless explicitly allowed.
 */
export function evaluate(options: CheckOptions): CheckResult {
  // Invalid input is not a compatibility finding: exit 2, whatever `allowBreaking` says.
  const problems = [
    ...validateOpenApiDocument(options.committed, 'committed baseline'),
    ...validateOpenApiDocument(options.generated, 'generated document'),
    ...(options.base !== undefined
      ? validateOpenApiDocument(options.base, 'base revision baseline')
      : []),
  ];
  if (problems.length > 0) {
    return {
      exitCode: 2,
      lines: ['The check could not run: an input is not a usable OpenAPI document.', ...problems],
    };
  }
  const lines: string[] = [];
  let failed = false;

  const drift = compareOpenApi(options.committed, options.generated);
  const baseFindings =
    options.base !== undefined ? compareOpenApi(options.base, options.generated) : [];
  if (hasErrors(drift) || hasErrors(baseFindings)) {
    return {
      exitCode: 2,
      lines: [
        'The check could not run: the documents contain references that cannot be analysed.',
        ...formatFindings([...drift, ...baseFindings].filter((f) => f.severity === 'error')),
      ],
    };
  }
  const identical = canonical(options.committed) === canonical(options.generated);
  if (identical) {
    lines.push('Committed baseline matches the generated document.');
  } else {
    failed = true;
    lines.push(
      'The committed baseline docs/openapi/public-v1.json is OUT OF DATE: it differs from the generated document.',
      'Run `pnpm openapi:generate`, review the diff and commit it. The differences are:',
      ...formatFindings(drift).map((l) => `  ${l}`),
    );
    if (drift.length === 0)
      lines.push('  (no classified difference: a key outside the modelled set changed)');
  }

  if (options.base !== undefined) {
    const findings = baseFindings;
    const breaking = findings.filter((f) => f.severity === 'breaking');
    lines.push(
      `Against the base revision: ${breaking.length} breaking, ${findings.filter((f) => f.severity === 'additive').length} additive, ${findings.filter((f) => f.severity === 'info').length} informational.`,
      ...formatFindings(findings).map((l) => `  ${l}`),
    );
    if (breaking.length > 0) {
      if (options.allowBreaking) {
        lines.push('Breaking changes are ALLOWED by --allow-breaking (a reviewed exception).');
      } else {
        failed = true;
        lines.push(
          'FAILED: breaking changes against the base revision. A breaking change needs a new API version or a reviewed exception (docs/openapi-compatibility.md).',
        );
      }
    }
  }
  return { exitCode: failed ? 1 : 0, lines };
}
