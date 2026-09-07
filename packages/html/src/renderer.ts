/**
 * `@taujs/html/renderer` - the `htmlRenderer()` factory (contribution protocol v2).
 *
 * Declared on an app's REQUIRED singular `renderer:`. `@taujs/html` has no compiler and no
 * component tree, so it carries NO ownership machinery (`managedCompilation: false`) and its
 * environment-plugin pack is empty - it is the neutral HTML implementation of the renderer
 * contract, not a compiled framework. Modelled on `packages/vue/src/renderer.ts` at `73f2867`.
 */
import { HTML_RENDERER_KEY, RENDER_CONTRACT_VERSION } from './renderContract.js';

import type { EnvironmentRendererContribution, RendererContributionBrand, TaujsRendererContribution } from '@taujs/server/renderer';

// v2 = the LAZY contribution protocol. `@taujs/html` has nothing to load - `loadEnvironmentPlugins`
// always resolves a FRESH empty array - but the discriminant still selects the non-managed loader so
// the host's structural recogniser accepts the contribution.
const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v2';

/**
 * `htmlRenderer()` takes no parameters - passing an argument is a TypeScript error; at runtime the
 * argument is ignored. `key: 'html'`, `managedCompilation: false`, an empty environment-plugin pack.
 */
export function htmlRenderer(): TaujsRendererContribution {
  const contribution: EnvironmentRendererContribution = {
    brand: RENDERER_BRAND,
    key: HTML_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: false,
    // A FRESH empty array per invocation - the host calls this once per Vite environment.
    loadEnvironmentPlugins: async () => [],
  };
  return contribution as unknown as TaujsRendererContribution;
}
