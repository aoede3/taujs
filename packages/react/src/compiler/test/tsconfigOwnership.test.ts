// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertNoExclusionConflicts,
  dedupeMatchers,
  deepEqual,
  deriveBoundaries,
  globBase,
  mergeCompilerOptions,
  parseTsconfigProject,
  resolveProjectPath,
} from '../tsconfigOwnership.js';

const fixturesDir = path.dirname(fileURLToPath(new URL('./fixtures/tsconfig.owned.json', import.meta.url)));
const toFwd = (p: string) => p.replace(/\\/g, '/');

describe('parseTsconfigProject', () => {
  it('derives absolute include/exclude globs, normalising a bare directory to <dir>/**/*', () => {
    const project = path.join(fixturesDir, 'tsconfig.owned.json');
    const { include, exclude } = parseTsconfigProject(project);
    expect(include).toEqual([toFwd(path.join(fixturesDir, 'app/**/*.tsx')), toFwd(path.join(fixturesDir, 'shared/**/*'))]);
    // a bare exclude directory expands to BOTH the literal and its subtree (file-or-directory, dot-safe)
    expect(exclude).toEqual([toFwd(path.join(fixturesDir, 'app/legacy')), toFwd(path.join(fixturesDir, 'app/legacy/**/*'))]);
  });

  it('throws a clear error for an unreadable project', () => {
    expect(() => parseTsconfigProject(path.join(fixturesDir, 'does-not-exist.json'))).toThrow(/could not read tsconfig project/);
  });

  it('a `files`-only tsconfig (no include) claims ONLY the listed files, and always excludes outDir', () => {
    const { include, exclude } = parseTsconfigProject(path.join(fixturesDir, 'tsconfig.files.json'));
    // exact files, NOT a `**/*` glob over the whole directory
    expect(include).toEqual([toFwd(path.join(fixturesDir, 'app/Only.tsx')), toFwd(path.join(fixturesDir, 'app/Also.tsx'))]);
    // outDir is excluded (never re-compile emitted output), expanded literal + subtree
    expect(exclude).toContain(toFwd(path.join(fixturesDir, 'out')));
    expect(exclude).toContain(toFwd(path.join(fixturesDir, 'out/**/*')));
  });
});

describe('globBase', () => {
  it('returns the longest literal prefix directory of an absolute glob', () => {
    expect(globBase('/repo/app/**/*.tsx')).toBe('/repo/app');
    expect(globBase('/repo/shared/**/*')).toBe('/repo/shared');
    expect(globBase('/repo/only/dir')).toBe('/repo/only/dir');
  });
});

describe('deriveBoundaries', () => {
  it('maps each include glob to its base-directory subtree, deduping exact bases', () => {
    // exact-base dedupe only (a nested base is redundant but harmless for createFilter, not collapsed)
    expect(deriveBoundaries(['/repo/app/**/*.tsx', '/repo/app/**/*.jsx', '/repo/shared/**/*'])).toEqual(['/repo/app/**/*', '/repo/shared/**/*']);
    expect(deriveBoundaries(['/repo/app/**/*.tsx', '/repo/app/pages/**/*'])).toEqual(['/repo/app/**/*', '/repo/app/pages/**/*']);
  });
});

describe('resolveProjectPath', () => {
  it('resolves a relative project from projectRoot and keeps an absolute path absolute', () => {
    expect(resolveProjectPath('./tsconfig.react.json', '/repo')).toBe('/repo/tsconfig.react.json');
    expect(resolveProjectPath('/abs/tsconfig.react.json', '/repo')).toBe('/abs/tsconfig.react.json');
  });
});

describe('mergeCompilerOptions (deterministic)', () => {
  it('merges deep-equal option sets to one', () => {
    expect(mergeCompilerOptions('React', [{ jsxRuntime: 'automatic' }, { jsxRuntime: 'automatic' }])).toEqual({ jsxRuntime: 'automatic' });
  });

  it('returns {} for an empty group', () => {
    expect(mergeCompilerOptions('React', [])).toEqual({});
  });

  it('HARD errors on divergent option sets before Vite starts', () => {
    expect(() => mergeCompilerOptions('React', [{ jsxRuntime: 'automatic' }, { jsxRuntime: 'classic' }])).toThrow(/incompatible React options/);
  });
});

describe('deepEqual', () => {
  it('compares nested structures and treats functions by identity', () => {
    const fn = () => {};
    expect(deepEqual({ a: [1, { b: 2 }], f: fn }, { a: [1, { b: 2 }], f: fn })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(deepEqual({ f: () => {} }, { f: () => {} })).toBe(false);
  });
});

describe('assertNoExclusionConflicts (same-key exclusion provenance, finding 3)', () => {
  const proj = (project: string, include: string[], exclude: string[] = []) => ({ project, include, exclude });

  it('rejects a project excluding a directory another same-key project claims (3a)', () => {
    const projects = [proj('/a/tsconfig.json', ['/repo/appA/**/*.tsx'], ['/repo/shared', '/repo/shared/**/*']), proj('/b/tsconfig.json', ['/repo/shared/**/*'])];
    expect(() => assertNoExclusionConflicts('Solid', projects, [])).toThrow(/cancels another Solid project's claim/);
  });

  it('rejects a tsconfig exclude that cancels a classifier package claim (3b: node_modules exclude vs classified Solid dep)', () => {
    const projects = [proj('/a/tsconfig.json', ['/repo/src/**/*'], ['/repo/node_modules', '/repo/node_modules/**/*'])];
    expect(() => assertNoExclusionConflicts('Solid', projects, ['/repo/node_modules/solid-lib/**/*.jsx'])).toThrow(/cancels the Solid node_modules package/);
  });

  it('allows a project excluding its OWN sub-directory while a disjoint project claims elsewhere', () => {
    const projects = [proj('/a', ['/repo/appA/**/*.tsx'], ['/repo/appA/legacy', '/repo/appA/legacy/**/*']), proj('/b', ['/repo/appB/**/*.tsx'])];
    expect(() => assertNoExclusionConflicts('Solid', projects, ['/repo/node_modules/solid-lib/**/*.jsx'])).not.toThrow();
  });
});

describe('dedupeMatchers', () => {
  it('dedupes strings by value and RegExp by source+flags, preserving order', () => {
    const re = /a\.tsx$/;
    expect(dedupeMatchers(['x', 'x', re, /a\.tsx$/, 'y'])).toEqual(['x', re, 'y']);
  });
});
