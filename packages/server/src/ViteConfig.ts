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
 * RFC 0005 (VS2): the PUBLIC, allowlisted Vite customisation surface for `taujs.config.ts`.
 *
 * These types describe exactly the Vite fields τjs supports through its declared channels - no
 * more. `Partial<InlineConfig>` would autocomplete every Vite property while the merge silently
 * dropped the protected ones (a lie in the editor); `TaujsViteConfig` instead admits only the
 * matrix-supported fields (RFC 0005 Amended contract §4). Runtime consumption lands in VS3/VS4/VS5;
 * VS2 ships the types (and their type tests) alone - the fields may be present but unread.
 *
 * NOTE: these live OUTSIDE `core/` on purpose. `core/config/types.ts` is deliberately Vite-free
 * (e.g. `CoreAppConfig.plugins` is `readonly unknown[]`, re-decorated to `PluginOption[]` in
 * `Config.ts`); the Vite-typed surface belongs alongside `Config.ts`/`Build.ts`, which already
 * import from `vite`.
 */
import type { DepOptimizationOptions, ESBuildOptions, LogLevel, PluginOption, ResolveOptions, Rollup } from 'vite';
import type { BuildOptions, CSSOptions } from 'vite';

/**
 * RFC 0005 Amended contract §6 - the day-one dev `optimizeDeps` subset (maintainer ruling
 * 2026-07-14). `include`/`exclude` force or withhold pre-bundling; `esbuildOptions` accommodates
 * dependency transforms, loaders, and esbuild plugins. Every OTHER optimiser field is deliberately
 * unadmitted, NOT forgotten - `entries`/`noDiscovery` (τjs owns shared-dev entry discovery),
 * `force` (an operational cache-bust, not durable config), `disabled` (deprecated), and the
 * experimental remainder each stay withheld until a concrete ecosystem case earns them. `optimizeDeps`
 * is development-only: nothing from it reaches client or SSR builds.
 */
export type TaujsOptimizeDeps = Pick<DepOptimizationOptions, 'include' | 'exclude' | 'esbuildOptions'>;

/**
 * RFC 0005 Amended contract §4 (support matrix) - the allowlisted Vite override object. Only the
 * matrix-admitted fields appear; the protected invariants (`root`, `base`, `publicDir`,
 * `configFile`, `server`, `appType`, `build.outDir`/`ssr`/`ssrManifest`/`format`/`target`/`manifest`,
 * `build.rollupOptions.input`, `resolve.alias`) are ABSENT from the type, so the editor refuses them
 * up front rather than the merge dropping them later. Aliases have their own declarative home
 * (top-level `alias`), so `resolve` here is the alias-free `ResolveOptions`.
 */
export type TaujsViteConfig = {
  /** Appended to the framework plugin list (append + dedupe by name; §5). */
  plugins?: PluginOption[];
  /** Shallow-merged with framework defines. */
  define?: Record<string, unknown>;
  /** Per-engine deep merge; only `preprocessorOptions` is admitted from `CSSOptions`. */
  css?: {
    preprocessorOptions?: CSSOptions['preprocessorOptions'];
  };
  /** Dev-only (§6); never reaches build configs. */
  optimizeDeps?: TaujsOptimizeDeps;
  /** Override. */
  esbuild?: ESBuildOptions | false;
  /** Override. */
  logLevel?: LogLevel;
  /** `resolve` subset - `alias` is intentionally excluded (use top-level `alias`). */
  resolve?: ResolveOptions;
  /** Build-tuning subset - the framework owns everything else under `build`. */
  build?: {
    sourcemap?: BuildOptions['sourcemap'];
    minify?: BuildOptions['minify'];
    terserOptions?: BuildOptions['terserOptions'];
    rollupOptions?: {
      external?: Rollup.ExternalOption;
      output?: {
        manualChunks?: Rollup.ManualChunksOption;
      };
    };
  };
};

/**
 * RFC 0005 Amended contract §1 - the discriminated serve/build context handed to the function form
 * of `vite`. Dev invokes the callback ONCE with the `serve` arm (no `appId`/`entryPoint` - per-app
 * dev invocation would pretend an isolation the shared dev server deliberately does not have); build
 * invokes it per app with the `build` arm. `appId`/`entryPoint` are typed `never` on the serve arm so
 * a callback cannot read them without narrowing to `command === 'build'` first.
 */
export type TaujsViteContext =
  | {
      command: 'serve';
      mode: string;
      isSSRBuild: false;
      appId?: never;
      entryPoint?: never;
      clientRoot: string;
    }
  | {
      command: 'build';
      mode: string;
      isSSRBuild: boolean;
      appId: string;
      entryPoint: string;
      clientRoot: string;
    };

/**
 * RFC 0005 Amended contract §4 - the `config.vite` field type: a static `TaujsViteConfig` or a
 * function of the serve/build context. The function form must accept the WHOLE `TaujsViteContext`;
 * a callback typed for the build arm alone is not a valid `TaujsViteOverride` (it could not honestly
 * run for the shared dev server).
 */
export type TaujsViteOverride = TaujsViteConfig | ((ctx: TaujsViteContext) => TaujsViteConfig);
