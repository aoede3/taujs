import path from 'node:path';

import ts from 'typescript';

/**
 * ESC-1 - generic tsconfig -> ownership-matcher derivation (RFC 0006 ESC-1 checkpoint sections 3, 8,
 * 10). Framework-NEUTRAL: it turns a compiler's tsconfig PROJECT (its own `include`/`exclude` globs,
 * resolving `extends`) into stable, Vite-`createFilter`-compatible absolute matchers - NEVER the
 * expanded file snapshot (A3 finding 1: a startup file list silently misses post-startup files). The
 * renderer supplies these to the host; the host only evaluates them.
 *
 * This module is duplicated verbatim in `@taujs/solid` (build-time plugin utilities are kept
 * per-package so `@taujs/solid` never depends on `@taujs/react`). Keep the two copies in sync.
 */

export type OwnershipMatcher = string | RegExp;

// picomatch/glob metacharacters - the presence of any marks a path segment as non-literal.
const GLOB_CHARS = /[*?{}[\]!()+@]/;

const toForwardSlash = (p: string): string => p.replace(/\\/g, '/');

const hasGlob = (segment: string): boolean => GLOB_CHARS.test(segment);

/**
 * TypeScript `include` semantics: a bare directory (no glob, no file extension) matches everything
 * beneath it. Normalise such an entry to `<dir>/**\/*` so it round-trips as a createFilter glob.
 */
const normaliseIncludeGlob = (glob: string): string => {
  if (hasGlob(glob)) return glob;
  const last = glob.split('/').pop() ?? '';
  if (last.includes('.')) return glob; // an explicit file
  return `${glob.replace(/\/+$/, '')}/**/*`;
};

/**
 * TypeScript `exclude` semantics differ from `include`: an exclude entry is directory-recursive
 * regardless of a dot in the name (e.g. `components.new/`), and a bare entry may be a FILE or a
 * DIRECTORY. Emit BOTH the literal and the `<entry>/**\/*` subtree so createFilter subtracts either -
 * the include-oriented `normaliseIncludeGlob` would wrongly treat a dotted directory as a file.
 */
const normaliseExcludeGlob = (glob: string): string[] => {
  if (hasGlob(glob)) return [glob];
  const trimmed = glob.replace(/\/+$/, '');
  return [trimmed, `${trimmed}/**/*`];
};

/** The longest leading run of literal (glob-free) segments of an absolute glob - its base directory. */
export const globBase = (absoluteGlob: string): string => {
  const segments = absoluteGlob.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    literal.push(segment);
  }
  const joined = literal.join('/');
  return joined || '/';
};

/**
 * Parse a tsconfig project into its own `include`/`exclude` GLOBS (extends resolved), as absolute
 * forward-slash matchers. `references` are NOT followed: a contribution points at its OWN compiler
 * project, and other referenced projects belong to other compilers (following them would double-claim).
 */
export const parseTsconfigProject = (projectPath: string): { include: OwnershipMatcher[]; exclude: OwnershipMatcher[] } => {
  const host: ts.ParseConfigFileHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };

  const parsed = ts.getParsedCommandLineOfConfigFile(projectPath, {}, host);
  if (!parsed) throw new Error(`[taujs] could not read tsconfig project "${projectPath}".`);

  const dir = path.dirname(projectPath);
  const abs = (glob: string): OwnershipMatcher => toForwardSlash(path.resolve(dir, glob));

  // Ownership set: explicit `include` globs; else the explicit `files` list (exact files, NOT a `**/*`
  // glob - a `files`-only project claims ONLY the listed files); else TypeScript's implicit `**/*`.
  const rawInclude: string[] = Array.isArray(parsed.raw?.include)
    ? parsed.raw.include
    : Array.isArray(parsed.raw?.files) && parsed.raw.files.length
      ? parsed.raw.files
      : ['**/*'];

  // Exclusions: the project's own `exclude`, plus the compiled `outDir` (always excluded - never
  // re-compile emitted output). TypeScript's implicit `node_modules` default is deliberately NOT added:
  // the vitefu classifier owns SPECIFIC node_modules packages, and a single createFilter cannot express
  // "exclude node_modules EXCEPT the classified packages" (exclude wins over include), so a blanket
  // node_modules exclude would kill the classifier's claims. A scoped project include does not reach
  // node_modules anyway.
  const rawExclude: string[] = Array.isArray(parsed.raw?.exclude) ? parsed.raw.exclude : [];
  const outDir = typeof parsed.options?.outDir === 'string' ? [parsed.options.outDir] : [];

  const include = rawInclude.map((glob) => abs(normaliseIncludeGlob(glob)));
  const exclude = [...rawExclude, ...outDir].flatMap(normaliseExcludeGlob).map(abs);

  return { include, exclude };
};

/**
 * Derive expected-owner BOUNDARY matchers from a project's include globs: the whole subtree under each
 * include's base directory (`<base>/**\/*`). Broader than the (possibly narrower) claims, so a JSX/TSX
 * file in the subtree that no compiler claims is a zero-owner gap; the project's own `exclude` is
 * subtracted by the host, so deliberate exclusions fall outside the boundary and are not flagged.
 */
export const deriveBoundaries = (absoluteIncludeGlobs: OwnershipMatcher[]): OwnershipMatcher[] => {
  const bases = new Set<string>();
  for (const glob of absoluteIncludeGlobs) {
    if (typeof glob !== 'string') continue;
    bases.add(globBase(glob));
  }
  return [...bases].map((base) => `${base}/**/*`);
};

/** Resolve a contribution `project` pointer: relative resolves from `projectRoot`, absolute stays absolute. */
export const resolveProjectPath = (project: string, projectRoot: string): string => toForwardSlash(path.resolve(projectRoot, project));

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural deep-equality for the deterministic option-merge rule (functions compared by identity). */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
};

/**
 * Deterministic same-key option merge (checkpoint section 3): a managed compiler is chain-global in
 * shared dev, so every app declaring the same key must agree on its options. Compatible (deep-equal)
 * option sets merge to one; any divergence fails BEFORE Vite starts. This is the whole rule - simple,
 * deterministic, and acceptance-tested.
 */
export const mergeCompilerOptions = (label: string, optionSets: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => {
  if (optionSets.length === 0) return {};
  const first = optionSets[0]!;
  for (let index = 1; index < optionSets.length; index += 1) {
    if (!deepEqual(first, optionSets[index])) {
      throw new Error(
        `[taujs] two apps declare incompatible ${label} options. A managed compiler is chain-global in shared dev, so every app's ${label} options must match. Align them, or give each app its own build.`,
      );
    }
  }
  return { ...first };
};

const withTrailingSlash = (p: string): string => (p.endsWith('/') ? p : `${p}/`);
const pathAncestorOrEqual = (ancestor: string, descendant: string): boolean => ancestor === descendant || descendant.startsWith(withTrailingSlash(ancestor));

const firstOverlap = (excludeGlobs: OwnershipMatcher[], claimGlobs: OwnershipMatcher[]): { exclude: string; claim: string } | undefined => {
  for (const ex of excludeGlobs) {
    if (typeof ex !== 'string') continue;
    const exBase = globBase(ex);
    for (const claim of claimGlobs) {
      if (typeof claim !== 'string') continue;
      const claimBase = globBase(claim);
      if (pathAncestorOrEqual(exBase, claimBase) || pathAncestorOrEqual(claimBase, exBase)) return { exclude: ex, claim };
    }
  }
  return undefined;
};

/** One compiler project's own include/exclude, retained so exclusion PROVENANCE can be checked. */
export type ProjectOwnership = { project: string; include: OwnershipMatcher[]; exclude: OwnershipMatcher[] };

/**
 * A managed compiler merges all same-key projects' claims AND excludes into ONE createFilter (a single
 * include/exclude pair cannot express a union of per-project owned sets). So one project's exclude would
 * silently cancel another project's claim - or a tsconfig `exclude` would cancel the classifier's
 * node_modules package claims. Rather than reproduce resolver machinery, REJECT such overlaps before Vite
 * starts (checkpoint §3 provenance; maintainer ruling 2026-07-18): each project's exclude may only touch
 * its OWN claims. Overlap is judged by directory ancestry of the glob bases.
 */
export const assertNoExclusionConflicts = (label: string, projects: ReadonlyArray<ProjectOwnership>, classifierClaims: OwnershipMatcher[]): void => {
  for (const p of projects) {
    for (const q of projects) {
      if (q === p) continue;
      const hit = firstOverlap(p.exclude, q.include);
      if (hit) {
        throw new Error(
          `[taujs] a ${label} project excludes "${hit.exclude}", which cancels another ${label} project's claim "${hit.claim}". ` +
            `A managed compiler merges every same-key project's claims and excludes into one filter, so one project's exclude must not remove another project's owned files. ` +
            `Give the ${label} projects disjoint membership - do not exclude a directory another ${label} project includes.`,
        );
      }
    }
    const pkgHit = firstOverlap(p.exclude, classifierClaims);
    if (pkgHit) {
      throw new Error(
        `[taujs] a ${label} project excludes "${pkgHit.exclude}", which cancels the ${label} node_modules package "${pkgHit.claim}" the classifier owns. ` +
          `Remove that exclude - ${label} node_modules packages are compiled via the classifier, not the tsconfig source globs.`,
      );
    }
  }
};

/** Deduplicate matchers, preserving order; RegExp identity by source+flags, strings by value. */
export const dedupeMatchers = (matchers: OwnershipMatcher[]): OwnershipMatcher[] => {
  const seen = new Set<string>();
  const out: OwnershipMatcher[] = [];
  for (const matcher of matchers) {
    const key = typeof matcher === 'string' ? `s:${matcher}` : `r:${matcher.source} ${matcher.flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(matcher);
  }
  return out;
};
