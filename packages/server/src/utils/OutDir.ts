import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Output-directory cleanup for a FILTERED build.
 *
 * Vite's `emptyOutDir` empties a directory blind: the skip list `prepareOutDir` builds comes from
 * the output directories of the SAME `build()` call, and taujs calls `build()` once per app - so a
 * parent app deletes a descendant app's output. An unfiltered build repairs that through the
 * ancestry reorder (every descendant rebuilds after its parent); a filtered build has no such pass,
 * so taujs takes ownership of the cleanup for exactly those apps that contain a declared descendant.
 *
 * Internal: this module is not reachable through any package export. It lives here rather than in
 * `Build.ts` so it can be tested directly without widening the public `@taujs/server/build` surface.
 */

/**
 * The entry NAMES inside `outDir` that must survive emptying it, given every DECLARED app's output
 * directory. Mirrors the shape of Vite's own `emptyDir(dir, skip)` contract, which skips by ENTRY
 * NAME rather than by path - so a descendant two levels down (`dist/client/a/b`) is preserved by
 * keeping its first segment (`a`).
 *
 * `allOutDirs` must be derived from EVERY declared app, never from the filtered build set: the
 * whole point is to preserve output belonging to apps this run was not asked to build.
 */
export function preservedOutDirEntries(outDir: string, allOutDirs: readonly string[]): string[] {
  const names = new Set<string>();

  for (const other of allOutDirs) {
    if (other === outDir || !other.startsWith(outDir + path.sep)) continue;
    const [first] = path.relative(outDir, other).split(path.sep);
    if (first) names.add(first);
  }

  return [...names];
}

/**
 * Empty `outDir`, keeping `preserve` (plus `.git`, mirroring Vite's own skip).
 *
 * A directory that does not exist yet is the ordinary first-build case and is not an error. EVERY
 * OTHER failure propagates: the caller has already told Vite `emptyOutDir: false` on the strength of
 * this cleanup happening, so swallowing (say) an `EACCES` would leave the previous build's output
 * in place with nothing else about to remove it - stale files silently mixed into a fresh build.
 */
export async function emptyOutDirPreserving(outDir: string, preserve: readonly string[]): Promise<void> {
  let entries: string[];

  try {
    entries = await readdir(outDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const keep = new Set([...preserve, '.git']);

  for (const entry of entries) {
    if (keep.has(entry)) continue;
    await rm(path.join(outDir, entry), { recursive: true, force: true });
  }
}
