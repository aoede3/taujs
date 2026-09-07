/**
 * `@taujs/html` - the framework-free HTML SSR + streaming SSR renderer. `createRenderer` is the
 * SOLE runtime export of the package root; `renderSSR`/`renderStream` are the two functions it
 * RETURNS, not package exports (`export const { renderSSR, renderStream } = createRenderer(...)`,
 * as with the other renderers).
 *
 * No `escapeHtml` and no template helper are exported here: the application owns its HTML safety.
 */
export { createRenderer } from './SSRRender.js';
export type { HtmlFragments, HtmlRendererOptions, RenderContext, StreamOptions } from './SSRRender.js';
export type { LoggerLike } from './utils/Logger.js';
