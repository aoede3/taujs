import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The BUILT server these suites drive, exactly as a consumer resolves it. */
export const SERVER_DIST = path.join(HERE, '..', '..', 'node_modules', '@taujs', 'server', 'dist', 'index.js');

const SERVER_SRC = path.join(HERE, '..', '..', '..', '..', 'packages', 'server', 'src');

const newestMtimeUnder = (dir: string): number => {
  let newest = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;

    const full = path.join(dir, entry.name);

    newest = Math.max(newest, entry.isDirectory() ? newestMtimeUnder(full) : statSync(full).mtimeMs);
  }

  return newest;
};

/**
 * A LOCAL stale-build guard: fails when `dist` is older than the server source it was built from.
 *
 * It is not a guarantee, and should not be read as one. A timestamp comparison can be fooled by
 * copied or touched output, by clock skew, by build inputs that live outside `src`, and by a fresh
 * `index.js` sitting beside stale chunks. What it reliably catches is the ordinary case: editing
 * the server and running these suites without rebuilding.
 *
 * **The authoritative guarantee is `pnpm run check`, which builds every package before it tests.**
 *
 * It replaces a CONTENT SENTINEL, which was strictly worse: a sentinel names a string the current
 * build happens to contain, so it necessarily predates the next transport change and silently
 * accepts a stale build afterwards. That is not hypothetical - a whole renderer acceptance round
 * was run against a stale `dist` because its sentinel still matched.
 *
 * This guard ENFORCES the build rather than performing it, deliberately. Building from inside this
 * package is what NOT to do: `playground-react` already rebuilds `@taujs/server` and `@taujs/react`
 * in its own `beforeAll`, pnpm runs sibling packages concurrently, and two builds racing on one
 * `dist` fail unrelated suites in whichever package happens to be resolving modules at the time.
 */
export const assertBuiltServerIsFresh = (): void => {
  const built = statSync(SERVER_DIST).mtimeMs;
  const source = newestMtimeUnder(SERVER_SRC);

  expect(
    built >= source,
    `Built @taujs/server is OLDER than packages/server/src. These cells drive the built package, so this run would prove nothing about the current tree. Run \`pnpm --filter @taujs/server build\`.`,
  ).toBe(true);
};

/**
 * Every BARE module specifier imported by any emitted chunk of the built server.
 *
 * Reading the whole `dist` rather than one entry file is the point: tsup splits shared code into
 * chunks, so an assertion made against `index.js` alone measures the bundler's layout, not the
 * dependency graph.
 */
export const externalImportsOfBuiltServer = (): string[] => {
  const distDir = path.dirname(SERVER_DIST);
  const sources = readdirSync(distDir)
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => readFileSync(path.join(distDir, entry), 'utf8'));

  const specifiers = new Set<string>();

  for (const source of sources) {
    for (const [, specifier] of source.matchAll(/(?:from|require\(|import\()\s*["']([^"']+)["']/g)) {
      if (!specifier.startsWith('.')) specifiers.add(specifier);
    }
  }

  return [...specifiers];
};
