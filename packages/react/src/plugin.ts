/**
 * `@taujs/react/plugin` - the React Vite plugin surface.
 *
 * `@vitejs/plugin-react` is a **peer dependency only**: intentionally NOT installed as a dependency to
 * avoid coupling τjs to a specific Vite toolchain or React-refresh implementation. Consumers using
 * `@taujs/react/plugin` install `@vitejs/plugin-react` themselves.
 *
 * Two surfaces (ESC-1, RFC 0006):
 *   - `pluginReact()` - the raw, portable React plugin pack, unchanged for single-framework/standalone
 *     use (real Vite plugins, no `@taujs/server` needed). Its plugin objects carry a non-enumerable
 *     "unscoped compiler" tag ONLY so the τjs host can detect a raw JSX compiler running chain-globally
 *     alongside managed ownership (a hard error). Raw JSX-compiler use is DEPRECATED for multi-framework
 *     shared dev; use the scoped form.
 *   - `scopedPluginReact({ project })` - a branded managed contribution for a τjs `plugins` array. The
 *     τjs host computes its scope (own claims MINUS other frameworks' claims) after seeing all apps and
 *     constructs the real plugin. `@taujs/server` is a type-only reference here - the brand is a
 *     dependency-free literal, so raw `pluginReact()` still works with no `@taujs/server` present.
 */
import react from '@vitejs/plugin-react';

import type { Plugin, PluginOption } from 'vite';
import type { CompilerImpl, ManagedContributionBrand, PreparedPlan, TaujsManagedPluginContribution } from '@taujs/server/config';

type ReactOptions = NonNullable<Parameters<typeof react>[0]>;

// Reproduced BY VALUE (never imported at runtime) so raw wrappers stay `@taujs/server`-free; the
// type-only `ManagedContributionBrand` makes a host-side brand bump fail this assignment at compile time.
const MANAGED_BRAND: ManagedContributionBrand = 'taujs.managed-plugin-contribution/v1';
const UNSCOPED_COMPILER_TAG = Symbol.for('taujs.unscoped-compiler');
const REACT_KEY = 'react';

function taujsReactPreambleFix(): Plugin {
  return {
    name: 'taujs:react-refresh-preamble-fix',
    apply: 'serve',
    enforce: 'post',
    transformIndexHtml(html) {
      if (html.includes('__vite_plugin_react_preamble_installed__')) return html;

      if (!html.includes('/@react-refresh')) return html;

      return html.replace(
        /<head([^>]*)>/i,
        `<head$1><script>window.__vite_plugin_react_preamble_installed__=true;window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(t)=>t;</script>`,
      );
    },
  };
}

/** Stamp a non-enumerable unscoped-compiler tag on every plugin object in a (possibly nested) pack. */
function tagUnscopedCompiler<T>(value: T, key: string): T {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      try {
        Object.defineProperty(node, UNSCOPED_COMPILER_TAG, { value: key, enumerable: false, configurable: true });
      } catch {
        /* frozen/sealed plugin objects are left untagged - detection is best-effort robustness */
      }
    }
  };
  walk(value);
  return value;
}

export function pluginReact(opts?: Parameters<typeof react>[0]): PluginOption {
  return tagUnscopedCompiler([react(opts), taujsReactPreambleFix()], REACT_KEY);
}

/** Options for {@link scopedPluginReact}: a required tsconfig `project`, plus React options; the ownership
 * filters (`include`/`exclude`) are RESERVED - the host computes them from the project. */
export type ScopedPluginReactOptions = { project: string } & Omit<ReactOptions, 'include' | 'exclude'>;

// Module-local object => REFERENCE identity (checkpoint section 3, safeguard 1): every contribution from
// THIS installed @taujs/react copy shares it; a second installed copy yields a distinct object, so the
// host detects "one key, two implementations" and fails closed.
const reactCompilerImpl: CompilerImpl = {
  key: REACT_KEY,
  prepare: async (group, input) => {
    // Lazy so `typescript` (and the ownership machinery) never load for a raw `pluginReact()` user.
    const { computeReactOwnership } = await import('./compiler/reactOwnership.js');
    const { claims, boundaries, exclude, options } = computeReactOwnership(group, input);

    return {
      key: REACT_KEY,
      claims,
      boundaries,
      exclude,
      // Fresh per call (checkpoint section 6). The renderer folds its OWN exclude in; the host supplies
      // the cross-key exclusions via `scope.exclude`. A managed compiler is NOT tagged - the unscoped
      // tag exists only so the host can spot a RAW `pluginReact()` running chain-globally.
      createPlugin: (scope): PluginOption => [
        react({ ...(options as ReactOptions), include: scope.include, exclude: [...exclude, ...scope.exclude] }),
        taujsReactPreambleFix(),
      ],
    } satisfies PreparedPlan;
  },
};

export function scopedPluginReact(opts: ScopedPluginReactOptions): TaujsManagedPluginContribution {
  const { project, ...reactOptions } = opts;
  if (!project) throw new Error('[taujs] scopedPluginReact requires a `project` tsconfig path.');
  if ('include' in reactOptions || 'exclude' in reactOptions) {
    throw new Error('[taujs] scopedPluginReact does not accept `include`/`exclude` - ownership is computed from the tsconfig `project`.');
  }

  const contribution = {
    brand: MANAGED_BRAND,
    key: REACT_KEY,
    impl: reactCompilerImpl,
    project,
    options: reactOptions,
  };

  return contribution as unknown as TaujsManagedPluginContribution;
}
