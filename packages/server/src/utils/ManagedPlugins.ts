import type { PluginOption } from 'vite';

/**
 * ESC-1 - managed compiler-plugin contributions (RFC 0006 / `docs/solid` ESC-1 reduced checkpoint).
 *
 * THE PROBLEM. A preconstructed React/Solid Vite plugin cannot be globally scoped: `vite-plugin-solid`
 * (and `@vitejs/plugin-react`) capture their `createFilter` at CONSTRUCTION, and the correct scope for
 * a file - "the files this framework owns MINUS every other framework's files" - only exists after the
 * host has seen ALL configured apps. So a renderer hands the host a LAZY, branded contribution
 * (identity + a `project` pointer + opaque options + a preparation hook), and the host constructs the
 * real plugin once the combined ownership universe is known.
 *
 * THIS MODULE is the pure, Vite-value-free contract + host-side algebra:
 *   - the dependency-free brand (renderers reproduce the literal by value, never import it at runtime);
 *   - the opaque public `TaujsManagedPluginContribution` type (the ONE new public concept);
 *   - the internal shapes the host and the renderers agree on (non-public, versioned by the brand);
 *   - the pure helpers the two-phase host pre-pass is built from (partition, group, identity assertion,
 *     effective-scope algebra, ownership-severity classification).
 *
 * The host is framework-NEUTRAL: it never constructs `solid()`/`react()`, never derives tsconfig
 * boundaries, and contains no `if (solid)`/`if (react)` branch. All framework knowledge lives behind
 * {@link CompilerImpl.prepare} in `@taujs/react` / `@taujs/solid` (ESC-0 ruling: generic aggregation +
 * ownership diagnostics only).
 *
 * Only `import type` from `vite` here - this module must stay runtime-Vite-free so it can be imported
 * from the config surface without pulling Vite into a plain consumer's runtime.
 */

/**
 * The structural brand marking a managed contribution, versioned so an incompatible internal shape is a
 * different brand rather than a silent mismatch. Renderers reproduce this LITERAL by value (they must
 * not import it at runtime - the brand is dependency-free so raw `pluginReact()`/`pluginSolid()` work in
 * a plain Vite project with no `@taujs/server` present). The literal TYPE {@link ManagedContributionBrand}
 * IS type-imported by renderers, so a host-side brand bump breaks their hardcoded assignment at compile
 * time - a safety net without a runtime dependency.
 */
export const MANAGED_CONTRIBUTION_BRAND = 'taujs.managed-plugin-contribution/v1' as const;
export type ManagedContributionBrand = typeof MANAGED_CONTRIBUTION_BRAND;

/** A positive, Vite-`createFilter`-compatible ownership matcher (checkpoint §3 "faithful positive matchers"). */
export type OwnershipMatcher = string | RegExp;

/** The effective scope the host computes for one compiler (checkpoint §3 set-algebra). */
export type EffectiveScope = {
  /** This key's merged ownership claims. */
  include: OwnershipMatcher[];
  /** All OTHER keys' merged claims only (the tsconfig's own `exclude` is already folded into the claims). */
  exclude: OwnershipMatcher[];
};

/**
 * Generic, framework-neutral input the host passes to renderer preparation. Carries NO framework
 * knowledge - the renderer already holds its `project`/options via the group members.
 */
export type PrepareInput = {
  /** τjs `projectRoot`; relative `project` paths resolve from here identically in dev and build (checkpoint §2). */
  projectRoot: string;
  /** The Vite lifecycle this preparation feeds; preparation stays classify-only regardless (checkpoint §6). */
  lifecycle: 'dev' | 'build';
};

/**
 * The plan a renderer returns from {@link CompilerImpl.prepare} for one same-key group. Classify-only:
 * `createPlugin` is NOT called here - the host calls it per Vite environment, and only for keys that
 * environment instantiates (build containment, checkpoint §6).
 */
export type PreparedPlan = {
  /** The diagnostic key this plan owns (`'react'`/`'solid'`). */
  key: string;
  /**
   * The positive ownership set for this key: the tsconfig project's `include` globs (resolving
   * `references`/`extends`) plus the exact node_modules package-directory matchers, compiled to
   * `createFilter`-compatible patterns. Same-key union across apps = array union. The project's own
   * `exclude` is carried separately in {@link PreparedPlan.exclude} and subtracted by the host when it
   * evaluates ownership (a positive matcher list cannot encode subtraction).
   */
  claims: OwnershipMatcher[];
  /**
   * Renderer-SUPPLIED expected-owner boundary matchers (checkpoint §3/§5) - the region a JSX/TSX file
   * SHOULD be owned in (broader than `claims`, so a file in the boundary that no compiler claims is a
   * zero-owner gap). The host evaluates these; it never derives tsconfig boundaries itself. "Expected
   * boundary" is NOT the whole app root: {@link PreparedPlan.exclude} is subtracted here too, so a
   * deliberately excluded file (fixtures, generated files) falls OUTSIDE the boundary and is not
   * reported as a zero-owner error.
   */
  boundaries: OwnershipMatcher[];
  /**
   * Renderer-SUPPLIED negative matchers = the tsconfig project's own `exclude` (checkpoint §3: "the
   * tsconfig's own exclude is already folded into the claims"). The host subtracts these from BOTH
   * `claims` and `boundaries` when evaluating ownership/region - a file the project deliberately
   * excludes is neither owned nor flagged. Cross-key exclusion (the effective-scope algebra) uses the
   * OTHER keys' `claims` only; the renderer folds its own `exclude` into the compiler it constructs.
   */
  exclude?: OwnershipMatcher[];
  /**
   * Constructs a FRESH real Vite plugin for the given effective scope. Called afresh per `vite.build()`
   * invocation and once per active renderer in dev - constructed plugins may carry lifecycle state and
   * are never reused (checkpoint §6). The renderer folds its own options (e.g. `ssr`) in here.
   */
  createPlugin: (scope: EffectiveScope) => PluginOption;
};

/**
 * A renderer's implementation token. Its OBJECT IDENTITY is the implementation identity (correction 4):
 * every contribution produced by one installed copy of `@taujs/react` shares one `CompilerImpl` object;
 * two installed copies/versions produce two distinct objects, so the host detects "one key, two impls"
 * and fails closed. NOT a string (indistinguishable across copies) and NOT `Symbol.for()` (a global name
 * collapses distinct copies).
 */
export type CompilerImpl = {
  /** The grouping/diagnostic key (`'react'`/`'solid'`); must equal every member contribution's `key`. */
  readonly key: string;
  /**
   * Renderer-owned group preparation (async; classify-only). Receives the COMPLETE same-key group and
   * the generic input; merges the group's options deterministically (incompatible chain-global options
   * fail BEFORE Vite starts) and returns ONE {@link PreparedPlan}.
   */
  prepare: (group: ReadonlyArray<ManagedGroupMember>, input: PrepareInput) => Promise<PreparedPlan>;
};

/**
 * The runtime shape a renderer factory produces. NON-public and unstable (versioned by the brand); the
 * public face is the opaque {@link TaujsManagedPluginContribution}. App association is added by the host
 * at grouping time (the renderer does not know which app it lands in), not carried here.
 */
export type ManagedContributionShape = {
  readonly brand: ManagedContributionBrand;
  /** Diagnostic key + grouping axis (`'react'`/`'solid'`); equals `impl.key`. */
  readonly key: string;
  /** Reference-identity implementation token (see {@link CompilerImpl}). */
  readonly impl: CompilerImpl;
  /** tsconfig project pointer; relative resolves from `projectRoot`, absolute stays absolute (checkpoint §2). */
  readonly project: string;
  /** Opaque renderer options (the host never introspects them). Managed filter options are RESERVED. */
  readonly options: unknown;
};

/** A managed contribution paired with the app it was declared in (host-side, added during partition). */
export type ManagedGroupMember = {
  contribution: ManagedContributionShape;
  appId: string;
  appRoot: string;
};

declare const MANAGED_OPAQUE: unique symbol;
/**
 * The ONE new public concept: an opaque managed compiler contribution. Users obtain one ONLY from a
 * renderer factory (`scopedPluginReact`/`scopedPluginSolid`) and never construct or introspect it. It
 * rides the existing per-app `plugins` array; the host extracts it before `composePlugins`.
 */
export type TaujsManagedPluginContribution = { readonly [MANAGED_OPAQUE]: true };

/** Structural, forgery-tolerant recogniser for a managed contribution (host-side). */
export function isManagedContribution(value: unknown): value is ManagedContributionShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.brand !== MANAGED_CONTRIBUTION_BRAND) return false;
  if (typeof v.key !== 'string' || typeof v.project !== 'string') return false;
  const impl = v.impl as Record<string, unknown> | null | undefined;
  return typeof impl === 'object' && impl !== null && typeof impl.key === 'string' && typeof impl.prepare === 'function';
}

/** The result of partitioning one app's `plugins` array. */
export type AppPluginPartition = {
  /** Ordinary Vite plugins (including nested arrays that contain no managed contribution). */
  raw: PluginOption[];
  /** Managed contributions declared as DIRECT entries. */
  managed: ManagedContributionShape[];
};

function containsManaged(array: readonly unknown[]): boolean {
  for (const entry of array) {
    if (isManagedContribution(entry)) return true;
    if (Array.isArray(entry) && containsManaged(entry)) return true;
  }
  return false;
}

/**
 * Partition one app's `plugins` into raw Vite plugins vs managed contributions - DIRECT entries only
 * (checkpoint §2 correction 6). `PluginOption` permits nested arrays; a branded object nested inside one
 * is a HARD startup error - it must never leak into `composePlugins` where it could be mistaken for a
 * Vite plugin.
 */
export function partitionAppPlugins(appId: string, plugins: ReadonlyArray<unknown> | undefined): AppPluginPartition {
  const raw: PluginOption[] = [];
  const managed: ManagedContributionShape[] = [];

  for (const entry of plugins ?? []) {
    if (isManagedContribution(entry)) {
      managed.push(entry);
      continue;
    }
    if (Array.isArray(entry) && containsManaged(entry)) {
      throw new Error(
        `[taujs] app "${appId}": a managed compiler contribution (scopedPluginReact/scopedPluginSolid) must be a DIRECT entry of the app's \`plugins\` array, not nested inside a sub-array.`,
      );
    }
    raw.push(entry as PluginOption);
  }

  return { raw, managed };
}

/** Group managed members by their diagnostic key. Duplicate keys are EXPECTED and merge (checkpoint §4). */
export function groupByKey(members: ReadonlyArray<ManagedGroupMember>): Map<string, ManagedGroupMember[]> {
  const groups = new Map<string, ManagedGroupMember[]>();
  for (const member of members) {
    const key = member.contribution.key;
    const existing = groups.get(key);
    if (existing) existing.push(member);
    else groups.set(key, [member]);
  }
  return groups;
}

/**
 * Assert exactly one renderer implementation per key group (safeguard 1, non-removable). Two different
 * `CompilerImpl` references claiming the same key means two installed copies/versions of a renderer -
 * a HARD configuration error, never a silent first-wins.
 */
export function assertOneImplPerKey(key: string, group: ReadonlyArray<ManagedGroupMember>): CompilerImpl {
  const impls = new Set(group.map((member) => member.contribution.impl));
  if (impls.size !== 1) {
    throw new Error(
      `[taujs] compiler key "${key}" is claimed by ${impls.size} different renderer implementations. This usually means two copies or versions of the same renderer package are installed - deduplicate them.`,
    );
  }
  const impl = group[0]!.contribution.impl;
  if (impl.key !== key) {
    throw new Error(`[taujs] managed contribution key "${key}" does not match its implementation key "${impl.key}".`);
  }
  return impl;
}

/**
 * The effective-scope algebra (checkpoint §3): `include` = this key's merged claims; `exclude` = the
 * union of all OTHER keys' merged claims ONLY. A file claimed by two keys therefore lands in BOTH
 * excludes and is owned by NEITHER effective plugin - the exact hazard the fail-closed ownership
 * diagnostic (safeguard 2) exists to catch before it reaches esbuild.
 */
export function effectiveScopeFor(key: string, plans: ReadonlyMap<string, PreparedPlan>): EffectiveScope {
  const own = plans.get(key);
  if (!own) throw new Error(`[taujs] no prepared plan for compiler key "${key}".`);

  const exclude: OwnershipMatcher[] = [];
  for (const [otherKey, plan] of plans) {
    if (otherKey === key) continue;
    exclude.push(...plan.claims);
  }

  return { include: own.claims, exclude };
}

/**
 * The global-symbol tag a raw JSX-compiler wrapper (`pluginReact()`/`pluginSolid()`) stamps on its
 * returned plugin OBJECTS, valued with its unscoped compiler key (`'react'`/`'solid'`). A global symbol
 * is deliberate here: unlike the implementation-identity token it needs cross-copy DETECTION, not
 * distinctness, and the renderers reproduce `Symbol.for(UNSCOPED_COMPILER_TAG)` by value so the wrappers
 * stay portable to a plain Vite project (no `@taujs/server` import). The host reads it ONLY for the
 * different-key raw/managed diagnostic (checkpoint §2 blocking-gap rule).
 */
export const UNSCOPED_COMPILER_TAG = 'taujs.unscoped-compiler';

/** Read the unscoped-compiler key a raw wrapper stamped on a plugin object, if any. */
export function readUnscopedCompilerTag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tag = (value as Record<symbol, unknown>)[Symbol.for(UNSCOPED_COMPILER_TAG)];
  return typeof tag === 'string' ? tag : undefined;
}

/** A tagged unscoped raw compiler found in a resolved plugin chain. */
export type TaggedRawCompiler = { key: string; name: string };

/**
 * Walk a resolved plugin chain (nested arrays included - detection only) and collect every tagged
 * unscoped raw JSX compiler. Used per Vite environment (checkpoint §4 phase 2): with managed JSX
 * ownership active, ANY hit is a hard configuration error, key- and name-independent.
 */
export function findTaggedRawCompilers(chain: ReadonlyArray<unknown> | undefined): TaggedRawCompiler[] {
  const found: TaggedRawCompiler[] = [];
  const walk = (entries: ReadonlyArray<unknown> | undefined): void => {
    for (const entry of entries ?? []) {
      if (Array.isArray(entry)) {
        walk(entry);
        continue;
      }
      const key = readUnscopedCompilerTag(entry);
      if (key !== undefined) {
        const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '(anonymous)';
        found.push({ key, name });
      }
    }
  };
  walk(chain);
  return found;
}

/** Flatten a resolved plugin chain (nested arrays included) to the plugin objects that carry a `name`. */
export function collectPluginNames(chain: ReadonlyArray<unknown> | undefined): string[] {
  const names: string[] = [];
  const walk = (entries: ReadonlyArray<unknown> | undefined): void => {
    for (const entry of entries ?? []) {
      if (Array.isArray(entry)) {
        walk(entry);
        continue;
      }
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name === 'string') names.push(name);
    }
  };
  walk(chain);
  return names;
}

/** Which declared region a resolved id falls in, from the renderer-supplied boundaries (checkpoint §5). */
export type OwnershipRegion = 'expected-framework' | 'expected-generic' | 'outside';
/** The severity the ownership diagnostic reports for one resolved id. */
export type OwnershipSeverity = 'ok' | 'error' | 'warning' | 'ignore';

/**
 * The fail-closed ownership severity table (checkpoint §5). Owners are DISTINCT keys (same-key merge has
 * already collapsed duplicate keys to one owner):
 *   - exactly 1 owner            -> OK (that compiler transforms it)
 *   - >= 2 different-key owners   -> HARD ERROR (the double-claim / excluded-from-both hazard)
 *   - 0 owners, expected-framework boundary -> HARD ERROR (the "React is not defined" mechanism)
 *   - 0 owners, expected-generic boundary   -> WARNING
 *   - 0 owners, outside all boundaries      -> ignored (Vite/esbuild's concern)
 */
export function classifyOwnership(ownerKeys: readonly string[], region: OwnershipRegion): OwnershipSeverity {
  const owners = new Set(ownerKeys);
  if (owners.size === 1) return 'ok';
  if (owners.size >= 2) return 'error';
  if (region === 'expected-framework') return 'error';
  if (region === 'expected-generic') return 'warning';
  return 'ignore';
}
