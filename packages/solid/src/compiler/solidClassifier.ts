import path from 'node:path';

import { crawlFrameworkPkgs, findDepPkgJsonPath } from 'vitefu';

import type { OwnershipMatcher } from './tsconfigOwnership.js';

/**
 * ESC-1 - renderer-owned node_modules classifier (RFC 0006 ESC-1 checkpoint section 9). Solid libraries
 * ship uncompiled JSX declaring a `solid` export condition, so they must be compiled by the Solid plugin
 * even though they live in node_modules. We derive EXACT package-DIRECTORY matchers using `vitefu`'s
 * supported resolution primitives (the same ones `vite-plugin-solid` uses) - NEVER a reproduced resolver
 * or module graph (the standing REVISE tripwire: exact package-path provenance requiring τjs to recreate
 * resolution). Proven in the ESC-1 lifecycle fixture B (direct-package feasibility PASS).
 *
 * LIMITED FEASIBILITY (checkpoint section 9): direct packages pass; deeply nested / transitive /
 * workspace / strict-pnpm-visibility / multi-instance coverage is an implementation acceptance
 * requirement carried by the matrix - `findDepPkgJsonPath` resolves from the project root, so a
 * root-visible instance is matched; if exact per-instance provenance ever needs recreating resolution,
 * that is a REVISE, not a silent widening.
 */

const toForwardSlash = (p: string): string => p.replace(/\\/g, '/');

// Extensions a Solid package might ship needing compilation (broad; vite-plugin-solid's own filter narrows).
const PKG_GLOB = '**/*.{jsx,tsx,js,ts,mjs,cjs}';

/** Renderer-owned policy: does this package's `exports` (or legacy fields) declare a `solid` condition? */
const containsSolidCondition = (fields: unknown): boolean => {
  if (!fields || typeof fields !== 'object') return false;
  const record = fields as Record<string, unknown>;
  if ('solid' in record) return true;
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && containsSolidCondition(value)) return true;
  }
  return false;
};

/**
 * Classify the project's dependencies and return exact package-directory ownership matchers for every
 * package that declares a `solid` export condition. Returns [] when there are no resolvable deps.
 */
export const classifySolidPackages = async (projectRoot: string): Promise<OwnershipMatcher[]> => {
  let crawl: Awaited<ReturnType<typeof crawlFrameworkPkgs>>;
  try {
    crawl = await crawlFrameworkPkgs({
      root: projectRoot,
      isBuild: false,
      isFrameworkPkgByJson: (pkgJson) => containsSolidCondition((pkgJson as { exports?: unknown }).exports ?? {}),
    });
  } catch {
    return [];
  }

  // Framework packages are excluded from dependency pre-bundling so Vite processes their source with
  // the plugin - that exclude list is the set of classified Solid packages (fixture B).
  const classified = crawl.optimizeDeps?.exclude ?? [];

  const matchers: OwnershipMatcher[] = [];
  for (const dep of classified) {
    const pkgJsonPath = await findDepPkgJsonPath(dep, projectRoot);
    if (!pkgJsonPath) continue;
    matchers.push(`${toForwardSlash(path.dirname(pkgJsonPath))}/${PKG_GLOB}`);
  }
  return matchers;
};
