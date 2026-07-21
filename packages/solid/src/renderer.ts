/**
 * `@taujs/solid/renderer` - the application-facing renderer contribution.
 *
 * This subpath exposes EXACTLY `solidRenderer({ project })` and nothing else. It is separate from
 * the root entry on purpose: it reaches the managed compiler, which pulls the OPTIONAL
 * `vite`/`vite-plugin-solid`/`typescript` peers, and a client bundle that imports `@taujs/solid`
 * must never drag those into its graph. Do not re-export it from the root for convenience - that
 * decision is frozen and any change returns for a DX ruling with packed-consumer evidence.
 *
 * Managed compilation ALWAYS forces `vite-plugin-solid`'s `ssr: true` internally (verified against
 * the pinned plugin: `ssr:true` enables hydratable transforms, and false/absent produces
 * non-hydratable DOM output that is invalid for a τjs renderer). `ssr`, `babel`, `include`,
 * `exclude` and every other advanced plugin option are NOT renderer-v1 DX; raw `pluginSolid()` at
 * `@taujs/solid/plugin` remains the portable escape hatch for plain Vite.
 */
import { buildSolidContribution } from './compiler/solidCompiler.js';

import { RENDER_CONTRACT_VERSION, SOLID_RENDERER_KEY } from './renderContract.js';

import type { SolidCompilerOptions } from './compiler/solidCompiler.js';
import type { RendererContributionBrand, RendererContributionShape, TaujsRendererContribution } from '@taujs/server/renderer';

// Single source of truth for the key + contract version: `renderContract.ts`, which the render
// module's brand also uses. Two copies could disagree and the host would reject the module.
const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v1';

/**
 * The renderer's ENTIRE option surface (design 1.5, frozen): a single required tsconfig `project`
 * that defines the app's ownership boundary. Ownership `include`/`exclude` are RESERVED - the host
 * computes them from the project - and no transform-mode option is offered.
 */
export type SolidRendererOptions = { project: string };

/** Declare an app as a Solid app. Pass it to `renderer:` in the τjs config. */
export function solidRenderer(opts: SolidRendererOptions): TaujsRendererContribution {
  const compiler = buildSolidContribution(opts);
  const contribution: RendererContributionShape = {
    brand: RENDERER_BRAND,
    key: SOLID_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: true,
    compiler,
  };
  return contribution as unknown as TaujsRendererContribution;
}
