import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dedupeMatchers, deepEqual, deriveBoundaries, globBase, mergeCompilerOptions, parseTsconfigProject, resolveProjectPath } from '../tsconfigOwnership.js';

const fixturesDir = path.dirname(fileURLToPath(new URL('./fixtures/tsconfig.owned.json', import.meta.url)));
const toFwd = (p: string) => p.replace(/\\/g, '/');

describe('parseTsconfigProject', () => {
  it('derives absolute include/exclude globs, normalising a bare directory to <dir>/**/*', () => {
    const { include, exclude } = parseTsconfigProject(path.join(fixturesDir, 'tsconfig.owned.json'));
    expect(include).toEqual([toFwd(path.join(fixturesDir, 'app/**/*.tsx')), toFwd(path.join(fixturesDir, 'shared/**/*'))]);
    expect(exclude).toEqual([toFwd(path.join(fixturesDir, 'app/legacy/**/*'))]);
  });

  it('throws a clear error for an unreadable project', () => {
    expect(() => parseTsconfigProject(path.join(fixturesDir, 'does-not-exist.json'))).toThrow(/could not read tsconfig project/);
  });
});

describe('globBase / deriveBoundaries', () => {
  it('returns the longest literal prefix and maps includes to base-directory subtrees', () => {
    expect(globBase('/repo/app/**/*.tsx')).toBe('/repo/app');
    expect(deriveBoundaries(['/repo/app/**/*.tsx', '/repo/app/**/*.jsx', '/repo/shared/**/*'])).toEqual(['/repo/app/**/*', '/repo/shared/**/*']);
  });
});

describe('resolveProjectPath', () => {
  it('resolves relative from projectRoot, keeps absolute absolute', () => {
    expect(resolveProjectPath('./tsconfig.solid.json', '/repo')).toBe('/repo/tsconfig.solid.json');
    expect(resolveProjectPath('/abs/t.json', '/repo')).toBe('/abs/t.json');
  });
});

describe('mergeCompilerOptions (deterministic)', () => {
  it('merges deep-equal option sets and hard-errors on divergence', () => {
    expect(mergeCompilerOptions('Solid', [{ ssr: true }, { ssr: true }])).toEqual({ ssr: true });
    expect(mergeCompilerOptions('Solid', [])).toEqual({});
    expect(() => mergeCompilerOptions('Solid', [{ ssr: true }, { ssr: false }])).toThrow(/incompatible Solid options/);
  });
});

describe('deepEqual / dedupeMatchers', () => {
  it('compares nested structures and dedupes matchers', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ f: () => {} }, { f: () => {} })).toBe(false);
    const re = /a\.tsx$/;
    expect(dedupeMatchers(['x', 'x', re, /a\.tsx$/, 'y'])).toEqual(['x', re, 'y']);
  });
});
