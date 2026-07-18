/**
 * `@taujs/server/renderer` - the versioned renderer-AUTHOR contract (register Q5, deliberately minimal).
 *
 * The three first-party renderer packages (`@taujs/react`, `@taujs/solid`, `@taujs/vue`) type-only-import
 * this contract to build their `reactRenderer()`/`solidRenderer()`/`vueRenderer()` factories and to brand
 * their `createRenderer` render functions. They reproduce the brand/version LITERALS by value (never
 * runtime-importing `@taujs/server`), so the type-only imports keep them in sync at compile time without a
 * runtime dependency - exactly the ESC-1 discipline.
 *
 * The application-facing surface stays on `@taujs/server/config`, which exports only the opaque
 * {@link TaujsRendererContribution}. This entry is NOT for application code.
 */

// The renderer contribution contract (config-time declaration half).
export type {
  DeclaredRenderContract,
  RenderContractVersion,
  RendererContributionBrand,
  RendererContributionShape,
  TaujsRendererContribution,
} from './utils/RendererContract';
export { RENDER_CONTRACT_TAG, RENDER_CONTRACT_VERSION, RENDERER_CONTRIBUTION_BRAND } from './utils/RendererContract';

// The ESC-1 managed compiler-author contract the React/Solid factories implement (a renderer with
// `managedCompilation: true` nests a `ManagedContributionShape` as its `compiler`). Kept here rather than
// on the application-facing `/config` entry - only renderer authors need it.
export type {
  CompilerImpl,
  EffectiveScope,
  ManagedContributionBrand,
  ManagedContributionShape,
  ManagedGroupMember,
  OwnershipMatcher,
  PrepareInput,
  PreparedPlan,
} from './utils/ManagedPlugins';

// The named render-options bag + render-module contract types (the runtime half) live on the package root
// (`@taujs/server`) alongside RenderModule/RenderSSR/RenderStream; re-exported here for renderer authors.
export type { RenderModule, RenderOptions, RenderSSR, RenderStream, RenderStreamHandle, RendererLogger } from './types';
