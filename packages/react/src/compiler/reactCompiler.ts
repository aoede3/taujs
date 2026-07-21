/**
 * Internal (NOT a public `@taujs/react` entry): the React managed compiler contribution + shared plugin
 * helpers. `reactRenderer()` (the public `@taujs/react/renderer`) builds its contribution here; the raw
 * portable `pluginReact()` (`@taujs/react/plugin`) reuses the tag/preamble helpers.
 *
 * `@taujs/server` is a TYPE-ONLY reference - the managed brand is a dependency-free literal reproduced by
 * value, so the raw `pluginReact()` still works in a plain Vite project with no `@taujs/server` present.
 */
import react from '@vitejs/plugin-react';

import type { Plugin, PluginOption } from 'vite';
import type { CompilerImpl, ManagedContributionBrand, ManagedContributionShape, PreparedPlan } from '@taujs/server/renderer';

type ReactOptions = NonNullable<Parameters<typeof react>[0]>;

// Reproduced BY VALUE (never imported at runtime); the type-only `ManagedContributionBrand` makes a
// host-side brand bump fail this assignment at compile time.
const MANAGED_BRAND: ManagedContributionBrand = 'taujs.managed-plugin-contribution/v1';
const UNSCOPED_COMPILER_TAG = Symbol.for('taujs.unscoped-compiler');
export const REACT_KEY = 'react';

export function taujsReactPreambleFix(): Plugin {
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
export function tagUnscopedCompiler<T>(value: T, key: string): T {
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

/** Options for {@link buildReactContribution}: a required tsconfig `project`, plus React options; the
 * ownership filters (`include`/`exclude`) are RESERVED - the host computes them from the project. */
export type ReactCompilerOptions = { project: string } & Omit<ReactOptions, 'include' | 'exclude'>;

// Module-local object => REFERENCE identity (safeguard 1): every contribution from THIS installed
// @taujs/react copy shares it; a second installed copy yields a distinct object, so the host detects
// "one key, two implementations" and fails closed.
const reactCompilerImpl: CompilerImpl = {
  key: REACT_KEY,
  prepare: async (group, input) => {
    // Lazy so `typescript` (and the ownership machinery) never load for a raw `pluginReact()` user.
    const { computeReactOwnership } = await import('./reactOwnership.js');
    const { claims, boundaries, exclude, options } = computeReactOwnership(group, input);

    return {
      key: REACT_KEY,
      claims,
      boundaries,
      exclude,
      // Fresh per call (checkpoint §6). The renderer folds its OWN exclude in; the host supplies the
      // cross-key exclusions via `scope.exclude`. A managed compiler is NOT tagged - the unscoped tag
      // exists only so the host can spot a RAW `pluginReact()` running chain-globally.
      createPlugin: (scope): PluginOption => [
        react({ ...(options as ReactOptions), include: scope.include, exclude: [...exclude, ...scope.exclude] }),
        taujsReactPreambleFix(),
      ],
    } satisfies PreparedPlan;
  },
};

/** Build the React managed compiler contribution `reactRenderer()` carries (ESC-1 shape). */
export function buildReactContribution(opts: ReactCompilerOptions): ManagedContributionShape {
  const { project, ...reactOptions } = opts;
  if (!project) throw new Error('[taujs] reactRenderer requires a `project` tsconfig path.');
  if ('include' in reactOptions || 'exclude' in reactOptions) {
    throw new Error('[taujs] reactRenderer does not accept `include`/`exclude` - ownership is computed from the tsconfig `project`.');
  }

  return {
    brand: MANAGED_BRAND,
    key: REACT_KEY,
    impl: reactCompilerImpl,
    project,
    options: reactOptions,
  };
}
