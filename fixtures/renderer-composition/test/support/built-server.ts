import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertWorkspacePackagesBuilt } from '../../../test-support/BuiltPackages';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The BUILT server these suites drive, exactly as a consumer resolves it. */
export const SERVER_DIST = path.join(HERE, '..', '..', 'node_modules', '@taujs', 'server', 'dist', 'index.js');

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
 * This guard ENFORCES the build rather than performing it. No fixture may build a shared workspace
 * package during `pnpm -r test`: sibling suites run concurrently, so cleaning and rewriting one
 * `dist` there can invalidate another suite's imports.
 */
export const assertBuiltServerIsFresh = (): void => {
  assertWorkspacePackagesBuilt(['server']);
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
      // The group always participates in a match, so this is never undefined at runtime - but the
      // type says otherwise and a silent `undefined` here would drop a real external import from
      // the assertion rather than fail it.
      if (specifier !== undefined && !specifier.startsWith('.')) specifiers.add(specifier);
    }
  }

  return [...specifiers];
};
