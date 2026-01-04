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
import * as fs from 'node:fs';
import path from 'node:path';

import { build } from 'vite';

import { ENTRY_EXTENSIONS, TEMPLATE } from './constants';
import { extractBuildConfigs } from './core/config/Setup';
import { processConfigs } from './utils/AssetManager';

import type { InlineConfig, PluginOption } from 'vite';
import type { CoreAppConfig } from './core/config/types';

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

export function resolveEntryFile(clientRoot: string, stem: string, exists: (absPath: string) => boolean = fs.existsSync): string {
  for (const ext of ENTRY_EXTENSIONS) {
    const filename = `${stem}${ext}`;
    if (exists(path.join(clientRoot, filename))) return filename;
  }

  throw new Error(`Entry file "${stem}" not found in ${clientRoot}. Tried: ${ENTRY_EXTENSIONS.map((e) => stem + e).join(', ')}`);
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
export const normalisePlugins = (p: any): any[] => (Array.isArray(p) ? p : p ? [p] : []);

export function mergeViteConfig(framework: InlineConfig, userOverride?: ViteConfigOverride, context?: ViteBuildContext): InlineConfig {
  if (!userOverride) return framework;

  const userConfig: Partial<InlineConfig> = typeof userOverride === 'function' && context ? userOverride(context) : (userOverride as Partial<InlineConfig>);

  const invariants = getFrameworkInvariants(framework);

  const merged: InlineConfig = {
    ...framework,
    build: { ...(framework.build ?? {}) },
    css: { ...(framework.css ?? {}) },
    resolve: { ...(framework.resolve ?? {}) },
    plugins: [...(framework.plugins ?? [])],
    define: { ...(framework.define ?? {}) },
  };

  const ignoredKeys: string[] = [];

  if (userConfig.plugins) merged.plugins = [...normalisePlugins(merged.plugins), ...normalisePlugins(userConfig.plugins)];

  if (userConfig.define && typeof userConfig.define === 'object') merged.define = { ...merged.define, ...userConfig.define };

  if (userConfig.css?.preprocessorOptions) {
    const fpp = merged.css?.preprocessorOptions ?? {};
    const upp = userConfig.css.preprocessorOptions;

    merged.css ??= {};
    merged.css.preprocessorOptions ??= {};
    merged.css.preprocessorOptions = Object.keys({ ...fpp, ...upp }).reduce((acc, engine) => {
      (acc as any)[engine] = {
        ...(fpp as any)[engine],
        ...(upp as any)[engine],
      };
      return acc;
    }, {} as any);
  }

  if (userConfig.build) {
    const protectedBuildFields = ['outDir', 'ssr', 'ssrManifest', 'format', 'target'];

    for (const field of protectedBuildFields) {
      if (field in userConfig.build) ignoredKeys.push(`build.${field}`);
    }

    if ('sourcemap' in userConfig.build) (merged.build as any).sourcemap = (userConfig.build as any).sourcemap;

    if ('minify' in userConfig.build) (merged.build as any).minify = (userConfig.build as any).minify;

    if ((userConfig.build as any).terserOptions) {
      (merged.build as any).terserOptions = {
        ...(merged.build as any).terserOptions,
        ...(userConfig.build as any).terserOptions,
      };
    }

    if ((userConfig.build as any).rollupOptions) {
      const userRollup = (userConfig.build as any).rollupOptions;
      const ro = ((merged.build as any).rollupOptions ??= {});

      if ('input' in userRollup) ignoredKeys.push('build.rollupOptions.input');
      if ('external' in userRollup) ro.external = userRollup.external;

      if (userRollup.output) {
        const uo = Array.isArray(userRollup.output) ? userRollup.output[0] : userRollup.output;

        ro.output = {
          ...(Array.isArray(ro.output) ? ro.output[0] : ro.output),
          ...(uo?.manualChunks ? { manualChunks: uo.manualChunks } : {}),
        };
      }
    }
  }

  if (userConfig.resolve) {
    const { alias: _ignore, ...rest } = userConfig.resolve as any;
    if (_ignore) ignoredKeys.push('resolve.alias');
    merged.resolve = { ...merged.resolve, ...rest };
  }

  if (userConfig.server) ignoredKeys.push('server');
  if ('root' in userConfig) ignoredKeys.push('root');
  if ('base' in userConfig) ignoredKeys.push('base');
  if ('publicDir' in userConfig) ignoredKeys.push('publicDir');

  for (const key of ['esbuild', 'logLevel', 'envPrefix', 'optimizeDeps', 'ssr']) {
    if (key in userConfig) (merged as any)[key] = (userConfig as any)[key];
  }

  merged.root = invariants.root;
  merged.base = invariants.base;
  merged.publicDir = invariants.publicDir as any;

  (merged.build as any).outDir = invariants.build.outDir;
  (merged.build as any).manifest = invariants.build.manifest;

  (merged.build as any).ssr = invariants.build.ssr;
  (merged.build as any).ssrManifest = invariants.build.ssrManifest;
  (merged.build as any).format = invariants.build.format;
  (merged.build as any).target = invariants.build.target;

  if (invariants.build.ssr === undefined) delete (merged.build as any).ssr;
  if (invariants.build.format === undefined) delete (merged.build as any).format;
  if (invariants.build.target === undefined) delete (merged.build as any).target;

  ((merged.build as any).rollupOptions ??= {}).input = invariants.build.rollupOptions.input;

  if (ignoredKeys.length > 0) {
    const prefix = context ? `[taujs:build:${context.entryPoint}]` : '[taujs:build]';

    console.warn(`${prefix} Ignored Vite config overrides: ${[...new Set(ignoredKeys)].join(', ')}`);
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
  config: { apps: readonly CoreAppConfig[] };
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
    const { appId, entryPoint, clientRoot, entryClient, entryServer, htmlTemplate, plugins = [] } = appConfig;

    const outDir = path.resolve(projectRoot, isSSRBuild ? `dist/ssr/${entryPoint}` : `dist/client/${entryPoint}`);
    const root = entryPoint ? path.resolve(clientBaseDir, entryPoint) : clientBaseDir;

    const defaultAlias: Record<string, string> = {
      '@client': root,
      '@server': path.resolve(projectRoot, 'src/server'),
      '@shared': path.resolve(projectRoot, 'src/shared'),
    };

    const resolvedAlias: Record<string, string> = { ...defaultAlias, ...(userAlias ?? {}) };

    const entryClientFile = resolveEntryFile(clientRoot, entryClient);
    const entryServerFile = resolveEntryFile(clientRoot, entryServer);

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
