/**
 * Internal: the render-module identity brand `@taujs/vue`'s `createRenderer` stamps on its output.
 *
 * Reproduced BY VALUE (never runtime-importing `@taujs/server`) so the brand survives the scaffold's
 * `export const { renderSSR, renderStream } = createRenderer(...)` destructure. The type-only
 * `RenderContractVersion` import makes a host contract-version bump fail this assignment at compile time.
 */
import type { RenderContractVersion } from '@taujs/server/renderer';

export const RENDER_CONTRACT_VERSION: RenderContractVersion = 'v1';
export const VUE_RENDERER_KEY = 'vue';

const RENDER_CONTRACT_TAG = Symbol.for('taujs.render-contract/v1');

/**
 * Stamp a non-enumerable render-contract brand on BOTH render functions and return the module. The brand
 * lives on each FUNCTION (whose reference survives the entry-server destructure + re-export), not on the
 * container object.
 */
export function brandRenderFunctions<M extends { renderSSR: object; renderStream: object }>(mod: M, key: string): M {
  const contract = { key, contractVersion: RENDER_CONTRACT_VERSION };
  for (const fn of [mod.renderSSR, mod.renderStream]) {
    Object.defineProperty(fn, RENDER_CONTRACT_TAG, { value: contract, enumerable: false, configurable: true, writable: false });
  }
  return mod;
}
