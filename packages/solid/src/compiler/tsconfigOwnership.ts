import path from 'node:path';

import ts from 'typescript';

/**
 * ESC-1 - generic tsconfig -> ownership-matcher derivation (RFC 0006 ESC-1 checkpoint sections 3, 8,
 * 10). Framework-NEUTRAL: it turns a compiler's tsconfig PROJECT (its own `include`/`exclude` globs,
 * resolving `extends`) into stable, Vite-`createFilter`-compatible absolute matchers - NEVER the
 * expanded file snapshot (A3 finding 1: a startup file list silently misses post-startup files). The
 * renderer supplies these to the host; the host only evaluates them.
 *
 * This module is duplicated verbatim from `@taujs/react` (build-time plugin utilities are kept
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
  const rawInclude: string[] = Array.isArray(parsed.raw?.include) ? parsed.raw.include : ['**/*'];
  const rawExclude: string[] = Array.isArray(parsed.raw?.exclude) ? parsed.raw.exclude : [];

  const include = rawInclude.map((glob) => toForwardSlash(path.resolve(dir, normaliseIncludeGlob(glob))));
  const exclude = rawExclude.map((glob) => toForwardSlash(path.resolve(dir, normaliseIncludeGlob(glob))));

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
