import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: the nearest ancestor holding pnpm-workspace.yaml (works from src and dist). */
function findRepoRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads the repository-root .env into process.env (existing variables win).
 * Missing .env is not an error: deployed environments inject variables directly.
 */
export function loadEnvFile(file?: string): void {
  const root = findRepoRoot();
  const target = file ?? (root ? path.join(root, '.env') : undefined);
  if (target && existsSync(target)) {
    process.loadEnvFile(target);
  }
}
