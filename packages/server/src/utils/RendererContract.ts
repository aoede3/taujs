import { AppError } from '../core/errors/AppError';

import type { ManagedContributionShape } from './ManagedPlugins';
import type { RenderModule } from '../types';

/**
 * Renderer v1 (RFC 0006 / `docs/solid` renderer design v5) - the renderer CONTRIBUTION contract.
 *
 * A renderer factory (`reactRenderer()`/`vueRenderer()`) returns ONE opaque branded contribution declared
 * on an app's REQUIRED singular `renderer:`. It is the paired contract's config-time DECLARATION half: it
 * names the framework identity + render-module contract version the host validates the loaded
 * {@link RenderModule} against (the runtime half), and carries EITHER a managed compiler contribution (a
 * JSX renderer - scoped ownership, reusing the ESC-1 machinery unchanged) OR a fresh-per-environment raw
 * plugin pack (Vue - its ordinary `.vue` compiler, NO ownership machinery).
 *
 * Framework knowledge stays in the renderer packages; the host is NEUTRAL (aggregation + validation only,
 * no `if (react)`/`if (vue)` branch). Runtime-Vite-free (only `import type` from vite downstream) so it can
 * be referenced from the config surface without pulling Vite into a plain consumer's runtime - exactly the
 * discipline {@link ./ManagedPlugins} keeps.
 */

/** Structural brand for a renderer contribution, versioned so an incompatible shape is a different brand. */
export const RENDERER_CONTRIBUTION_BRAND = 'taujs.renderer-contribution/v1' as const;
export type RendererContributionBrand = typeof RENDERER_CONTRIBUTION_BRAND;

/**
 * The render-MODULE contract version - the runtime `{ renderSSR, renderStream }` shape a framework's
 * `createRenderer` produces. Distinct from {@link RENDERER_CONTRIBUTION_BRAND} (the config-time contribution
 * shape): a render-shape bump and an ownership-shape bump version independently. Reproduced BY VALUE in the
 * framework packages (they never runtime-import `@taujs/server`); the type keeps them in sync at compile time.
 */
export const RENDER_CONTRACT_VERSION = 'v1' as const;
export type RenderContractVersion = typeof RENDER_CONTRACT_VERSION;

/** The identity a render function is branded with, and the declaration the host validates it against. */
export type DeclaredRenderContract = {
  /** Framework identity key (`'react'`/`'solid'`/`'vue'`); equals the contribution's `key`. */
  key: string;
  /** The render-module contract version the render functions were built against. */
  contractVersion: string;
};

/**
 * The runtime shape a renderer factory produces. NON-public + unstable (versioned by the brand); the public
 * face is the opaque {@link TaujsRendererContribution}. App association is added by the host at grouping
 * time, not carried here.
 */
export type RendererContributionShape = {
  readonly brand: RendererContributionBrand;
  /** Framework identity + (when managed) the ESC-1 grouping key. */
  readonly key: string;
  /** The render-module contract version the app's loaded {@link RenderModule} must match. */
  readonly contractVersion: string;
  /**
   * True for frameworks whose JSX/TSX compilation COLLIDES and needs scoped ownership (React/Solid) - they
   * carry {@link RendererContributionShape.compiler}; false for frameworks whose compiler is an ordinary
   * unscoped Vite plugin (Vue) - they carry {@link RendererContributionShape.createEnvironmentPlugins}.
   */
  readonly managedCompilation: boolean;
  /** The ESC-1 managed compiler contribution - present IFF `managedCompilation` (a JSX renderer). */
  readonly compiler?: ManagedContributionShape;
  /**
   * A non-managed renderer's ordinary framework Vite plugin(s), built FRESH per environment (Vue's
   * `pluginVue` pack). Typed `unknown` for the same cross-`@types/node` Vite type-identity reason as
   * `PreparedPlan.createPlugin`; the host casts to its own `PluginOption` at the composition seam.
   */
  readonly createEnvironmentPlugins?: (lifecycle: 'dev' | 'build') => unknown;
};

declare const RENDERER_OPAQUE: unique symbol;
/**
 * The ONE new public concept: an opaque renderer contribution obtained ONLY from a renderer factory
 * (`reactRenderer()`/`vueRenderer()`) and declared on an app's required singular `renderer:`. Application
 * code never constructs or introspects it. Every renderer supplies a runtime render module the host
 * validates - there is no compiler-only/incomplete-renderer mode.
 */
export type TaujsRendererContribution = { readonly [RENDERER_OPAQUE]: true };

/** Structural, forgery-tolerant recogniser for a renderer contribution (host-side). */
export function isRendererContribution(value: unknown): value is RendererContributionShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.brand === RENDERER_CONTRIBUTION_BRAND &&
    typeof v.key === 'string' &&
    typeof v.contractVersion === 'string' &&
    typeof v.managedCompilation === 'boolean'
  );
}

/** The declared render contract a contribution asserts of the app's render module. */
export function declaredContractOf(contribution: RendererContributionShape): DeclaredRenderContract {
  return { key: contribution.key, contractVersion: contribution.contractVersion };
}

/**
 * The SINGLE required-renderer assertion, shared by shared-dev preparation, production render-module
 * loading and development render-module loading. `renderer:` is required at runtime: an absent or invalid
 * contribution is a hard error here with ONE consistent message (not repeated per call site).
 */
export function requireRendererContribution(appId: string, renderer: unknown): RendererContributionShape {
  if (!isRendererContribution(renderer)) {
    throw AppError.internal(
      `[taujs] app "${appId}" must declare a valid renderer: reactRenderer()/vueRenderer(). \`renderer:\` is required (found ${renderer === undefined ? 'none' : 'an invalid value'}).`,
    );
  }
  return renderer;
}

/**
 * The well-known tag key each render function is branded with. A GLOBAL symbol so the framework packages
 * reproduce it BY VALUE (`Symbol.for(...)`) without runtime-importing `@taujs/server`, exactly like ESC-1's
 * `UNSCOPED_COMPILER_TAG`. Valued with the function's {@link DeclaredRenderContract}.
 */
export const RENDER_CONTRACT_TAG = 'taujs.render-contract/v1';

/** Read the render contract a framework's `createRenderer` stamped on a render function, if any. */
export function readRenderFnContract(fn: unknown): DeclaredRenderContract | undefined {
  if (typeof fn !== 'function') return undefined;
  const tag = (fn as unknown as Record<symbol, unknown>)[Symbol.for(RENDER_CONTRACT_TAG)];
  if (typeof tag !== 'object' || tag === null) return undefined;
  const t = tag as Record<string, unknown>;
  if (typeof t.key !== 'string' || typeof t.contractVersion !== 'string') return undefined;
  return { key: t.key, contractVersion: t.contractVersion };
}

/**
 * Generic, framework-NEUTRAL render-module identity validation (implemented ONCE; renderers only stamp).
 * Asserts the loaded module exposes `renderSSR` + `renderStream`, BOTH branded, their brands AGREE
 * (key + contractVersion), and they MATCH the app's declared contract. A mismatch/unbranded module is a
 * HARD error with migration guidance - the paired contract's runtime half.
 *
 * Called at both render-module load seams: prod at boot (`AssetManager`) and dev after `ssrLoadModule`
 * (`HandleRender`), before the module is invoked for a request.
 */
export function assertRenderContract(
  mod: unknown,
  declared: DeclaredRenderContract,
  ctx: { phase: 'prod-boot' | 'dev'; appId: string; clientRoot: string },
): asserts mod is RenderModule {
  const where = `app "${ctx.appId}" (${ctx.clientRoot})`;
  const factory = `${declared.key}Renderer()`;

  // `ctx.phase` distinguishes the prod-boot vs dev-request seam for the caller/logs; the messages below
  // stand alone, so it is not folded into the (cause-typed) AppError argument.
  void ctx.phase;

  if (typeof mod !== 'object' || mod === null) {
    throw AppError.internal(`[taujs] render module for ${where} did not export an object; expected renderSSR/renderStream from @taujs/${declared.key}'s createRenderer(...).`);
  }
  const m = mod as { renderSSR?: unknown; renderStream?: unknown };
  if (typeof m.renderSSR !== 'function' || typeof m.renderStream !== 'function') {
    throw AppError.internal(`[taujs] render module for ${where} must export renderSSR and renderStream (from @taujs/${declared.key}'s createRenderer(...), declared via renderer: ${factory}).`);
  }
  const ssr = readRenderFnContract(m.renderSSR);
  const stream = readRenderFnContract(m.renderStream);
  if (!ssr || !stream) {
    throw AppError.internal(`[taujs] render module for ${where} is not branded by createRenderer. Produce renderSSR/renderStream with @taujs/${declared.key}'s createRenderer(...) so τjs can validate framework identity against renderer: ${factory}.`);
  }
  if (ssr.key !== stream.key || ssr.contractVersion !== stream.contractVersion) {
    throw AppError.internal(`[taujs] render module for ${where} has mismatched renderSSR/renderStream brands (${ssr.key}@${ssr.contractVersion} vs ${stream.key}@${stream.contractVersion}); both must come from the same createRenderer(...).`);
  }
  if (ssr.key !== declared.key) {
    throw AppError.internal(`[taujs] render module for ${where} is a "${ssr.key}" renderer but the app declares renderer: ${factory}. The declared renderer and the entry-server's createRenderer(...) must be the same framework.`);
  }
  if (ssr.contractVersion !== declared.contractVersion) {
    throw AppError.internal(`[taujs] render module for ${where} was built against render contract "${ssr.contractVersion}" but @taujs/server expects "${declared.contractVersion}"; align the @taujs/${declared.key} and @taujs/server versions.`);
  }
}
