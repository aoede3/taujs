import { describe, it, expect, vi } from 'vitest';
import type { InlineConfig } from 'vite';

import { BUILD_PROFILE, DEV_PROFILE, composeViteConfig, getFrameworkInvariants, mergeOptimizeDeps, normalisePlugins } from '../utils/ViteMergeEngine';
import type { ViteLayer } from '../utils/ViteMergeEngine';

const buildFramework = (): InlineConfig => ({
  root: '/app/src/client/admin',
  base: '/admin/',
  publicDir: 'public',
  configFile: false,
  build: {
    outDir: '/app/dist/client/admin',
    manifest: true,
    ssrManifest: false,
    rollupOptions: { input: { client: '/app/src/client/admin/entry-client.tsx' } },
  },
  css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
  plugins: [{ name: 'framework-plugin' }],
  resolve: { alias: { '@client': '/app/src/client/admin' } },
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const pluginNames = (config: InlineConfig): string[] => (config.plugins as { name: string }[]).map((p) => p.name);

describe('ViteMergeEngine - profiles (declared data)', () => {
  it('BUILD_PROFILE protects manifest and configFile explicitly; DEV_PROFILE rejects build.*', () => {
    expect(BUILD_PROFILE.admitBuild).toBe(true);
    expect(BUILD_PROFILE.protectedBuild).toContain('manifest');
    expect(BUILD_PROFILE.protectedTop).toEqual(expect.arrayContaining(['root', 'base', 'publicDir', 'configFile', 'server']));

    expect(DEV_PROFILE.admitBuild).toBe(false);
    // VS4 ruling: dev protects `base`/`publicDir` too (matrix Protected in all columns).
    expect(DEV_PROFILE.protectedTop).toEqual(expect.arrayContaining(['root', 'base', 'publicDir', 'configFile', 'server', 'appType']));
  });

  it('normalisePlugins and getFrameworkInvariants remain reachable from the engine', () => {
    expect(normalisePlugins(undefined)).toEqual([]);
    expect(normalisePlugins({ name: 'x' })).toEqual([{ name: 'x' }]);
    expect(getFrameworkInvariants({} as InlineConfig).base).toBe('/');
  });
});

describe('ViteMergeEngine - composeViteConfig (build profile)', () => {
  it('layers declarative {plugins, define, css} + programmatic {build.sourcemap}: all survive (RFC §2 CI-wrapper regression)', () => {
    const warn = spyWarn();

    const layers: ViteLayer[] = [
      {
        source: 'config.vite',
        config: {
          plugins: [{ name: 'declarative-plugin' }],
          define: { __DECLARED__: '"yes"' },
          css: { preprocessorOptions: { scss: { additionalData: '@import "vars";' } } },
        },
      },
      { source: 'taujsBuild.vite', config: { build: { sourcemap: true } } },
    ];

    const merged = composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]');

    // Every declarative field survives alongside the programmatic override.
    expect(pluginNames(merged)).toEqual(['framework-plugin', 'declarative-plugin']);
    expect(merged.define).toMatchObject({ __DECLARED__: '"yes"' });
    expect(merged.css?.preprocessorOptions?.scss).toEqual({ api: 'modern-compiler', additionalData: '@import "vars";' });
    expect((merged.build as any).sourcemap).toBe(true);

    // Coexistence of two user layers on disjoint fields is silent.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('per-field conflict: both layers set define.X -> programmatic wins, warn names the field and both layers', () => {
    const warn = spyWarn();

    const merged = composeViteConfig(
      buildFramework(),
      [
        { source: 'config.vite', config: { define: { __X__: '"declarative"' } } },
        { source: 'taujsBuild.vite', config: { define: { __X__: '"programmatic"' } } },
      ],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect((merged.define as Record<string, unknown>).__X__).toBe('"programmatic"');

    const conflictLine = warn.mock.calls.map(([m]) => m as string).find((m) => m.includes('define.__X__'));
    expect(conflictLine).toBeDefined();
    expect(conflictLine).toContain('config.vite');
    expect(conflictLine).toContain('taujsBuild.vite');
    expect(conflictLine).toContain('taujsBuild.vite wins');

    warn.mockRestore();
  });

  it('no conflict warning when the two layers touch disjoint fields', () => {
    const warn = spyWarn();

    composeViteConfig(
      buildFramework(),
      [
        { source: 'config.vite', config: { define: { __A__: '1' } } },
        { source: 'taujsBuild.vite', config: { define: { __B__: '2' } } },
      ],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn when a user layer merely overrides a FRAMEWORK default (not another user layer)', () => {
    const warn = spyWarn();

    const merged = composeViteConfig(
      buildFramework(),
      [{ source: 'config.vite', config: { css: { preprocessorOptions: { scss: { api: 'legacy' as any } } } } }],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect(merged.css?.preprocessorOptions?.scss).toEqual({ api: 'legacy' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects every protected field a user layer supplies - including build.manifest (newly aligned) and configFile', () => {
    const warn = spyWarn();

    const merged = composeViteConfig(
      buildFramework(),
      [
        {
          source: 'taujsBuild.vite',
          config: {
            root: '/wrong',
            base: '/wrong/',
            publicDir: '/wrong',
            configFile: '/wrong/vite.config.ts',
            server: { port: 3000 },
            build: {
              outDir: '/wrong',
              manifest: false,
              ssrManifest: true,
              rollupOptions: { input: { wrong: '/wrong.ts' } },
            },
            resolve: { alias: { '@wrong': '/wrong' } },
          } as any,
        },
      ],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    const msg = warn.mock.calls.map(([m]) => m as string).find((m) => m.includes('Ignored Vite config overrides'));
    expect(msg).toBeDefined();
    for (const field of [
      'root',
      'base',
      'publicDir',
      'configFile',
      'server',
      'build.outDir',
      'build.manifest',
      'build.ssrManifest',
      'build.rollupOptions.input',
      'resolve.alias',
    ]) {
      expect(msg).toContain(field);
    }

    // Framework invariants win: manifest and configFile restored, protected values never applied.
    expect((merged.build as any).manifest).toBe(true);
    expect(merged.configFile).toBe(false);
    expect(merged.root).toBe('/app/src/client/admin');
    expect((merged.build as any).outDir).toBe('/app/dist/client/admin');
    expect((merged.resolve as any).alias).not.toHaveProperty('@wrong');

    warn.mockRestore();
  });

  it('strips optimizeDeps from the composed build config (dev-only, RFC §6)', () => {
    const warn = spyWarn();

    const merged = composeViteConfig(
      buildFramework(),
      [{ source: 'config.vite', config: { optimizeDeps: { include: ['lodash'] } } as any }],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect((merged as any).optimizeDeps).toBeUndefined();
    warn.mockRestore();
  });
});

describe('ViteMergeEngine - composeViteConfig (dev profile)', () => {
  it('rejects the whole build key in dev (build.* not admitted) and restores no build invariants', () => {
    const warn = spyWarn();

    const merged = composeViteConfig(
      { appType: 'custom' } as InlineConfig,
      [{ source: 'config.vite', config: { build: { sourcemap: true } } }],
      DEV_PROFILE,
      '[taujs:dev]',
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('build'));
    expect((merged.build as any)?.sourcemap).toBeUndefined();
    // No build-output invariants injected in dev.
    expect((merged.build as any).outDir).toBeUndefined();
    warn.mockRestore();
  });
});

describe('ViteMergeEngine - mergeOptimizeDeps (RFC §6)', () => {
  it('returns undefined when no layer supplies optimizeDeps', () => {
    expect(mergeOptimizeDeps([{ source: 'config.vite' }, { source: 'taujsBuild.vite' }])).toBeUndefined();
  });

  it('deduplicates include/exclude across layers', () => {
    const merged = mergeOptimizeDeps([
      { source: 'a', optimizeDeps: { include: ['x', 'y'], exclude: ['p'] } },
      { source: 'b', optimizeDeps: { include: ['y', 'z'], exclude: ['p', 'q'] } },
    ]);

    expect(merged).toEqual({ include: ['x', 'y', 'z'], exclude: ['p', 'q'] });
  });

  it('throws a config-validation error naming the package when it appears in both include and exclude', () => {
    expect(() =>
      mergeOptimizeDeps([
        { source: 'config.vite', optimizeDeps: { include: ['react'] } },
        { source: 'taujsBuild.vite', optimizeDeps: { exclude: ['react'] } },
      ]),
    ).toThrow(/react/);

    // Also within a single layer.
    expect(() => mergeOptimizeDeps([{ source: 'config.vite', optimizeDeps: { include: ['left-pad'], exclude: ['left-pad'] } }])).toThrow(/left-pad/);
  });

  it('appends esbuildOptions.plugins from two layers, never overwriting, and merges other esbuild options', () => {
    const merged = mergeOptimizeDeps([
      { source: 'a', optimizeDeps: { esbuildOptions: { plugins: [{ name: 'e1' }], target: 'es2019' } as any } },
      { source: 'b', optimizeDeps: { esbuildOptions: { plugins: [{ name: 'e2' }] } as any } },
    ]);

    expect((merged!.esbuildOptions as any).plugins.map((p: any) => p.name)).toEqual(['e1', 'e2']);
    expect((merged!.esbuildOptions as any).target).toBe('es2019');
  });
});
