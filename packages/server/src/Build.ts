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
import { extractBuildConfigs } from './core/config/Setup';
import { emitGraphArtifact } from './core/introspection/EmitGraph';
import { processConfigs } from './utils/AssetManager';
import { resolveEntryFile } from './utils/Entry';
import { layerAlias } from './utils/ViteAlias';
import { findFormerlyDiscoveredViteConfig, formerlyDiscoveredViteConfigWarning } from './utils/ViteConfigDiscovery';
import { BUILD_PROFILE, composeViteConfig, getFrameworkInvariants, normalisePlugins } from './utils/ViteMergeEngine';

export { resolveEntryFile };
// Re-exported from the shared merge engine (VS3): these lived here historically and stay importable
// from `./Build` for existing consumers/tests. Their home is now `utils/ViteMergeEngine.ts`.
export { getFrameworkInvariants, normalisePlugins };
export type { FrameworkInvariant } from './utils/ViteMergeEngine';

import type { InlineConfig, PluginOption } from 'vite';
import type { ViteLayer } from './utils/ViteMergeEngine';
import type { CoreTaujsConfig } from './core/config/types';
import type { TaujsViteContext, TaujsViteOverride } from './ViteConfig';

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
 * Merge a single legacy `taujsBuild({ vite })` override into the framework config through the shared
 * build engine (VS3). Retained for backward compatibility and unit coverage; the multi-layer chain
 * (`config.vite` -> `taujsBuild.vite`) is composed in `taujsBuild` via {@link composeViteConfig}.
 *
 * Strategy is unchanged: framework invariants win, safe extension points (plugins, define,
 * css.preprocessorOptions) merge, tuning fields override, and protected fields are rejected with a
 * warning. `optimizeDeps` is dev-only and never reaches the returned build config.
 *
 * Returns a config safe to pass directly to vite.build().
 */
export function mergeViteConfig(framework: InlineConfig, userOverride?: ViteConfigOverride, context?: ViteBuildContext): InlineConfig {
  if (!userOverride) return framework;

  const userConfig: Partial<InlineConfig> = typeof userOverride === 'function' && context ? userOverride(context) : (userOverride as Partial<InlineConfig>);
  const prefix = context ? `[taujs:build:${context.entryPoint}]` : '[taujs:build]';

  return composeViteConfig(framework, [{ source: 'taujsBuild.vite', config: userConfig }], BUILD_PROFILE, prefix);
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
  // Widened from `CoreTaujsConfig` (VS3): `vite` lives on the `TaujsConfig` extension (Config.ts),
  // not the Vite-free core type. The intersection reads `config.vite` type-safely while staying
  // assignable from BOTH `CoreTaujsConfig` (extra optional field) and `TaujsConfig` (existing
  // callers, e.g. the scaffolded build.ts) - so no caller breaks.
  config: CoreTaujsConfig & { vite?: TaujsViteOverride };
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

    // RFC 0005 §3 (VS5): one shared alias layering - framework defaults, then declarative
    // `config.alias` (relative values normalised against projectRoot), then the programmatic
    // `taujsBuild({ alias })` option on top. Identical resolution to the dev side.
    const resolvedAlias = layerAlias({
      defaults: defaultAlias,
      declarative: config.alias,
      programmatic: userAlias,
      projectRoot,
      onDeclarativeOverride: (key) => console.debug(`[taujs:build:${entryPoint}] Programmatic alias '${key}' overrides declarative config.alias`),
    });

    const entryClientFile = resolveEntryFile(clientRoot, entryClient);
    const entryServerFile = resolveEntryFile(clientRoot, entryServer);

    const server = path.resolve(clientRoot, entryServerFile);
    const client = path.resolve(clientRoot, entryClientFile);

    const main = path.resolve(clientRoot, htmlTemplate);

    const inputs = resolveInputs(isSSRBuild, !isSSRBuild && existsSync(main), { server, client, main });

    const nodeVersion = process.versions.node.split('.')[0];

    // Migration detection: with configFile: false pinned below, Vite no longer probes this
    // per-entry root that it used to search on τjs's behalf. Warn if a vite.config.* still sits
    // there. Project-root files were never read and are exempt.
    const discovered = findFormerlyDiscoveredViteConfig(root);
    if (discovered) console.warn(`[taujs:build:${entryPoint}] ${formerlyDiscoveredViteConfigWarning(discovered)}`);

    const frameworkConfig: InlineConfig = {
      base: entryPoint ? `/${entryPoint}/` : '/',
      configFile: false,
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

    // Three-layer precedence chain (RFC 0005 §2): framework -> config.vite -> taujsBuild.vite.
    // Function forms resolve BEFORE merging - `config.vite` with the discriminated BUILD context arm
    // (the serve arm is VS4's dev-server job), the legacy `taujsBuild.vite` with `ViteBuildContext`.
    const layers: ViteLayer[] = [];

    if (config.vite) {
      const taujsViteContext: TaujsViteContext = {
        command: 'build',
        mode: 'production',
        isSSRBuild,
        appId,
        entryPoint,
        clientRoot,
      };
      const resolvedConfigVite = typeof config.vite === 'function' ? config.vite(taujsViteContext) : config.vite;
      if (resolvedConfigVite) layers.push({ source: 'config.vite', config: resolvedConfigVite as Partial<InlineConfig> });
    }

    if (userViteConfig) {
      const resolvedBuildVite = typeof userViteConfig === 'function' ? userViteConfig(buildContext) : userViteConfig;
      if (resolvedBuildVite) layers.push({ source: 'taujsBuild.vite', config: resolvedBuildVite as Partial<InlineConfig> });
    }

    const finalConfig = layers.length > 0 ? composeViteConfig(frameworkConfig, layers, BUILD_PROFILE, `[taujs:build:${entryPoint}]`) : frameworkConfig;

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

  // After successful builds only (failures exit above). No registry at build time, so the
  // emitted graph carries services: null — "registry unavailable", never "no services".
  await emitGraphArtifact(path.resolve(projectRoot, 'dist', '.taujs'), config, {
    source: 'build',
    logger: { warn: (meta?: unknown, message?: string) => console.warn(`[taujs:build] ${message ?? ''}`, meta) },
  });
}
