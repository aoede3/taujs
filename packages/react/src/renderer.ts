/**
 * `@taujs/react/renderer` - the `reactRenderer()` factory (renderer v1, RFC 0006 / renderer design v5).
 *
 * Declared on an app's REQUIRED singular `renderer:`. It carries the ESC-1 React managed compiler
 * contribution (scoped JSX ownership - the host computes each framework's scope after seeing all apps and
 * constructs the real plugin) internally, and declares the render-module contract the host validates the
 * entry-server's `createRenderer(...)` output against. `plugins:` reverts to ordinary Vite plugins; the raw
 * portable `pluginReact()` stays for plain-Vite use.
 *
 * Brand/version literals are reproduced BY VALUE (never runtime-importing `@taujs/server`); the type-only
 * imports keep them in sync with the host contract at compile time.
 */
import { scopedPluginReact } from './plugin.js';
import { REACT_RENDERER_KEY, RENDER_CONTRACT_VERSION } from './renderContract.js';

import type { ScopedPluginReactOptions } from './plugin.js';
import type { ManagedContributionShape, RendererContributionBrand, RendererContributionShape, TaujsRendererContribution } from '@taujs/server/renderer';

const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v1';

/** Options for {@link reactRenderer}: a required tsconfig `project` plus React options (ownership
 * `include`/`exclude` are RESERVED - the host computes them from the project). */
export type ReactRendererOptions = ScopedPluginReactOptions;

export function reactRenderer(opts: ReactRendererOptions): TaujsRendererContribution {
  const compiler = scopedPluginReact(opts) as unknown as ManagedContributionShape;
  const contribution: RendererContributionShape = {
    brand: RENDERER_BRAND,
    key: REACT_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: true,
    expectsModule: true,
    compiler,
  };
  return contribution as unknown as TaujsRendererContribution;
}
