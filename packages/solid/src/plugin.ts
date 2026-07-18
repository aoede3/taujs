/**
 * `@taujs/solid/plugin` - the Solid Vite plugin surface (ESC-1, RFC 0006).
 *
 * `vite-plugin-solid` is a **peer dependency only** (like `@vitejs/plugin-react` for `@taujs/react`):
 * consumers install it themselves. Two surfaces:
 *   - `pluginSolid()` - the raw, portable Solid plugin, unchanged for single-framework/standalone use
 *     (a real Vite plugin, no `@taujs/server` needed). Its plugin object carries a non-enumerable
 *     "unscoped compiler" tag ONLY so the τjs host can detect a raw JSX compiler running chain-globally
 *     alongside managed ownership (a hard error). Raw JSX-compiler use is DEPRECATED for multi-framework
 *     shared dev; use the scoped form.
 *   - `scopedPluginSolid({ project })` - a branded managed contribution for a τjs `plugins` array. The
 *     τjs host computes its scope (own claims MINUS other frameworks' claims) after seeing all apps and
 *     constructs the real plugin. `@taujs/server` is a type-only reference here - the brand is a
 *     dependency-free literal, so raw `pluginSolid()` still works with no `@taujs/server` present.
 *
 * This package is the ESC-1 COMPILER surface only; the Solid renderer lands post-GO (S1).
 */
import picomatch from 'picomatch';
import solid from 'vite-plugin-solid';

import type { Plugin, PluginOption } from 'vite';
import type { CompilerImpl, EffectiveScope, ManagedContributionBrand, PreparedPlan, TaujsManagedPluginContribution } from '@taujs/server/config';

type SolidOptions = NonNullable<Parameters<typeof solid>[0]>;

// vite-plugin-solid filters the RAW module id (query included) with a createFilter captured at
// construction (dist/esm/index.mjs: `if (!filter(id)) return null`), UNLIKE @vitejs/plugin-react which
// strips the query first (`id.split('?')`). So a scoped `.tsx` include would miss `App.tsx?t=...` (HMR)
// or `App.tsx?v=...` (deps) and Solid would silently skip the file. Convert our matchers to
// query-tolerant RegExps for the ACTUAL plugin filter (checkpoint §8); the host diagnostic already
// canonicalises the query away, so the two agree. React needs no equivalent.
const QUERY_TAIL = '(?:\\?[^?]*)?';
function toQueryTolerantMatchers(matchers: EffectiveScope['include']): RegExp[] {
  const out: RegExp[] = [];
  for (const matcher of matchers) {
    const base = typeof matcher === 'string' ? picomatch.makeRe(matcher, { dot: true }) : matcher;
    if (!base) continue;
    const source = base.source.endsWith('$') ? `${base.source.slice(0, -1)}${QUERY_TAIL}$` : `${base.source}${QUERY_TAIL}`;
    out.push(new RegExp(source, base.flags));
  }
  return out;
}

// Reproduced BY VALUE (never imported at runtime) so raw wrappers stay `@taujs/server`-free; the
// type-only `ManagedContributionBrand` makes a host-side brand bump fail this assignment at compile time.
const MANAGED_BRAND: ManagedContributionBrand = 'taujs.managed-plugin-contribution/v1';
const UNSCOPED_COMPILER_TAG = Symbol.for('taujs.unscoped-compiler');
const SOLID_KEY = 'solid';

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

export function pluginSolid(opts?: Parameters<typeof solid>[0]): PluginOption {
  return tagUnscopedCompiler(solid(opts) as Plugin, SOLID_KEY);
}

/** Options for {@link scopedPluginSolid}: a required tsconfig `project`, plus Solid options; the ownership
 * filters (`include`/`exclude`) are RESERVED - the host computes them from the project. */
export type ScopedPluginSolidOptions = { project: string } & Omit<SolidOptions, 'include' | 'exclude'>;

// Module-local object => REFERENCE identity (checkpoint section 3, safeguard 1): every contribution from
// THIS installed @taujs/solid copy shares it; a second installed copy yields a distinct object, so the
// host detects "one key, two implementations" and fails closed.
const solidCompilerImpl: CompilerImpl = {
  key: SOLID_KEY,
  prepare: async (group, input) => {
    // Lazy so `typescript`/`vitefu` never load for a raw `pluginSolid()` user.
    const { computeSolidOwnership } = await import('./compiler/solidOwnership.js');
    const { claims, boundaries, exclude, options } = await computeSolidOwnership(group, input);

    return {
      key: SOLID_KEY,
      claims,
      boundaries,
      exclude,
      // Fresh per call (checkpoint section 6). The renderer folds its OWN exclude in; the host supplies
      // the cross-key exclusions via `scope.exclude`. A managed compiler is NOT tagged.
      createPlugin: (scope): PluginOption =>
        solid({ ...(options as SolidOptions), include: toQueryTolerantMatchers(scope.include), exclude: toQueryTolerantMatchers([...exclude, ...scope.exclude]) }),
    } satisfies PreparedPlan;
  },
};

export function scopedPluginSolid(opts: ScopedPluginSolidOptions): TaujsManagedPluginContribution {
  const { project, ...solidOptions } = opts;
  if (!project) throw new Error('[taujs] scopedPluginSolid requires a `project` tsconfig path.');
  if ('include' in solidOptions || 'exclude' in solidOptions) {
    throw new Error('[taujs] scopedPluginSolid does not accept `include`/`exclude` - ownership is computed from the tsconfig `project`.');
  }

  const contribution = {
    brand: MANAGED_BRAND,
    key: SOLID_KEY,
    impl: solidCompilerImpl,
    project,
    options: solidOptions,
  };

  return contribution as unknown as TaujsManagedPluginContribution;
}
