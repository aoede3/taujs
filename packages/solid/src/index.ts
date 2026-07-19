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
export type { HydrateAppOptions } from './SSRHydration.js';
export type { ServerLogger, SolidLogger, UILogger } from './utils/Logger.js';
