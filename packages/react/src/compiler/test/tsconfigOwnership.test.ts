// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFilter } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  NON_TRANSFORMABLE_EXCLUDE,
  REACT_TRANSFORMABLE_EXTENSIONS,
  assertNoExclusionConflicts,
  dedupeMatchers,
  deepEqual,
  deriveBoundaries,
  globBase,
  mergeCompilerOptions,
  narrowToTransformableScope,
  parseTsconfigProject,
  resolveProjectPath,
} from '../tsconfigOwnership.js';

import type { OwnershipMatcher } from '../tsconfigOwnership.js';

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
    const projects = [
      proj('/a/tsconfig.json', ['/repo/appA/**/*.tsx'], ['/repo/shared', '/repo/shared/**/*']),
      proj('/b/tsconfig.json', ['/repo/shared/**/*']),
    ];
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

describe('React plugin scope intersection (RFC 0013)', () => {
  // The scope handed to plugin-react must be claims AND transformable, for EVERY claim shape.
  // Vite 8's oxc transform parses whatever is claimed as JavaScript, so a claim that reaches it
  // with `.css`/`.html` in scope breaks development SSR. Asserted through Vite's own
  // `createFilter`, pairing the narrowed include with the exclusion exactly as the compiler does.
  const root = '/repo';
  const scopeFor = (claims: OwnershipMatcher[]) =>
    createFilter(narrowToTransformableScope(claims.map((c) => (typeof c === 'string' ? `${root}/${c}` : c))), [NON_TRANSFORMABLE_EXCLUDE]);
  const isMatch = (file: string, filter: ReturnType<typeof createFilter>) => filter(`${root}/${file}`);

  const TRANSFORMABLE = ['src/client/App.tsx', 'src/client/main.jsx', 'src/client/util.ts', 'src/client/legacy.js', 'src/client/deep/nested/C.tsx'];
  // Everything plugin-react does NOT transform, including the shapes an "other alphanumeric
  // extension" rule silently admitted: extensionless files and unusual suffixes.
  const ASSETS = [
    'src/client/styles.css',
    'src/client/index.html',
    'src/client/logo.svg',
    'src/client/data.json',
    'src/client/extensionless',
    'src/client/file.foo-bar',
    'src/client/legacy.mjs',
    'src/client/legacy.cjs',
    'src/client/types.mts',
    'src/client/types.cts',
  ];

  it('a broad subtree claim admits transformable files and excludes assets', () => {
    const scope = scopeFor(['src/client/**/*']);
    for (const f of TRANSFORMABLE) expect(isMatch(f, scope)).toBe(true);
    for (const f of ASSETS) expect(isMatch(f, scope)).toBe(false);
  });

  it('an EXPLICIT non-transformable claim is still excluded (glob rewriting alone cannot do this)', () => {
    const scope = scopeFor(['src/**/*.css']);

    expect(isMatch('src/client/styles.css', scope)).toBe(false);
  });

  it('a MIXED extension group admits only its transformable members', () => {
    const scope = scopeFor(['src/**/*.{ts,tsx,css}']);

    expect(isMatch('src/client/util.ts', scope)).toBe(true);
    expect(isMatch('src/client/App.tsx', scope)).toBe(true);
    expect(isMatch('src/client/styles.css', scope)).toBe(false);
  });

  it('a broad REGEXP claim is intersected too', () => {
    const scope = scopeFor([/src\/client\/.*/]);

    expect(isMatch('src/client/App.tsx', scope)).toBe(true);
    expect(isMatch('src/client/styles.css', scope)).toBe(false);
    expect(isMatch('src/client/index.html', scope)).toBe(false);
  });

  it('a bare directory claim is narrowed', () => {
    const scope = scopeFor(['src/client']);

    expect(isMatch('src/client/App.tsx', scope)).toBe(true);
    expect(isMatch('src/client/styles.css', scope)).toBe(false);
  });

  it('narrowToTransformableScope leaves already-specific claims and RegExp shapes untouched', () => {
    const re = /\.tsx$/;

    expect(narrowToTransformableScope(['src/**/*.ts'])).toEqual(['src/**/*.ts']);
    expect(narrowToTransformableScope(['taujs.config.ts'])).toEqual(['taujs.config.ts']);
    expect(narrowToTransformableScope([re])).toEqual([re]);
  });

  it('the exclusion is the genuine complement of plugin-react default /\\.[tj]sx?$/', () => {
    expect([...REACT_TRANSFORMABLE_EXTENSIONS]).toEqual(['js', 'jsx', 'ts', 'tsx']);

    // Excluded: assets, extensionless paths and unusual suffixes alike.
    for (const p of ['/a/b.css', '/a/extensionless', '/a/file.foo-bar', '/a/x.mjs', '/a/x.cjs', '/a/x.mts', '/a/x.cts']) {
      expect(NON_TRANSFORMABLE_EXCLUDE.test(p)).toBe(true);
    }
    // Admitted: exactly what plugin-react transforms.
    for (const p of ['/a/b.tsx', '/a/b.ts', '/a/b.jsx', '/a/b.js']) {
      expect(NON_TRANSFORMABLE_EXCLUDE.test(p)).toBe(false);
    }
  });
});
