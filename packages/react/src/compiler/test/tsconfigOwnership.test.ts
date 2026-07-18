// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dedupeMatchers, deepEqual, deriveBoundaries, globBase, mergeCompilerOptions, parseTsconfigProject, resolveProjectPath } from '../tsconfigOwnership.js';

const fixturesDir = path.dirname(fileURLToPath(new URL('./fixtures/tsconfig.owned.json', import.meta.url)));
const toFwd = (p: string) => p.replace(/\\/g, '/');

describe('parseTsconfigProject', () => {
  it('derives absolute include/exclude globs, normalising a bare directory to <dir>/**/*', () => {
    const project = path.join(fixturesDir, 'tsconfig.owned.json');
    const { include, exclude } = parseTsconfigProject(project);
    expect(include).toEqual([toFwd(path.join(fixturesDir, 'app/**/*.tsx')), toFwd(path.join(fixturesDir, 'shared/**/*'))]);
    expect(exclude).toEqual([toFwd(path.join(fixturesDir, 'app/legacy/**/*'))]);
  });

  it('throws a clear error for an unreadable project', () => {
    expect(() => parseTsconfigProject(path.join(fixturesDir, 'does-not-exist.json'))).toThrow(/could not read tsconfig project/);
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

describe('dedupeMatchers', () => {
  it('dedupes strings by value and RegExp by source+flags, preserving order', () => {
    const re = /a\.tsx$/;
    expect(dedupeMatchers(['x', 'x', re, /a\.tsx$/, 'y'])).toEqual(['x', re, 'y']);
  });
});
