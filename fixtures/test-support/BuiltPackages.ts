import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const newestSourceMtime = (directory: string): number => {
  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;

    const candidate = path.join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(candidate) : statSync(candidate).mtimeMs);
  }

  return newest;
};

/**
 * Fail fast when a fixture would execute an absent or ordinarily stale workspace build.
 *
 * Fixture tests must never build shared packages themselves: `pnpm -r test` runs sibling fixtures
 * concurrently, so an in-test build can clean and rewrite `dist` while another suite imports it.
 * The authoritative repository check runs `pnpm -r build` before `pnpm -r test`; this timestamp
 * check only makes direct fixture runs fail with an actionable instruction instead of using a
 * visibly stale build.
 */
export const assertWorkspacePackagesBuilt = (packageNames: readonly string[]): void => {
  const stale: string[] = [];

  for (const packageName of packageNames) {
    const packageRoot = path.join(REPOSITORY_ROOT, 'packages', packageName);
    const sourceRoot = path.join(packageRoot, 'src');
    const builtEntry = path.join(packageRoot, 'dist', 'index.js');

    if (!existsSync(builtEntry) || statSync(builtEntry).mtimeMs < newestSourceMtime(sourceRoot)) stale.push(`@taujs/${packageName}`);
  }

  if (stale.length > 0) {
    const filters = stale.map((packageName) => `--filter ${packageName}`).join(' ');
    throw new Error(`Workspace build missing or older than source for ${stale.join(', ')}. Run \`pnpm ${filters} build\` before this fixture.`);
  }
};
