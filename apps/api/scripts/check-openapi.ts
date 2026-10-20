import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/api/public/openapi.js';
import { evaluate } from './openapi-compat.js';

/**
 * `pnpm openapi:check [--base-ref <git ref> | --base-file <path>] [--allow-breaking]`
 *
 * Exit 0: fine. Exit 1: the committed baseline is stale, or (with a base) the generated document
 * contains breaking changes against the base baseline. Exit 2: the check itself could not run
 * (unreadable or invalid input, an input that is not an OpenAPI 3.x document, an unresolved
 * reference, an unknown git ref, bad arguments, an internal error): never a silent pass.
 * `--allow-breaking` waives reviewed breaking findings ONLY: it never changes an exit 2 or the
 * stale-baseline exit 1.
 * Rules and the update process: docs/openapi-compatibility.md.
 */

const BASELINE = 'docs/openapi/public-v1.json';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function fail(message: string): never {
  console.error(`openapi:check could not run: ${message}`);
  process.exit(2);
}

function parseArguments(args: string[]) {
  let baseRef: string | undefined;
  let baseFile: string | undefined;
  let allowBreaking = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      continue; // pnpm forwards the separator when scripts are chained
    } else if (arg === '--base-ref') {
      baseRef = args[i + 1];
      i += 1;
      if (!baseRef) fail('--base-ref needs a git revision, for example origin/main');
    } else if (arg === '--base-file') {
      baseFile = args[i + 1];
      i += 1;
      if (!baseFile) fail('--base-file needs the path of a baseline OpenAPI JSON file');
    } else if (arg === '--allow-breaking') {
      allowBreaking = true;
    } else {
      fail(`unknown argument "${arg}"`);
    }
  }
  if (baseRef !== undefined && baseFile !== undefined) {
    fail('use either --base-ref or --base-file, not both');
  }
  return { baseRef, baseFile, allowBreaking };
}

function readJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return fail(`${what} is not valid JSON (${(error as Error).message})`);
  }
}

function main() {
  const { baseRef, baseFile, allowBreaking } = parseArguments(process.argv.slice(2));

  let committedText: string;
  try {
    committedText = readFileSync(new URL(`../../../${BASELINE}`, import.meta.url), 'utf8');
  } catch (error) {
    return fail(`cannot read ${BASELINE} (${(error as Error).message})`);
  }
  const committed = readJson(committedText, BASELINE);
  const generated = JSON.parse(JSON.stringify(buildOpenApiDocument())) as unknown;

  let base: unknown;
  if (baseRef !== undefined) {
    let text: string;
    try {
      text = execFileSync('git', ['show', `${baseRef}:${BASELINE}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      return fail(
        `cannot read ${BASELINE} at "${baseRef}". Is the revision fetched (CI checkouts are often shallow) and does the file exist there? (${(error as Error).message.split('\n')[0]})`,
      );
    }
    base = readJson(text, `${BASELINE} at ${baseRef}`);
  } else if (baseFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(baseFile, 'utf8');
    } catch (error) {
      return fail(`cannot read the base file "${baseFile}" (${(error as Error).message})`);
    }
    base = readJson(text, baseFile);
  }

  // Validation of all three documents (object, OpenAPI 3.x, `paths`, resolvable references) and
  // the comparison are in `evaluate`; an invalid input is exit 2 whatever --allow-breaking says.
  const result = evaluate({ committed, generated, base, allowBreaking });
  for (const line of result.lines) (result.exitCode === 2 ? console.error : console.log)(line);
  process.exit(result.exitCode);
}

try {
  main();
} catch (error) {
  fail(
    `internal error (${(error as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(error)})`,
  );
}
