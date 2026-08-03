import { dirname, join } from 'node:path';
import path from 'node:path'; /* separated import due to Istanbul coverage bug */
import { fileURLToPath } from 'node:url';

export type RuntimeMode = 'development' | 'production';

/**
 * The ONE runtime-mode derivation. Development must be requested explicitly; `production`,
 * `test`, unset and any other value (`staging`, `ci`, ...) all take production runtime
 * behaviour. Previously the mode was inferred independently at each site with two different
 * partitions (`=== 'development'` vs `=== 'production'`), so every value that was neither
 * literal produced an incoherent mixture - a development client root with production asset
 * loading, i.e. a guaranteed `src/client/.vite/manifest.json` ENOENT at boot.
 *
 * Internal source export for direct tests only - deliberately NOT part of the package exports.
 */
export function resolveRuntimeMode(nodeEnv: string | undefined): RuntimeMode {
  return nodeEnv === 'development' ? 'development' : 'production';
}

/**
 * Snapshotted once at module evaluation. Mutating `process.env.NODE_ENV` after importing
 * `@taujs/server` is unsupported and must never change part of a running process.
 */
export const runtimeMode: RuntimeMode = resolveRuntimeMode(process.env.NODE_ENV);
export const isDevelopment = runtimeMode === 'development';

export const __filename = fileURLToPath(import.meta.url);

const DIR_SUFFIX = isDevelopment ? '..' : './';
export const __dirname = join(dirname(__filename), DIR_SUFFIX);
