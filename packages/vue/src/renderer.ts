/**
 * `@taujs/vue/renderer` - the `vueRenderer()` factory (contribution protocol v2, RFC 0006 / renderer design v5).
 *
 * Declared on an app's REQUIRED singular `renderer:`. Vue's `.vue` compiler does NOT collide with other
 * frameworks' files, so vueRenderer carries NO ownership machinery (`managedCompilation: false`): instead it
 * supplies its ordinary `pluginVue` pack FRESH per Vite environment (a new instance each dev/build, so no
 * plugin object is reused across environments - the ESC-1 lifecycle lesson). It declares the render-module
 * contract the host validates the entry-server's `createRenderer(...)` output against.
 *
 * A raw `pluginVue()` in `plugins:` alongside `vueRenderer()` in the same resolved environment is a hard
 * host error (the renderer already supplies it).
 */
import { RENDER_CONTRACT_VERSION, VUE_RENDERER_KEY } from './renderContract.js';

import type { pluginVue } from './plugin.js';
import type { EnvironmentRendererContribution, RendererContributionBrand, TaujsRendererContribution } from '@taujs/server/renderer';

// v2 = the LAZY contribution protocol: `pluginVue` (and `@vitejs/plugin-vue` behind it) is imported
// only when a Vite environment is actually assembled in build or development - never at declaration
// time, so a production process importing this factory via its config stays compiler-free.
const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v2';

/** Options for {@link vueRenderer}: the ordinary `@vitejs/plugin-vue` options (supplied fresh per env). */
export type VueRendererOptions = Parameters<typeof pluginVue>[0];

export function vueRenderer(opts?: VueRendererOptions): TaujsRendererContribution {
  const contribution: EnvironmentRendererContribution = {
    brand: RENDERER_BRAND,
    key: VUE_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: false,
    // A FRESH pluginVue pack per invocation - the host calls this once per Vite environment (the ESC-1
    // lifecycle lesson: plugin objects are never reused across environments). Only the module import
    // behind it is cached, by ESM itself.
    loadEnvironmentPlugins: async () => (await import('./plugin.js')).pluginVue(opts),
  };
  return contribution as unknown as TaujsRendererContribution;
}
