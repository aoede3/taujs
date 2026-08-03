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

/**
 * Structural brand for a renderer contribution, versioned so an incompatible shape is a different brand.
 * The brand IS the contribution-protocol discriminator: v2 is the LAZY protocol (compiler machinery is
 * loaded through async loaders by build/dev only; production never invokes them). The eager v1 protocol
 * is recognised explicitly BY ITS BRAND in {@link requireRendererContribution} and rejected with upgrade
 * guidance - never inferred from missing properties.
 */
export const RENDERER_CONTRIBUTION_BRAND = 'taujs.renderer-contribution/v2' as const;
export type RendererContributionBrand = typeof RENDERER_CONTRIBUTION_BRAND;

/** The superseded eager protocol brand, recognised only to name the required upgrade. */
export const EAGER_RENDERER_CONTRIBUTION_BRAND = 'taujs.renderer-contribution/v1' as const;

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

/** The identity fields every v2 contribution carries, protocol-variant-independent. */
type RendererContributionBase = {
  readonly brand: RendererContributionBrand;
  /** Framework identity + (when managed) the ESC-1 grouping key. */
  readonly key: string;
  /** The render-module contract version the app's loaded {@link RenderModule} must match. */
  readonly contractVersion: string;
};

/**
 * A managed-compilation renderer (React/Solid): JSX/TSX compilation COLLIDES across frameworks and needs
 * scoped ownership, carried as a lazy ESC-1 compiler contribution. `loadCompiler` is invoked by the host
 * prepass (once per prepass invocation: one dev boot, one `taujsBuild` run); the factory memoises the
 * contribution promise, so the managed contribution is CONSTRUCTED once per contribution lifetime.
 * Production never invokes it, so the compiler toolchain never resolves in a production process.
 */
export type ManagedRendererContribution = RendererContributionBase & {
  readonly managedCompilation: true;
  readonly loadCompiler: () => Promise<ManagedContributionShape>;
  readonly loadEnvironmentPlugins?: never;
};

/**
 * A non-managed renderer (Vue): its compiler is an ordinary unscoped Vite plugin, produced lazily and
 * FRESH once per Vite environment (the ESC-1 lifecycle lesson - plugin objects are never reused across
 * environments; only the module import behind the loader is cached by ESM). The resolved value is typed
 * `unknown` for the same cross-`@types/node` Vite type-identity reason as `PreparedPlan.createPlugin`;
 * the host casts to its own `PluginOption` at the composition seam.
 */
export type EnvironmentRendererContribution = RendererContributionBase & {
  readonly managedCompilation: false;
  readonly loadCompiler?: never;
  readonly loadEnvironmentPlugins: (lifecycle: 'dev' | 'build') => Promise<unknown>;
};

/**
 * The runtime shape a renderer factory produces - a DISCRIMINATED UNION on `managedCompilation`, so the
 * protocol's central invariant (exactly one loader, selected by the discriminant) is structural rather
 * than asserted. NON-public + unstable (versioned by the brand); the public face is the opaque
 * {@link TaujsRendererContribution}. App association is added by the host at grouping time, not carried
 * here.
 */
export type RendererContributionShape = ManagedRendererContribution | EnvironmentRendererContribution;

declare const RENDERER_OPAQUE: unique symbol;
/**
 * The ONE new public concept: an opaque renderer contribution obtained ONLY from a renderer factory
 * (`reactRenderer()`/`vueRenderer()`) and declared on an app's required singular `renderer:`. Application
 * code never constructs or introspects it. Every renderer supplies a runtime render module the host
 * validates - there is no compiler-only/incomplete-renderer mode.
 */
export type TaujsRendererContribution = { readonly [RENDERER_OPAQUE]: true };

/**
 * Structural, forgery-tolerant recogniser for a v2 renderer contribution (host-side). Acceptance is
 * driven by the BRAND (the protocol discriminator); the loader checks are integrity validation of an
 * already-branded value, not protocol detection. They enforce the union's EXCLUSIVITY: exactly the one
 * loader the `managedCompilation` discriminant selects, never both.
 */
export function isRendererContribution(value: unknown): value is RendererContributionShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    v.brand !== RENDERER_CONTRIBUTION_BRAND ||
    typeof v.key !== 'string' ||
    typeof v.contractVersion !== 'string' ||
    typeof v.managedCompilation !== 'boolean'
  ) {
    return false;
  }
  return v.managedCompilation
    ? typeof v.loadCompiler === 'function' && v.loadEnvironmentPlugins === undefined
    : typeof v.loadEnvironmentPlugins === 'function' && v.loadCompiler === undefined;
}

/** Explicit recogniser for the superseded eager v1 protocol - used ONLY to word the upgrade error. */
export function isEagerRendererContribution(value: unknown): value is { key: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.brand === EAGER_RENDERER_CONTRIBUTION_BRAND && typeof v.key === 'string';
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
  if (isEagerRendererContribution(renderer)) {
    throw AppError.internal(
      `[taujs] app "${appId}" declares renderer "${renderer.key}" using the eager v1 contribution protocol, which this @taujs/server no longer accepts. Upgrade @taujs/${renderer.key} to the release that provides the v2 lazy contribution protocol (see the @taujs/server changelog for the paired versions).`,
    );
  }
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
    throw AppError.internal(
      `[taujs] render module for ${where} did not export an object; expected renderSSR/renderStream from @taujs/${declared.key}'s createRenderer(...).`,
    );
  }
  const m = mod as { renderSSR?: unknown; renderStream?: unknown };
  if (typeof m.renderSSR !== 'function' || typeof m.renderStream !== 'function') {
    throw AppError.internal(
      `[taujs] render module for ${where} must export renderSSR and renderStream (from @taujs/${declared.key}'s createRenderer(...), declared via renderer: ${factory}).`,
    );
  }
  const ssr = readRenderFnContract(m.renderSSR);
  const stream = readRenderFnContract(m.renderStream);
  if (!ssr || !stream) {
    throw AppError.internal(
      `[taujs] render module for ${where} is not branded by createRenderer. Produce renderSSR/renderStream with @taujs/${declared.key}'s createRenderer(...) so τjs can validate framework identity against renderer: ${factory}.`,
    );
  }
  if (ssr.key !== stream.key || ssr.contractVersion !== stream.contractVersion) {
    throw AppError.internal(
      `[taujs] render module for ${where} has mismatched renderSSR/renderStream brands (${ssr.key}@${ssr.contractVersion} vs ${stream.key}@${stream.contractVersion}); both must come from the same createRenderer(...).`,
    );
  }
  if (ssr.key !== declared.key) {
    throw AppError.internal(
      `[taujs] render module for ${where} is a "${ssr.key}" renderer but the app declares renderer: ${factory}. The declared renderer and the entry-server's createRenderer(...) must be the same framework.`,
    );
  }
  if (ssr.contractVersion !== declared.contractVersion) {
    throw AppError.internal(
      `[taujs] render module for ${where} was built against render contract "${ssr.contractVersion}" but @taujs/server expects "${declared.contractVersion}"; align the @taujs/${declared.key} and @taujs/server versions.`,
    );
  }
}
