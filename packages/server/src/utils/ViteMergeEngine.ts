/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

/**
 * RFC 0005 (VS3): the shared Vite merge engine.
 *
 * One engine, two invariant profiles (dev/build), one precedence chain:
 * `framework -> config.vite -> taujsBuild.vite`. The protected-field sets are DECLARED DATA
 * (`BUILD_PROFILE`/`DEV_PROFILE`), not inline conditionals, so dev (VS4) and build read the same
 * merge/protection semantics from a single place. Programmatic layers win FIELD conflicts while
 * unrelated declarative fields survive; conflicts between two USER layers are surfaced per field at
 * warn level (mere coexistence is silent). Framework defaults being overridden by a user layer is
 * normal operation and never warns.
 */
import type { InlineConfig } from 'vite';
import type { TaujsOptimizeDeps } from '../ViteConfig';

/**
 * Core invariants for τjs builds.
 * These fields are non-negotiable to maintain framework integrity.
 */
export type FrameworkInvariant = {
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

export const normalisePlugins = (p: any): any[] => (Array.isArray(p) ? p : p ? [p] : []);

/**
 * A protected-field profile: DECLARED DATA describing which fields a merge mode owns.
 *
 * - `admitBuild`: whether `build.*` tuning fields are honoured at all (dev does NOT admit `build`).
 * - `protectedTop`: top-level keys rejected (logged at warn) when a user layer supplies them.
 * - `protectedBuild`: `build.*` keys rejected when admitted (build restores its framework value).
 *
 * `resolve.alias` is protected in BOTH modes and is handled inline (nested under `resolve`), not
 * listed here.
 */
export type ViteMergeProfile = {
  mode: 'build' | 'dev';
  admitBuild: boolean;
  protectedTop: readonly string[];
  protectedBuild: readonly string[];
};

/**
 * Build profile (RFC 0005 §4 matrix): the framework owns roots, outputs, inputs, aliases, manifests
 * and the dev-only `server.*`. `manifest` is protected here WITH a warning - aligning it to its
 * siblings (it was silently restored before, the one Ground-truth inconsistency VS3 fixes).
 * `configFile` is an EXPLICIT protected invariant (pinned to `false` by the framework), no longer
 * merely never-copied.
 */
export const BUILD_PROFILE: ViteMergeProfile = {
  mode: 'build',
  admitBuild: true,
  protectedTop: ['root', 'base', 'publicDir', 'configFile', 'server'],
  protectedBuild: ['outDir', 'ssr', 'ssrManifest', 'format', 'target', 'manifest'],
};

/**
 * Dev profile (RFC 0005 §4 matrix + §6). DECLARED for the shared dev server; VS4 wires it into
 * `setupDevServer`. `build.*` is not admitted in dev (the whole `build` key is rejected), and the
 * framework owns `server.*`, `appType`, `root`, `configFile`, and `resolve.alias`. `optimizeDeps`
 * is dev-only and merged separately via `mergeOptimizeDeps` (never through this field-copy path).
 */
export const DEV_PROFILE: ViteMergeProfile = {
  mode: 'dev',
  admitBuild: false,
  protectedTop: ['root', 'configFile', 'server', 'appType'],
  protectedBuild: [],
};

/** A resolved user override layer (function forms already resolved) with its source label. */
export type ViteLayer = {
  /** Human-readable origin used in conflict warnings: `config.vite`, `taujsBuild.vite`, an appId... */
  source: string;
  config: Partial<InlineConfig>;
};

type Conflict = { field: string; from: string; to: string };

/**
 * Compose an ordered list of resolved user layers onto the framework config through one engine.
 *
 * Precedence is left-to-right: a later layer wins FIELD conflicts against an earlier USER layer
 * (append fields concatenate, keyed fields merge per key, tuning fields override). Protected fields
 * from any layer are rejected and aggregated into a single warn line (format preserved from the
 * legacy single-layer merge). Per-field conflicts BETWEEN user layers are reported one warn line
 * each, naming the field, both sources, and the winner. Coexistence alone is silent.
 *
 * `optimizeDeps` is NEVER copied here: build strips it (dev-only, ignored by `build()` since Vite
 * 5.1) and dev merges it via `mergeOptimizeDeps`.
 */
export function composeViteConfig(framework: InlineConfig, layers: readonly ViteLayer[], profile: ViteMergeProfile, prefix: string): InlineConfig {
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
  const conflicts: Conflict[] = [];
  const owner = new Map<string, string>();

  // Record a user layer claiming a field/leaf key; a later different source is a per-field conflict.
  const claim = (field: string, source: string): void => {
    const prev = owner.get(field);
    if (prev && prev !== source) conflicts.push({ field, from: prev, to: source });
    owner.set(field, source);
  };

  for (const layer of layers) applyLayer(merged, layer.config, layer.source, profile, ignoredKeys, claim);

  // Restore framework invariants (build profile only - dev owns no build output).
  if (profile.mode === 'build') {
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
  }

  if (ignoredKeys.length > 0) {
    console.warn(`${prefix} Ignored Vite config overrides: ${[...new Set(ignoredKeys)].join(', ')}`);
  }

  for (const { field, from, to } of conflicts) {
    console.warn(`${prefix} Vite config field "${field}" set by both ${from} and ${to}; ${to} wins`);
  }

  return merged;
}

function applyLayer(
  merged: InlineConfig,
  userConfig: Partial<InlineConfig>,
  source: string,
  profile: ViteMergeProfile,
  ignoredKeys: string[],
  claim: (field: string, source: string) => void,
): void {
  // plugins: append (VS6 owns final composition order + dedupe). No conflict - lists compose.
  if (userConfig.plugins) merged.plugins = [...normalisePlugins(merged.plugins), ...normalisePlugins(userConfig.plugins)];

  // define: shallow merge, per-key conflict.
  if (userConfig.define && typeof userConfig.define === 'object') {
    merged.define ??= {};
    for (const [k, v] of Object.entries(userConfig.define)) {
      claim(`define.${k}`, source);
      (merged.define as Record<string, any>)[k] = v;
    }
  }

  // css.preprocessorOptions: per-engine deep merge, conflict per overlapping leaf.
  if (userConfig.css?.preprocessorOptions && typeof userConfig.css.preprocessorOptions === 'object') {
    const fpp = (merged.css?.preprocessorOptions ?? {}) as Record<string, any>;
    const upp = userConfig.css.preprocessorOptions as Record<string, any>;

    merged.css ??= {};
    merged.css.preprocessorOptions ??= {};
    merged.css.preprocessorOptions = Object.keys({ ...fpp, ...upp }).reduce(
      (acc, engine) => {
        const userEngine = upp[engine];
        if (userEngine && typeof userEngine === 'object') {
          for (const leaf of Object.keys(userEngine)) claim(`css.preprocessorOptions.${engine}.${leaf}`, source);
        }
        acc[engine] = { ...fpp[engine], ...userEngine };
        return acc;
      },
      {} as Record<string, any>,
    ) as any;
  }

  // build.*: only admitted in the build profile; dev rejects the whole key.
  if (userConfig.build) {
    if (!profile.admitBuild) {
      ignoredKeys.push('build');
    } else {
      const uBuild = userConfig.build as any;
      const mBuild = merged.build as any;

      for (const field of profile.protectedBuild) if (field in uBuild) ignoredKeys.push(`build.${field}`);

      if ('sourcemap' in uBuild) {
        claim('build.sourcemap', source);
        mBuild.sourcemap = uBuild.sourcemap;
      }

      if ('minify' in uBuild) {
        claim('build.minify', source);
        mBuild.minify = uBuild.minify;
      }

      if (uBuild.terserOptions) {
        claim('build.terserOptions', source);
        mBuild.terserOptions = { ...mBuild.terserOptions, ...uBuild.terserOptions };
      }

      if (uBuild.rollupOptions) {
        const userRollup = uBuild.rollupOptions;
        const ro = (mBuild.rollupOptions ??= {});

        if ('input' in userRollup) ignoredKeys.push('build.rollupOptions.input');

        if ('external' in userRollup) {
          claim('build.rollupOptions.external', source);
          ro.external = userRollup.external;
        }

        if (userRollup.output) {
          const uo = Array.isArray(userRollup.output) ? userRollup.output[0] : userRollup.output;

          if (uo?.manualChunks) claim('build.rollupOptions.output.manualChunks', source);

          ro.output = {
            ...(Array.isArray(ro.output) ? ro.output[0] : ro.output),
            ...(uo?.manualChunks ? { manualChunks: uo.manualChunks } : {}),
          };
        }
      }
    }
  }

  // resolve: alias protected (own declarative home); remaining keys merge, per-key conflict.
  if (userConfig.resolve) {
    const { alias: _alias, ...rest } = userConfig.resolve as any;
    if (_alias) ignoredKeys.push('resolve.alias');

    merged.resolve ??= {};
    for (const [k, v] of Object.entries(rest)) {
      claim(`resolve.${k}`, source);
      (merged.resolve as Record<string, any>)[k] = v;
    }
  }

  // Protected top-level keys. `server` keeps its truthy check (legacy string in the warning).
  if (userConfig.server) ignoredKeys.push('server');
  for (const key of profile.protectedTop) {
    if (key === 'server') continue;
    if (key in userConfig) ignoredKeys.push(key);
  }

  // Tuning overrides carried through untouched. `optimizeDeps` is intentionally absent (build strips
  // it; dev merges it via `mergeOptimizeDeps`). `envPrefix`/`ssr` stay for the legacy build override
  // param (broader `Partial<InlineConfig>`); the allowlisted `TaujsViteConfig` never carries them.
  const overrideKeys = profile.mode === 'build' ? ['esbuild', 'logLevel', 'envPrefix', 'ssr'] : ['esbuild', 'logLevel'];
  for (const key of overrideKeys) {
    if (key in userConfig) {
      claim(key, source);
      (merged as any)[key] = (userConfig as any)[key];
    }
  }
}

/** A resolved `optimizeDeps` contribution with its source label (for VS4's dev config load). */
export type OptimizeDepsLayer = { source: string; optimizeDeps?: TaujsOptimizeDeps };

/**
 * Merge and validate the dev-only `optimizeDeps` subset (RFC 0005 §6).
 *
 * - `include`/`exclude` are concatenated across layers and deduplicated.
 * - The same package in both final `include` and `exclude` is a config-validation ERROR (fail fast,
 *   naming the package) - the contradiction has no sensible resolution.
 * - `esbuildOptions` merges with object semantics; `plugins` arrays are APPENDED, never overwritten.
 *
 * This is the config-load validation entry point; `optimizeDeps` never reaches `build()`.
 */
export function mergeOptimizeDeps(layers: readonly OptimizeDepsLayer[]): TaujsOptimizeDeps | undefined {
  const include: string[] = [];
  const exclude: string[] = [];
  let esbuildOptions: Record<string, any> | undefined;
  let present = false;

  for (const { optimizeDeps } of layers) {
    if (!optimizeDeps) continue;
    present = true;

    if (optimizeDeps.include) include.push(...optimizeDeps.include);
    if (optimizeDeps.exclude) exclude.push(...optimizeDeps.exclude);

    if (optimizeDeps.esbuildOptions) {
      const { plugins: newPlugins, ...restEsbuild } = optimizeDeps.esbuildOptions as any;
      const next: Record<string, any> = { ...(esbuildOptions ?? {}), ...restEsbuild };
      if (newPlugins) next.plugins = [...((next.plugins as any[]) ?? []), ...newPlugins];
      esbuildOptions = next;
    }
  }

  if (!present) return undefined;

  const dedupInclude = [...new Set(include)];
  const dedupExclude = [...new Set(exclude)];

  const contradictions = dedupInclude.filter((pkg) => dedupExclude.includes(pkg));
  if (contradictions.length > 0) {
    const named = contradictions.map((pkg) => `"${pkg}"`).join(', ');
    throw new Error(
      `[taujs] optimizeDeps: ${named} ${contradictions.length === 1 ? 'appears' : 'appear'} in both "include" and "exclude". ` +
        `A dependency cannot be force-included and excluded at once - remove it from one list.`,
    );
  }

  const result: TaujsOptimizeDeps = {};
  if (dedupInclude.length > 0) result.include = dedupInclude;
  if (dedupExclude.length > 0) result.exclude = dedupExclude;
  if (esbuildOptions) result.esbuildOptions = esbuildOptions as TaujsOptimizeDeps['esbuildOptions'];

  return result;
}
