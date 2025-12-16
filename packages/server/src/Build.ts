/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { build } from 'vite';

import { TEMPLATE } from './constants';
import { extractBuildConfigs } from './Setup';
import { processConfigs } from './utils/AssetManager';

import type { InlineConfig, PluginOption } from 'vite';
import type { AppConfig } from './Config';

export type ViteBuildContext = {
  appId: string;
  entryPoint: string;
  isSSRBuild: boolean;
  clientRoot: string;
};

export function resolveInputs(isSSRBuild: boolean, mainExists: boolean, paths: { server: string; client: string; main: string }): Record<string, string> {
  if (isSSRBuild) return { server: paths.server };
  if (mainExists) return { client: paths.client, main: paths.main };

  return { client: paths.client };
}

/**
 * User-supplied vite config override.
 * Can be a static config object or a function that receives build context.
 *
 * **Plugin order**: Framework applies plugins in this sequence:
 * 1. `appConfig.plugins` (from taujs.config.ts)
 * 2. `nodePolyfills({ include: ['stream'] })` (client builds only)
 * 3. `userViteConfig.plugins` (from this option)
 *
 * If you need plugins before nodePolyfills, add them to `appConfig.plugins` instead.
 *
 * **Allowed customisations:**
 * - `plugins`: Appended to framework plugin list
 * - `define`: Shallow-merged with framework defines
 * - `css.preprocessorOptions`: Deep-merged by preprocessor engine (scss, less, etc.)
 * - `build.sourcemap`, `minify`, `terserOptions`: Direct overrides
 * - `build.rollupOptions.external`: Direct override
 * - `build.rollupOptions.output.manualChunks`: Merged into output config
 * - `resolve.*` (except `alias`): Merged with framework resolve config
 * - `esbuild`, `logLevel`, `optimizeDeps`: Direct overrides
 *
 * **Protected fields (cannot override):**
 * - `root`, `base`, `publicDir`: Framework-controlled per-app paths
 * - `build.outDir`: Framework manages `dist/client` vs `dist/ssr` separation
 * - `build.ssr`, `ssrManifest`, `format`, `target`: Framework-controlled for SSR integrity
 * - `build.rollupOptions.input`: Framework manages entry points
 * - `resolve.alias`: Use top-level `alias` option in taujsBuild() instead
 * - `server.*`: Ignored in builds (dev-mode only; configure in DevServer.ts)
 *
 * @example
 * ```ts
 * // Static config
 * vite: {
 *   plugins: [visualizer()],
 *   build: { sourcemap: 'inline' }
 * }
 *
 * // Function-based (conditional per app/mode)
 * vite: ({ isSSRBuild, entryPoint }) => ({
 *   plugins: isSSRBuild ? [] : [visualizer()],
 *   logLevel: entryPoint === 'admin' ? 'info' : 'warn'
 * })
 * ```
 */
export type ViteConfigOverride = Partial<InlineConfig> | ((ctx: ViteBuildContext) => Partial<InlineConfig>);

/**
 * Core invariants for τjs builds.
 * These fields are non-negotiable to maintain framework integrity.
 */
type FrameworkInvariant = {
  root: string;
  base: string;
  publicDir: string | false;
  build: {
    outDir: string;
    manifest: boolean;
    ssr?: any; // Preserve exact type (string | boolean)
    ssrManifest: boolean;
    format?: string;
    target?: string | string[];
    rollupOptions: {
      input: Record<string, string>;
    };
  };
};

/**
 * Extract and validate framework invariants from config.
 * Used during merge to ensure user config doesn't violate critical paths.
 */
export function getFrameworkInvariants(config: InlineConfig): FrameworkInvariant {
  return {
    root: config.root || '',
    base: config.base || '/',
    publicDir: config.publicDir === undefined ? 'public' : (config.publicDir as string | false),
    build: {
      outDir: (config.build?.outDir as string) || '',
      manifest: (config.build?.manifest as boolean) ?? false,
      ssr: (config.build?.ssr as any) ?? undefined, // Preserve exact type
      ssrManifest: (config.build?.ssrManifest as boolean) ?? false,
      format: (config.build as any)?.format,
      target: (config.build as any)?.target,
      rollupOptions: {
        input: (config.build?.rollupOptions?.input as Record<string, string>) || {},
      },
    },
  };
}

/**
 * Merge user vite config into framework config with explicit guardrails.
 *
 * Strategy:
 * 1. Preserve all framework invariants (root, base, outDir, ssr, ssrManifest, input)
 * 2. Deep-merge safe extension points (plugins, define, css.preprocessorOptions)
 * 3. Allow selective overrides for tuning (sourcemap, minify, external, etc.)
 * 4. Reject or ignore unsafe overrides (alias, server, build paths)
 *
 * Returns a config safe to pass directly to vite.build().
 */
export function mergeViteConfig(framework: InlineConfig, userOverride?: ViteConfigOverride, context?: ViteBuildContext): InlineConfig {
  if (!userOverride) return framework;

  // Resolve user config (function or static)
  const userConfig: Partial<InlineConfig> = typeof userOverride === 'function' && context ? userOverride(context) : (userOverride as Partial<InlineConfig>);

  const invariants = getFrameworkInvariants(framework);

  // Targeted shallow clone (plugins/define/functions can't be deep-cloned with structuredClone)
  const merged: InlineConfig = {
    ...framework,
    build: { ...(framework.build ?? {}) },
    css: { ...(framework.css ?? {}) },
    resolve: { ...(framework.resolve ?? {}) },
    plugins: [...(framework.plugins ?? [])],
    define: { ...(framework.define ?? {}) },
  };

  // Track ignored user overrides for warnings
  const ignoredKeys: string[] = [];

  // Extension Point 1: Plugins (append)
  if (userConfig.plugins) {
    const frameworkPlugins = merged.plugins as PluginOption[];
    merged.plugins = [...frameworkPlugins, ...userConfig.plugins];
  }

  // Extension Point 2: Define (shallow merge, user wins)
  if (userConfig.define && typeof userConfig.define === 'object') {
    merged.define = {
      ...merged.define,
      ...userConfig.define,
    };
  }

  // Extension Point 3: CSS preprocessor options (deep merge by engine)
  if (userConfig.css?.preprocessorOptions && typeof userConfig.css.preprocessorOptions === 'object') {
    const fpp = merged.css!.preprocessorOptions ?? {};
    const upp = userConfig.css.preprocessorOptions;

    merged.css!.preprocessorOptions = Object.keys({ ...fpp, ...upp }).reduce((acc, engine) => {
      const fppEngine = (fpp as any)[engine];
      const uppEngine = (upp as any)[engine];
      (acc as any)[engine] = { ...(fppEngine ?? {}), ...(uppEngine ?? {}) };

      return acc;
    }, {} as any);
  }

  // Tuning Point 1: Build.sourcemap, minify, terserOptions
  if (userConfig.build) {
    // Warn if user tried to set protected build fields
    const protectedBuildFields = ['outDir', 'ssr', 'ssrManifest', 'format', 'target'];
    for (const field of protectedBuildFields) {
      if (field in userConfig.build) {
        ignoredKeys.push(`build.${field}`);
      }
    }

    // sourcemap: allow any value (true, false, 'inline', etc.)
    if ('sourcemap' in userConfig.build) (merged.build as any).sourcemap = (userConfig.build as any).sourcemap;

    // minify: allow any value (true, false, 'terser', 'esbuild', etc.)
    if ('minify' in userConfig.build) (merged.build as any).minify = (userConfig.build as any).minify;

    // terserOptions: shallow merge with our defaults
    if ((userConfig.build as any).terserOptions && typeof (userConfig.build as any).terserOptions === 'object') {
      (merged.build as any).terserOptions = {
        ...((merged.build as any).terserOptions ?? {}),
        ...(userConfig.build as any).terserOptions,
      };
    }

    // rollupOptions.external and output.manualChunks (chunking strategy)
    if ((userConfig.build as any).rollupOptions) {
      if (!(merged.build as any).rollupOptions) {
        (merged.build as any).rollupOptions = {};
      }

      const userRollup = (userConfig.build as any).rollupOptions;

      if ('input' in userRollup) ignoredKeys.push('build.rollupOptions.input');

      if ('external' in userRollup) ((merged.build as any).rollupOptions as any).external = userRollup.external;

      // Simplified output handling: normalise to single object, merge manualChunks only
      if (userRollup.output) {
        const mro: any = ((merged.build as any).rollupOptions ??= {});
        const uo = Array.isArray(userRollup.output) ? userRollup.output[0] : userRollup.output;
        const baseOut = Array.isArray(mro.output) ? (mro.output[0] ?? {}) : (mro.output ?? {});

        mro.output = { ...baseOut, ...(uo?.manualChunks ? { manualChunks: uo.manualChunks } : {}) };
      }
    }
  }

  // Tuning Point 2: resolve (but NOT alias)
  if (userConfig.resolve) {
    const userResolve = userConfig.resolve as any;
    // Strip out 'alias' key - controlled by top-level option
    const { alias: _ignore, ...resolveRest } = userResolve;

    if (_ignore) ignoredKeys.push('resolve.alias');

    merged.resolve = {
      ...merged.resolve,
      ...resolveRest,
    };
  }

  // Warn if user tried to set server config (dev-only, ignored in build)
  if (userConfig.server) ignoredKeys.push('server (ignored in build; dev-only)');

  // Warn if user tried to set protected top-level fields
  if ('root' in userConfig) ignoredKeys.push('root');
  if ('base' in userConfig) ignoredKeys.push('base');
  if ('publicDir' in userConfig) ignoredKeys.push('publicDir');

  // Tuning Point 3: Safe top-level fields (esbuild, logLevel, etc.)
  const safeTopLevelKeys = new Set([
    'esbuild',
    'logLevel',
    'envPrefix',
    'optimizeDeps',
    'ssr',
    // NOTE: NOT 'server' (build-time irrelevant; dev-server only)
  ]);

  for (const [key, value] of Object.entries(userConfig)) {
    if (safeTopLevelKeys.has(key)) (merged as any)[key] = value;
  }

  // GUARANTEE: Restore framework invariants (cannot be overridden)
  (merged as any).root = invariants.root;
  (merged as any).base = invariants.base;
  (merged as any).publicDir = invariants.publicDir;

  (merged.build as any).outDir = invariants.build.outDir;
  (merged.build as any).manifest = invariants.build.manifest;

  if (invariants.build.ssr !== undefined) (merged.build as any).ssr = invariants.build.ssr;

  (merged.build as any).ssrManifest = invariants.build.ssrManifest;

  if (invariants.build.format) (merged.build as any).format = invariants.build.format;

  if (invariants.build.target) (merged.build as any).target = invariants.build.target;

  if (!(merged.build as any).rollupOptions) (merged.build as any).rollupOptions = {};

  ((merged.build as any).rollupOptions as any).input = invariants.build.rollupOptions.input;

  // WARN: User attempted to override protected fields
  if (ignoredKeys.length > 0) {
    const uniqueKeys = [...new Set(ignoredKeys)];
    const prefix = context ? `[taujs:build:${context.entryPoint}]` : '[taujs:build]';
    console.warn(`${prefix} Ignored Vite config overrides: ${uniqueKeys.join(', ')}`);
  }

  return merged;
}

type AppFilter = {
  selectedIds: Set<string> | null;
  raw: string | undefined;
};

export function resolveAppFilter(argv: readonly string[], env: NodeJS.ProcessEnv): AppFilter {
  const read = (keys: readonly string[]): string | undefined => {
    const end = argv.indexOf('--');
    const limit = end === -1 ? argv.length : end;

    for (let i = 0; i < limit; i++) {
      const arg = argv[i];

      if (!arg) continue;

      for (const key of keys) {
        if (arg === key) {
          const next = argv[i + 1];
          if (!next || next.startsWith('-')) return '';
          return next.trim();
        }

        const pref = `${key}=`;
        if (arg.startsWith(pref)) {
          const v = arg.slice(pref.length).trim();
          return v;
        }
      }
    }

    return undefined;
  };

  // env first, CLI overrides
  const envFilter = env.TAUJS_APP || env.TAUJS_APPS;
  const cliFilter = read(['--app', '--apps', '-a']);
  const raw = (cliFilter ?? envFilter)?.trim() || undefined;

  if (!raw) return { selectedIds: null, raw: undefined };

  const selectedIds = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return { selectedIds, raw };
}

export async function taujsBuild({
  config,
  projectRoot,
  clientBaseDir,
  isSSRBuild = process.env.BUILD_MODE === 'ssr',
  alias: userAlias,
  vite: userViteConfig,
}: {
  config: { apps: readonly AppConfig[] };
  projectRoot: string;
  clientBaseDir: string;
  isSSRBuild?: boolean;
  /**
   * Top-level alias overrides. Use this instead of `vite.resolve.alias`.
   * User aliases are merged with framework defaults; user values win on conflicts.
   *
   * Framework provides:
   * - `@client`: Resolves to current app's root
   * - `@server`: Resolves to `src/server`
   * - `@shared`: Resolves to `src/shared`
   *
   * @example
   * ```ts
   * alias: {
   *   '@utils': './src/utils',
   *   '@server': './custom-server', // overrides framework default
   * }
   * ```
   */
  alias?: Record<string, string>;
  /** User-supplied Vite config overrides (plugins, tuning, etc.) */
  vite?: ViteConfigOverride;
}) {
  const deleteDist = async () => {
    const { rm } = await import('node:fs/promises');
    const distPath = path.resolve(projectRoot, 'dist');
    try {
      await rm(distPath, { recursive: true, force: true });
      console.log('Deleted the dist directory\n');
    } catch (err) {
      console.error('Error deleting dist directory:', err);
    }
  };

  const extractedConfigs = extractBuildConfigs(config);
  const processedConfigs = processConfigs(extractedConfigs, clientBaseDir, TEMPLATE);

  const { selectedIds, raw: appFilterRaw } = resolveAppFilter(process.argv.slice(2), process.env);

  const configsToBuild = selectedIds
    ? processedConfigs.filter(({ appId, entryPoint }) => selectedIds.has(appId) || selectedIds.has(entryPoint))
    : processedConfigs;

  if (selectedIds && configsToBuild.length === 0) {
    console.error(
      `[taujs:build] No apps match filter "${appFilterRaw}".` +
        ` Known apps: ${processedConfigs.map((c) => `${c.appId}${c.entryPoint ? ` (entry: ${c.entryPoint})` : ''}`).join(', ')}`,
    );
    process.exit(1);
  }

  if (!isSSRBuild) await deleteDist();

  for (const appConfig of configsToBuild) {
    const { appId, entryPoint, clientRoot, entryClientFile, entryServerFile, htmlTemplate, plugins = [] } = appConfig;

    const outDir = path.resolve(projectRoot, isSSRBuild ? `dist/ssr/${entryPoint}` : `dist/client/${entryPoint}`);
    const root = entryPoint ? path.resolve(clientBaseDir, entryPoint) : clientBaseDir;

    const defaultAlias: Record<string, string> = {
      '@client': root,
      '@server': path.resolve(projectRoot, 'src/server'),
      '@shared': path.resolve(projectRoot, 'src/shared'),
    };

    const resolvedAlias: Record<string, string> = { ...defaultAlias, ...(userAlias ?? {}) };

    const server = path.resolve(clientRoot, entryServerFile);
    const client = path.resolve(clientRoot, entryClientFile);
    const main = path.resolve(clientRoot, htmlTemplate);

    const inputs = resolveInputs(isSSRBuild, !isSSRBuild && existsSync(main), { server, client, main });

    const nodeVersion = process.versions.node.split('.')[0];

    const frameworkConfig: InlineConfig = {
      base: entryPoint ? `/${entryPoint}/` : '/',
      build: {
        outDir,
        emptyOutDir: true,
        manifest: !isSSRBuild,
        rollupOptions: {
          input: inputs,
        },
        ssr: isSSRBuild ? server : undefined,
        ssrManifest: isSSRBuild,
        ...(isSSRBuild && {
          format: 'esm',
          target: `node${nodeVersion}`,
          copyPublicDir: false,
        }),
      },
      css: {
        preprocessorOptions: {
          scss: { api: 'modern-compiler' },
        },
      },
      plugins: plugins as PluginOption[],
      publicDir: isSSRBuild ? false : 'public',
      resolve: { alias: resolvedAlias },
      root,
    };

    const buildContext: ViteBuildContext = {
      appId,
      entryPoint,
      isSSRBuild,
      clientRoot,
    };

    const finalConfig = mergeViteConfig(frameworkConfig, userViteConfig, buildContext);

    try {
      const mode = isSSRBuild ? 'SSR' : 'Client';
      console.log(`[taujs:build:${entryPoint}] Building → ${mode}`);
      await build(finalConfig);
      console.log(`[taujs:build:${entryPoint}] ✓ Complete\n`);
    } catch (error) {
      console.error(`[taujs:build:${entryPoint}] ✗ Failed\n`, error);
      process.exit(1);
    }
  }
}
