/**
 * INTERNAL - NOT a public `@taujs/solid` entry, and NOT part of renderer v1.
 *
 * Solid is not a τjs renderer yet: it has no `createRenderer`, no SSR/streaming/hydration, no branded
 * render module. Until it satisfies the COMPLETE renderer contract there is deliberately no user-facing
 * `solidRenderer()` - not in package exports, scaffolding, changesets or migration docs, and no suggestion
 * a user can create a τjs Solid app.
 *
 * This factory exists ONLY so first-party INTERNAL integration fixtures can exercise the host's
 * framework-neutral ownership pre-pass and prove React and Solid COMPILATION coexist on one Vite server. It
 * wraps the ESC-1 Solid managed compiler contribution as a renderer contribution (managedCompilation:true);
 * it supplies NO render module, so any attempt to SERVE such an app fails render-module validation - which
 * is the honest, uniform contract (there is no `expectsModule`/incomplete-renderer escape hatch). The
 * fixtures reach this module through a test-only Vitest alias, never a published entry.
 */
import { buildSolidContribution } from './compiler/solidCompiler.js';

import { RENDER_CONTRACT_VERSION, SOLID_RENDERER_KEY } from './renderContract.js';

import type { SolidCompilerOptions } from './compiler/solidCompiler.js';
import type { RendererContributionBrand, RendererContributionShape, TaujsRendererContribution } from '@taujs/server/renderer';

// Single source of truth for the key + contract version: `renderContract.ts`, which the render
// module's brand also uses. Two copies could disagree and the host would reject the module.
const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v1';

/** Options for the internal Solid compiler contribution: a required tsconfig `project` plus Solid options
 * (ownership `include`/`exclude` are RESERVED - the host computes them from the project). */
export type SolidRendererOptions = SolidCompilerOptions;

/** INTERNAL (test/integration only): the Solid managed compiler contribution as a renderer contribution. */
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
