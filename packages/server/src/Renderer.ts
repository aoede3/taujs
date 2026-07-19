/**
 * `@taujs/server/renderer` - the renderer-AUTHOR contract (TYPE-ONLY).
 *
 * HONEST SCOPE: this is a real public package entry. Renderer v1 shrinks the APPLICATION DX to one concept
 * (`renderer:`), but it does NOT shrink this author-facing surface: a first-party renderer package needs
 * these types to build a factory and to implement its managed compiler. This entry therefore re-exports the
 * ESC-1 compiler-author types (CompilerImpl / PreparedPlan / ManagedContributionShape / the versioned
 * brands) alongside the renderer-contribution contract. Every export is TYPE-ONLY; renderers reproduce the
 * brand/version LITERALS by value (never runtime-importing `@taujs/server`), so this adds no runtime
 * dependency. NOT for application code - which only ever sees the opaque `TaujsRendererContribution` from
 * `@taujs/server/config`.
 */

// The renderer-contribution contract (the config-time declaration half).
export type { RenderContractVersion, RendererContributionBrand, RendererContributionShape, TaujsRendererContribution } from './utils/RendererContract';

// The ESC-1 managed compiler-author contract a JSX renderer (managedCompilation:true) implements.
export type {
  CompilerImpl,
  EffectiveScope,
  ManagedContributionBrand,
  ManagedContributionShape,
  ManagedGroupMember,
  PrepareInput,
  PreparedPlan,
} from './utils/ManagedPlugins';
