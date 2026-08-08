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
    // VS8: `appType` protected in build too (§4 matrix lists it Protected in all columns), matching dev.
    expect(BUILD_PROFILE.protectedTop).toEqual(expect.arrayContaining(['root', 'base', 'publicDir', 'configFile', 'appType']));
    // A build has no dev server, so `server` never reaches a build config - SILENTLY, like
    // `optimizeDeps`, because the same `config.vite` declaration also feeds the dev server.
    expect(BUILD_PROFILE.admitServer).toBe(false);

    expect(DEV_PROFILE.admitBuild).toBe(false);
    // VS4 ruling: dev protects `base`/`publicDir` too (matrix Protected in all columns).
    expect(DEV_PROFILE.protectedTop).toEqual(expect.arrayContaining(['root', 'base', 'publicDir', 'configFile', 'appType']));
    // Dev admits exactly ONE `server` field. Rejecting the whole key is what made `allowedHosts`
    // inexpressible, and with it development behind a proxy.
    expect(DEV_PROFILE.admitServer).toBe(true);
    // An ALLOWLIST of one. `ws` would disable the HMR channel the framework owns, and
    // `host`/`port`/`https` configure a listener Vite does not have in middleware mode.
    expect(DEV_PROFILE.admittedServer).toEqual(['allowedHosts']);
    expect(DEV_PROFILE.protectedTop).not.toContain('server');
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
            appType: 'custom',
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
      'appType',
      'build.outDir',
      'build.manifest',
      'build.ssrManifest',
      'build.rollupOptions.input',
      'resolve.alias',
    ]) {
      expect(msg).toContain(field);
    }

    // `server` is NOT among them any more: it is a supported dev-only surface, silently absent from
    // builds rather than reported as a rejected override.
    expect(msg).not.toContain('server');

    // VS8: the smuggled build-side `appType` is warned and never applied (not silently dropped).
    expect((merged as any).appType).toBeUndefined();

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

  it('strips server from the composed build config SILENTLY, exactly like optimizeDeps', () => {
    const warn = spyWarn();

    // `config.vite` is the SHARED surface: the same declaration feeds the dev server and every app
    // build. Warning here would make the documented dev-only `allowedHosts` recipe report itself as
    // misuse once per app on every build, which is why this is silent rather than protected.
    const merged = composeViteConfig(
      buildFramework(),
      [{ source: 'config.vite', config: { server: { allowedHosts: ['app.internal'] } } as any }],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect((merged as any).server).toBeUndefined();

    const warned = warn.mock.calls.map(([m]) => String(m)).join('\n');
    expect(warned).not.toContain('server');

    warn.mockRestore();
  });

  it('is silent for the build-only escape hatch too - one rule, whichever layer supplied it', () => {
    const warn = spyWarn();

    // `taujsBuild({ vite })` is explicitly build-only, and takes a WIDER type (`Partial<InlineConfig>`)
    // than `config.vite`, so `server` is reachable there without any cast. It is still silent, on
    // the same rule rather than a special case: dev-only fields are stripped from builds by their
    // own semantics, not by which layer supplied them - exactly as `optimizeDeps` already behaves.
    const merged = composeViteConfig(
      buildFramework(),
      [{ source: 'taujsBuild.vite', config: { server: { allowedHosts: ['app.internal'] } } as any }],
      BUILD_PROFILE,
      '[taujs:build:admin]',
    );

    expect((merged as any).server).toBeUndefined();
    expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).not.toContain('server');

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

// RFC 0013 prerequisite - the Vite 8 chunking migration. Vite 8 removed the Rollup OBJECT form
// of `manualChunks` and Rolldown documents the option as deprecated in favour of
// `output.codeSplitting`. τjs keeps the function form as a deprecated migration surface, adds
// the canonical path, rejects the object form at the boundary, and refuses to pick a silent
// winner when both paths are declared.
describe('ViteMergeEngine - Vite 8 chunking migration (RFC 0013 prerequisite)', () => {
  const chunkFn = (id: string) => (id.includes('node_modules') ? 'vendor' : null);

  it('accepts the FUNCTION form of manualChunks and passes it through to Vite', () => {
    const layers: ViteLayer[] = [{ source: 'config.vite', config: { build: { rollupOptions: { output: { manualChunks: chunkFn } } } } as any }];

    const merged = composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]');
    const output = (merged.build as any).rollupOptions.output;

    expect((Array.isArray(output) ? output[0] : output).manualChunks).toBe(chunkFn);
  });

  it('REJECTS the former object form at the configuration boundary, before Vite runs', () => {
    // The object form only reaches here by a cast or from plain JS - the type surface already
    // forbids it - so the runtime guard is what protects a JS consumer.
    const layers: ViteLayer[] = [{ source: 'config.vite', config: { build: { rollupOptions: { output: { manualChunks: { vendor: ['react'] } } } } } as any }];

    expect(() => composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]')).toThrow(
      /manualChunks: the object form is no longer supported/,
    );
    expect(() => composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]')).toThrow(/codeSplitting/);
  });

  it('accepts the canonical codeSplitting path', () => {
    const codeSplitting = { groups: [{ name: 'vendor', test: /node_modules/ }] };
    const layers: ViteLayer[] = [{ source: 'config.vite', config: { build: { rolldownOptions: { output: { codeSplitting } } } } as any }];

    const merged = composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]');

    // Declared canonically, composed into the single options slot Vite actually reads: Vite 8
    // treats rollupOptions/rolldownOptions as ONE aliased slot, so writing a separate key would
    // wipe the framework's `input` invariant (measured).
    const out = (merged.build as any).rollupOptions.output;
    expect((Array.isArray(out) ? out[0] : out).codeSplitting).toEqual(codeSplitting);
    expect((merged.build as any).rollupOptions.input).toBeDefined();
  });

  it('FAILS when both paths survive composition, whichever is declared first', () => {
    const manual = { source: 'config.vite', config: { build: { rollupOptions: { output: { manualChunks: chunkFn } } } } } as unknown as ViteLayer;
    const canonical = { source: 'taujsBuild.vite', config: { build: { rolldownOptions: { output: { codeSplitting: true } } } } } as unknown as ViteLayer;

    // ONE layer declaring BOTH paths - the promised same-layer case.
    const both = {
      source: 'config.vite',
      config: { build: { rollupOptions: { output: { manualChunks: chunkFn } }, rolldownOptions: { output: { codeSplitting: true } } } },
    } as unknown as ViteLayer;

    // Same layer, and both cross-layer orders: the error is stable and names BOTH paths.
    for (const layers of [[both], [manual, canonical], [canonical, manual]] as ViteLayer[][]) {
      expect(() => composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]')).toThrow(/chunking is configured twice/);
      expect(() => composeViteConfig(buildFramework(), layers, BUILD_PROFILE, '[taujs:build:admin]')).toThrow(
        /build\.rollupOptions\.output\.manualChunks[\s\S]*build\.rolldownOptions\.output\.codeSplitting/,
      );
    }
  });

  it('retains ordinary same-path precedence for each option INDEPENDENTLY', () => {
    const first = (id: string) => (id.includes('a') ? 'a' : null);
    const second = (id: string) => (id.includes('b') ? 'b' : null);
    spyWarn();

    const manualLayers: ViteLayer[] = [
      { source: 'config.vite', config: { build: { rollupOptions: { output: { manualChunks: first } } } } as any },
      { source: 'taujsBuild.vite', config: { build: { rollupOptions: { output: { manualChunks: second } } } } as any },
    ];
    const mergedManual = composeViteConfig(buildFramework(), manualLayers, BUILD_PROFILE, '[taujs:build:admin]');
    const out = (mergedManual.build as any).rollupOptions.output;
    expect((Array.isArray(out) ? out[0] : out).manualChunks).toBe(second);

    const splitLayers: ViteLayer[] = [
      { source: 'config.vite', config: { build: { rolldownOptions: { output: { codeSplitting: false } } } } as any },
      { source: 'taujsBuild.vite', config: { build: { rolldownOptions: { output: { codeSplitting: true } } } } as any },
    ];
    const mergedSplit = composeViteConfig(buildFramework(), splitLayers, BUILD_PROFILE, '[taujs:build:admin]');
    const splitOut = (mergedSplit.build as any).rollupOptions.output;
    expect((Array.isArray(splitOut) ? splitOut[0] : splitOut).codeSplitting).toBe(true);
  });
});
