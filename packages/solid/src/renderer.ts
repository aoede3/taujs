/**
 * `@taujs/solid/renderer` - the application-facing renderer contribution.
 *
 * This subpath exposes EXACTLY `solidRenderer({ project })` and nothing else. It is separate from
 * the root entry on purpose: it carries the managed compiler CONTRIBUTION, which pulls the OPTIONAL
 * `vite`/`vite-plugin-solid`/`typescript` peers when build or development lazily loads it (v2
 * protocol - declaration itself is peer-free), and a client bundle that imports `@taujs/solid`
 * must never drag the factory into its graph. Do not re-export it from the root for convenience -
 * that decision is frozen and any change returns for a DX ruling with packed-consumer evidence.
 *
 * Managed compilation ALWAYS forces `vite-plugin-solid`'s `ssr: true` internally (verified against
 * the pinned plugin: `ssr:true` enables hydratable transforms, and false/absent produces
 * non-hydratable DOM output that is invalid for a τjs renderer). `ssr`, `babel`, `include`,
 * `exclude` and every other advanced plugin option are NOT renderer-v1 DX; raw `pluginSolid()` at
 * `@taujs/solid/plugin` remains the portable escape hatch for plain Vite.
 */
import { RENDER_CONTRACT_VERSION, SOLID_RENDERER_KEY } from './renderContract.js';
import { validateSolidRendererOptions } from './rendererOptions.js';

import type { SolidRendererOptions } from './rendererOptions.js';
import type { ManagedContributionShape, ManagedRendererContribution, RendererContributionBrand, TaujsRendererContribution } from '@taujs/server/renderer';

// Single source of truth for the key + contract version: `renderContract.ts`, which the render
// module's brand also uses. Two copies could disagree and the host would reject the module.
// v2 = the LAZY contribution protocol: the compiler module (and its vite-plugin-solid/Babel graph)
// is imported only when build or development loads it, never at declaration time.
const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v2';

export type { SolidRendererOptions } from './rendererOptions.js';

/** Declare an app as a Solid app. Pass it to `renderer:` in the τjs config. */
export function solidRenderer(opts: SolidRendererOptions): TaujsRendererContribution {
  // Construction-time validation stays SYNCHRONOUS, via the compiler-free shared validator (the lazy
  // builder consumes the same validated shape), so a bad declaration throws at config evaluation.
  const validated = validateSolidRendererOptions(opts);

  // The loader is invoked once per host prepass; the memo makes the managed contribution's CONSTRUCTION
  // once per contribution lifetime. Module-cache reference identity preserves the host's
  // one-impl-per-key assertion exactly as with the eager protocol.
  let compilerPromise: Promise<ManagedContributionShape> | undefined;
  const contribution: ManagedRendererContribution = {
    brand: RENDERER_BRAND,
    key: SOLID_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: true,
    loadCompiler: () => (compilerPromise ??= import('./compiler/solidCompiler.js').then((m) => m.buildSolidContribution(validated))),
  };
  return contribution as unknown as TaujsRendererContribution;
}
