/**
 * Internal (NOT a public `@taujs/solid` entry): the Solid managed compiler contribution + shared plugin
 * helpers. The INTERNAL `solidRenderer()` (test/integration only - Solid is not yet a public renderer)
 * builds its contribution here; the raw portable `pluginSolid()` (`@taujs/solid/plugin`) reuses the tag helper.
 *
 * `@taujs/server` is a TYPE-ONLY reference - the managed brand is a dependency-free literal reproduced by
 * value, so the raw `pluginSolid()` still works in a plain Vite project with no `@taujs/server` present.
 */
import picomatch from 'picomatch';
import solid from 'vite-plugin-solid';

import type { PluginOption } from 'vite';
import type { CompilerImpl, EffectiveScope, ManagedContributionBrand, ManagedContributionShape, PreparedPlan } from '@taujs/server/renderer';


// vite-plugin-solid filters the RAW module id (query included) with a createFilter captured at
// construction (dist/esm/index.mjs: `if (!filter(id)) return null`), UNLIKE @vitejs/plugin-react which
// strips the query first. So a scoped `.tsx` include would miss `App.tsx?t=...` (HMR)/`App.tsx?v=...`
// (deps) and Solid would silently skip the file. Convert our matchers to query-tolerant RegExps for the
// ACTUAL plugin filter; the host diagnostic canonicalises the query away, so the two agree.
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

// Reproduced BY VALUE (never imported at runtime); the type-only `ManagedContributionBrand` makes a
// host-side brand bump fail this assignment at compile time.
const MANAGED_BRAND: ManagedContributionBrand = 'taujs.managed-plugin-contribution/v1';
const UNSCOPED_COMPILER_TAG = Symbol.for('taujs.unscoped-compiler');
export const SOLID_KEY = 'solid';

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

/**
 * Options for {@link buildSolidContribution}: a required tsconfig `project`, and NOTHING else.
 *
 * The managed compiler deliberately carries no Solid option bag. `solidRenderer()` exposes only
 * `{ project }`, so an internal bag could never be populated through the public API - it existed
 * only as a hidden escape hatch, and a hidden escape hatch around a compiler whose transform mode
 * is forced is exactly the shape that hides defects. Raw `pluginSolid()` at `@taujs/solid/plugin`
 * retains the full portable Vite option surface for anyone who needs it.
 */
export type SolidCompilerOptions = { project: string };

// Module-local object => REFERENCE identity (safeguard 1): every contribution from THIS installed
// @taujs/solid copy shares it; a second installed copy yields a distinct object, so the host detects
// "one key, two implementations" and fails closed.
const solidCompilerImpl: CompilerImpl = {
  key: SOLID_KEY,
  prepare: async (group, input) => {
    // Lazy so `typescript`/`vitefu` never load for a raw `pluginSolid()` user.
    const { computeSolidOwnership } = await import('./solidOwnership.js');
    const { claims, boundaries, exclude } = await computeSolidOwnership(group, input);

    return {
      key: SOLID_KEY,
      claims,
      boundaries,
      exclude,
      // Fresh per call (checkpoint §6). The renderer folds its OWN exclude in; the host supplies the
      // cross-key exclusions via `scope.exclude`. A managed compiler is NOT tagged.
      /**
       * `ssr: true` is UNCONDITIONAL and is the whole point of the managed compiler.
       *
       * It does not mean "always emit SSR output". It tells vite-plugin-solid to select output per
       * transform: Solid SSR output for SSR transforms, and HYDRATABLE DOM output for browser
       * transforms. Without it every transform emits non-hydratable DOM output - including the
       * server graph, where Solid's DOM runtime functions are `notSup` throw-stubs, so the first
       * SSR render dies with "Client-only API called on the server side".
       *
       * This was asserted by the design and by `solidRenderer()`'s own documentation but was NEVER
       * actually supplied here; no test drove a real SSR transform through a managed plugin, so
       * nothing caught it until a generated app was booted end to end.
       */
      createPlugin: (scope): PluginOption =>
        solid({
          ssr: true,
          include: toQueryTolerantMatchers(scope.include),
          exclude: toQueryTolerantMatchers([...exclude, ...scope.exclude]),
        }),
    } satisfies PreparedPlan;
  },
};

/** Build the Solid managed compiler contribution `solidRenderer()` carries (ESC-1 shape). */
export function buildSolidContribution(opts: SolidCompilerOptions): ManagedContributionShape {
  const { project, ...rest } = opts;
  if (!project) throw new Error('[taujs] solidRenderer requires a `project` tsconfig path.');
  // `{ project }` is the entire surface. Anything else - including the previously-tolerated
  // `include`/`exclude` and any vite-plugin-solid option - is rejected rather than silently
  // dropped, so a caller is told their intent is not supported instead of it vanishing.
  const unsupported = Object.keys(rest);
  if (unsupported.length > 0) {
    throw new Error(
      `[taujs] solidRenderer accepts only \`project\` (received: ${unsupported.join(', ')}). Ownership is computed from the tsconfig project, and the transform mode is fixed. Use pluginSolid() from '@taujs/solid/plugin' for raw Vite options.`,
    );
  }

  return {
    brand: MANAGED_BRAND,
    key: SOLID_KEY,
    impl: solidCompilerImpl,
    project,
    options: {},
  };
}
