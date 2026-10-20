# OpenAPI compatibility check

The Public API contract is `docs/openapi/public-v1.json`, generated from `apps/api/src/api/public/openapi.ts` (ADR 0011). Two safeguards protect it:

1. **Drift test** (`public-api.test.ts`, "matches the committed contract…"): the committed file must equal the document the code generates.
2. **Compatibility check** (`pnpm openapi:check`, ADR 0011 Step 7, WS1): classifies every difference as **breaking**, **additive** or **info**, and fails on breaking changes against a base revision.

Within `v1`, fields are only added (ADR 0011). The check enforces that rule mechanically; it does not replace review.

## Commands

| Command                                                   | What it does                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm openapi:check`                                      | Committed baseline vs the generated document. Exit 1 if they differ (the baseline is stale); the differences are classified. Part of `pnpm verify`. |
| `pnpm openapi:check -- --base-ref <git ref>`              | As above, and also: generated document vs the baseline **as committed at that revision**. Exit 1 on any breaking change.                            |
| `pnpm openapi:check -- --base-ref <ref> --allow-breaking` | A reviewed exception: breaking changes are reported but do not fail. The stale-baseline check still applies.                                        |
| `pnpm openapi:check -- --base-file <path>`                | As `--base-ref`, with the base baseline read from a file (for pipelines that fetch it themselves). Use one of the two, not both.                    |
| `pnpm openapi:generate`                                   | Regenerates `docs/openapi/public-v1.json` from the code.                                                                                            |

Exit codes: `0` fine, `1` stale baseline or breaking change, `2` the check could not run. **Exit 2 is never waived**: an input that is not valid JSON, not an object, not an OpenAPI 3.x document (`openapi` string, `paths` object), or that contains a `$ref` that cannot be resolved or points outside the document, an unreadable file, an unknown or unfetched git revision, a bad argument, or an internal error. `--allow-breaking` waives reviewed **breaking findings only**; it changes neither an exit 2 nor the stale-baseline exit 1. A check that cannot run never passes silently.

## Updating the baseline

1. Change the API (`openapi.ts` and the routes).
2. `pnpm openapi:generate`, then review `git diff docs/openapi/public-v1.json`.
3. `pnpm openapi:check -- --base-ref <target branch>` (for example `origin/main`):
   - **additive** and **info** findings pass; the baseline is committed together with the code change;
   - a **breaking** finding fails. Do not use `--allow-breaking` to get a green build. A breaking change needs a new API version (`/public/v2`) or a recorded decision (an ADR change record) that approves the exception; only then is `--allow-breaking` used, and the decision is referenced in the change description.
4. Commit the regenerated baseline with the change. Never edit the JSON by hand.

## What is classified

Direction matters. **Request** positions (parameters, request bodies) are what clients send: tightening breaks them. **Response** positions (response bodies and headers) are what clients read: losing information breaks them.

| Change                                                                                                                                                                                                                                                                                 | Request (parameters, body)                | Response (body, headers)                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Path, method, response code, response header **removed**                                                                                                                                                                                                                               | breaking                                  | breaking                                    |
| Path, method, response code, response header **added**                                                                                                                                                                                                                                 | additive                                  | additive                                    |
| Property **removed**                                                                                                                                                                                                                                                                   | breaking                                  | breaking                                    |
| Property added                                                                                                                                                                                                                                                                         | additive (breaking if also required)      | additive                                    |
| Becomes **required** / no longer required                                                                                                                                                                                                                                              | breaking / additive                       | additive / breaking                         |
| Parameter removed; new **required** parameter; optional → required                                                                                                                                                                                                                     | breaking                                  | n/a                                         |
| New optional parameter; required → optional                                                                                                                                                                                                                                            | additive                                  | n/a                                         |
| Request body removed / made required / new required body                                                                                                                                                                                                                               | breaking                                  | n/a                                         |
| Media type removed / added                                                                                                                                                                                                                                                             | breaking / additive                       | breaking / additive                         |
| **Enum narrowed** (value removed)                                                                                                                                                                                                                                                      | breaking                                  | breaking (conservative)                     |
| Enum widened (value added)                                                                                                                                                                                                                                                             | additive                                  | additive (clients must tolerate new values) |
| Enum constraint added / removed                                                                                                                                                                                                                                                        | breaking / additive                       | additive / additive                         |
| **Type changed**                                                                                                                                                                                                                                                                       | breaking, except pure widening (additive) | breaking, except pure narrowing (additive)  |
| `format` / `pattern` changed or added                                                                                                                                                                                                                                                  | breaking (removal is additive)            | breaking (adding is additive)               |
| Bounds (`minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, exclusive bounds)                                                                                                                                                                                      | tighter: breaking; looser: additive       | looser: breaking; tighter: additive         |
| `default` changed                                                                                                                                                                                                                                                                      | breaking                                  | info                                        |
| `additionalProperties` open → closed                                                                                                                                                                                                                                                   | breaking (closed → open is additive)      | info                                        |
| `anyOf` alternative removed / added                                                                                                                                                                                                                                                    | breaking / additive                       | additive / breaking                         |
| `readOnly` / `writeOnly` changed                                                                                                                                                                                                                                                       | breaking                                  | breaking                                    |
| **Security**: operation or document `security` changed; security scheme changed or removed                                                                                                                                                                                             | breaking                                  | breaking                                    |
| **Required scope** (`x-required-scope`) changed or newly required                                                                                                                                                                                                                      | breaking                                  | breaking                                    |
| Required scope removed; security scheme added                                                                                                                                                                                                                                          | additive                                  | additive                                    |
| `operationId` changed; `servers` changed                                                                                                                                                                                                                                               | breaking                                  | breaking                                    |
| Descriptions, summaries, titles, examples, tags, `info.version`, `openapi` version, named schemas added or removed                                                                                                                                                                     | info                                      | info                                        |
| `$ref` that cannot be resolved, or an external `$ref` (anywhere in a document, on either side)                                                                                                                                                                                         | **error, exit 2**                         | **error, exit 2**                           |
| **Anything not modelled**, including a schema that something references through an unmodelled keyword (`oneOf`, `allOf`, `not`, `if`, …) and the unmodelled keys of parameters, request bodies, responses, media types and headers (`style`, `explode`, `encoding`, `links`, `x-…`, …) | `unclassified`, counted as **breaking**   | same                                        |

Every input is validated first (see the exit codes). For keys the tool does not model, two values are "equal" only if they and everything they reference (recursively, with cycles marked) are equal, so a change in a schema that is reached only through `oneOf`, `allOf`, `not` or a link is detected and reported as `unclassified`. Parameters are compared by name and location after merging path-level and operation-level parameters. Local `$ref`s are followed, including the schema-local `#/$defs/…` form the generator emits; recursive schemas are compared once per pair of references.

## Limitations (this is not an exhaustive compatibility proof)

- **Rule-based and conservative.** It reports what its rules recognise. Anything else that changes is reported as `unclassified` and fails, so a human decides; it can also report a harmless change as breaking (for example a response enum that only loses values, or an `anyOf` alternative that was modified, which counts as one removed plus one added).
- **Each referenced schema is compared once** (where it first occurs), so a change inside a shared schema is reported at one path, not at every use.
- **Unmodelled constructs are not understood, only detected.** The tool cannot say whether a change in `oneOf`, `allOf`, `not`, `if/then/else`, a link or a callback is compatible; it reports that it changed and a person decides. It also reports a harmless change there (for example an added `x-` extension on a parameter) as breaking.
- **Not modelled:** `oneOf`, `allOf`, `not`, `if/then/else`, `patternProperties`, `unevaluatedProperties`, discriminators, callbacks, links, webhooks, external (`$ref` to another file) references, and the meaning of `$defs` entries that nothing references. Constraints such as `multipleOf`, `uniqueItems` or `contains` are reported as `unclassified` when they change.
- **Semantics are invisible.** It cannot see changed behaviour behind an unchanged contract: validation rules, defaults applied by the server, ordering, rate limits, error codes inside an unchanged `Error` schema, or the meaning of a field.
- **Wire-level concerns are out of scope:** event payloads of webhooks (documented in `docs/api.md`, not in this document), authentication behaviour, and pagination semantics.
- **Two documents only.** It compares a baseline with a candidate; it does not know which version the candidate claims to be. `info.version` changes are informational.
- **A shallow checkout cannot run `--base-ref`**; the check then exits 2 instead of passing.

The classifier is covered by unit tests on synthetic documents and on the real contract (`apps/api/test/openapi-compat.test.ts`).

## CI job definition (ready to adopt; no provider is configured)

`apps/api/scripts/ci/openapi-compat.sh` is the provider-neutral step. It needs Node 22.12+, pnpm 10.28 (see `.nvmrc` and `package.json`) and a checkout that contains the target branch. It needs **no database**.

```sh
BASE_REF=origin/main sh apps/api/scripts/ci/openapi-compat.sh
```

An illustrative job for a pull-request pipeline (adapt the syntax to the provider that is eventually chosen; nothing in the repository runs this today):

```yaml
openapi-compatibility:
  # Trigger: every pull request that targets the main branch.
  steps:
    - checkout:
        fetch-depth: 0 # the base branch must be present
    - setup-node: '22.12'
    - run: corepack enable
    - run: BASE_REF=origin/main sh apps/api/scripts/ci/openapi-compat.sh
  # Pass: exit 0. Fail: exit 1 (stale baseline or breaking change) or 2 (the check could not run).
```

Prerequisites for adoption: a CI provider and a pipeline that runs for pull requests; the decision on who may approve a breaking exception (see "Updating the baseline"); and protecting the baseline file with a code-owner review so that it cannot change without a reviewer.
