/**
 * `@taujs/solid` - the runtime author surface.
 *
 * This entry is the FROZEN public API (design 1.5) and nothing else. Anything not re-exported here
 * is internal by construction: the sanitiser, the detachable holders, the store's symbol-keyed
 * readiness/detach seams, the render contract brand and the whole compiler/ownership tree are all
 * unreachable from a published import.
 *
 * `solidRenderer()` is deliberately NOT exported here. It lives at `@taujs/solid/renderer` alone -
 * the root-vs-subpath split is frozen, and exposing it from both paths "for convenience" would
 * pull the optional compiler/Vite peers into the module graph of every client bundle that imports
 * this entry.
 */

export { createRenderer } from './SSRRender.js';
export { createSSRStore, useSSRStore } from './SSRDataStore.js';
export { hydrateApp } from './SSRHydration.js';
export { escapeHtml } from './utils/Html.js';

// RFC 0007 (decision 19, renderer contract item 9): the package's PUBLIC surface for this feature
// is the COMPONENT-FACING ACCESSORS and their result/error types, and nothing else. The carrier
// name, both holders, the store seam and the envelope/registry transport shapes are private
// transport and stay unexported - `PublicSurface.test.ts` asserts both halves against the BUILT
// dist. Solid's engine HAS server-side error boundaries, so under the need-based ruling
// (decision 13) it carries no result accessor: the throwing read already completes the response.
export { createDeferredAccessor, DeferredDataError, useDeferredData } from './SSRDeferredData.js';

export type {
  HeadContext,
  InitialDataInput,
  RenderCallbacks,
  RenderErrorInfo,
  RenderOptions,
  RenderSSRFn,
  RenderStreamFn,
  RenderStreamHandle,
  SSROptions,
  StreamOptions,
} from './SSRRender.js';
export type { SSRStore } from './SSRDataStore.js';
export type { DeferredAccessor } from './SSRDeferredData.js';
export type { HydrateAppOptions } from './SSRHydration.js';
export type { ServerLogger, SolidLogger, UILogger } from './utils/Logger.js';
