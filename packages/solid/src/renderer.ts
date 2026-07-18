/**
 * `@taujs/solid/renderer` - the `solidRenderer()` factory (renderer v1, RFC 0006 / renderer design v5).
 *
 * SCOPE: this is the FOUNDATION only. The Solid SSR render module (renderSSR/renderStream) is NOT built yet
 * (it lands after S0-GATE); `@taujs/solid` stays private. So solidRenderer carries ONLY the ESC-1 Solid
 * managed compiler contribution (scoped JSX ownership - it coexists safely with React on one Vite server)
 * plus the declaration, and sets `expectsModule: false` so the host does NOT try to load/validate a Solid
 * render module. A Solid app is therefore declarable + compilable now, servable once the renderer lands.
 *
 * Brand/version literals are reproduced BY VALUE (never runtime-importing `@taujs/server`); the type-only
 * imports keep them in sync with the host contract at compile time.
 */
import { scopedPluginSolid } from './plugin.js';

import type { ScopedPluginSolidOptions } from './plugin.js';
import type {
  ManagedContributionShape,
  RenderContractVersion,
  RendererContributionBrand,
  RendererContributionShape,
  TaujsRendererContribution,
} from '@taujs/server/renderer';

const RENDERER_BRAND: RendererContributionBrand = 'taujs.renderer-contribution/v1';
const RENDER_CONTRACT_VERSION: RenderContractVersion = 'v1';
const SOLID_RENDERER_KEY = 'solid';

/** Options for {@link solidRenderer}: a required tsconfig `project` plus Solid options (ownership
 * `include`/`exclude` are RESERVED - the host computes them from the project). */
export type SolidRendererOptions = ScopedPluginSolidOptions;

export function solidRenderer(opts: SolidRendererOptions): TaujsRendererContribution {
  const compiler = scopedPluginSolid(opts) as unknown as ManagedContributionShape;
  const contribution: RendererContributionShape = {
    brand: RENDERER_BRAND,
    key: SOLID_RENDERER_KEY,
    contractVersion: RENDER_CONTRACT_VERSION,
    managedCompilation: true,
    // The Solid render module does not exist yet (post-GATE); the host skips render-module load/validation.
    expectsModule: false,
    compiler,
  };
  return contribution as unknown as TaujsRendererContribution;
}
