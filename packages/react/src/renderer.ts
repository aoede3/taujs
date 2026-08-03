/**
 * `@taujs/react/renderer` - the `reactRenderer()` factory (contribution protocol v2, RFC 0006 / renderer
 * design v5).
 *
 * Declared on an app's REQUIRED singular `renderer:`. It declares the render-module contract the host
 * validates the entry-server's `createRenderer(...)` output against, and carries the ESC-1 React managed
 * compiler contribution LAZILY (v2 protocol): the compiler module - whose graph includes
 * `@vitejs/plugin-react` and its Vite reach - is imported only when build or development actually loads
 * it, never at declaration time, so a production process that imports this factory via its config stays
 * free of the compiler toolchain. `plugins:` holds ordinary Vite plugins; the raw portable `pluginReact()`
 * stays for plain-Vite use.
 *
 * Brand/version literals are reproduced BY VALUE (never runtime-importing `@taujs/server`); the type-only
 * imports keep them in sync with the host contract at compile time.
 */
import { REACT_RENDERER_KEY, RENDER_CONTRACT_VERSION } from './renderContract.js';
import { validateReactRendererOptions } from './rendererOptions.js';

import type { ReactRendererOptions } from './rendererOptions.js';
import type { ManagedContributionShape, ManagedRendererContribution, RendererContributionBrand, TaujsRendererContribution } from '@taujs/server/renderer';

const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v2';

export type { ReactRendererOptions } from './rendererOptions.js';

export function reactRenderer(opts: ReactRendererOptions): TaujsRendererContribution {
  // Construction-time validation stays SYNCHRONOUS, via the compiler-free shared validator (the lazy
  // builder consumes the same validated shape), so a bad declaration throws at config evaluation, not at
  // the first lazy load in build/dev.
  const validated = validateReactRendererOptions(opts);

  // The loader is invoked once per host prepass; the memo makes the managed contribution's CONSTRUCTION
  // once per contribution lifetime. The module cache keeps `CompilerImpl` reference identity per
  // installed copy, so the host's one-impl-per-key assertion behaves exactly as with the eager protocol.
  let compilerPromise: Promise<ManagedContributionShape> | undefined;
  const contribution: ManagedRendererContribution = {
    brand: RENDERER_BRAND,
    key: REACT_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: true,
    loadCompiler: () => (compilerPromise ??= import('./compiler/reactCompiler.js').then((m) => m.buildReactContribution(validated))),
  };
  return contribution as unknown as TaujsRendererContribution;
}
