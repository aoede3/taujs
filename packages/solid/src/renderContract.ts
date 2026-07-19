/**
 * Internal: the render-module identity brand `@taujs/solid`'s `createRenderer` stamps on its output.
 *
 * Reproduced BY VALUE (never runtime-importing `@taujs/server`) so a raw/standalone consumer stays
 * `@taujs/server`-free and the brand survives the scaffold's `export const { renderSSR, renderStream } =
 * createRenderer(...)` destructure. The type-only `RenderContractVersion` import makes a host contract-version
 * bump fail this assignment at compile time - a safety net without a runtime dependency (the ESC-1 discipline).
 */
import type { RenderContractVersion } from '@taujs/server/renderer';

export const RENDER_CONTRACT_VERSION: RenderContractVersion = 'v1';
export const SOLID_RENDERER_KEY = 'solid';

const RENDER_CONTRACT_TAG = Symbol.for('taujs.render-contract/v1');

/**
 * Stamp a non-enumerable render-contract brand on BOTH render functions and return the module. Scaffolded
 * entry-servers destructure `{ renderSSR, renderStream }`, so the brand must live on each FUNCTION (whose
 * reference survives the destructure + ES-module re-export), never on the container object.
 */
export function brandRenderFunctions<M extends { renderSSR: object; renderStream: object }>(mod: M, key: string): M {
  const contract = { key, contractVersion: RENDER_CONTRACT_VERSION };
  for (const fn of [mod.renderSSR, mod.renderStream]) {
    Object.defineProperty(fn, RENDER_CONTRACT_TAG, { value: contract, enumerable: false, configurable: true, writable: false });
  }
  return mod;
}
