import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Vite 7.3.6 `DEFAULT_CONFIG_FILES` (verbatim, in probe order).
 *
 * τjs pins `configFile: false` in both the dev server and every per-app build, so Vite never
 * probes these on τjs's behalf. This list exists only to detect a config file sitting in a
 * location Vite *used* to discover, so the framework can warn instead of silently ignoring it.
 */
export const DEFAULT_CONFIG_FILES = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'] as const;

/**
 * Probe a single directory (no upward traversal - matching Vite's root-relative behaviour) for
 * a `vite.config.*` file that τjs would previously have discovered accidentally. Returns the
 * absolute path of the first match, or `undefined` when none is present.
 */
export const findFormerlyDiscoveredViteConfig = (root: string): string | undefined => {
  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = path.resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
};

/**
 * The targeted migration message: names the file, states τjs no longer reads it, and points at
 * the declared surface that replaces it.
 */
export const formerlyDiscoveredViteConfigWarning = (file: string): string =>
  `τjs no longer reads Vite config files - found "${file}" but it is not loaded. ` +
  'Move its contents into taujs.config.ts (the "vite" option / top-level "alias") or the taujsBuild({ vite }) escape hatch.';
