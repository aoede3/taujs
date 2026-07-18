import { createFilter } from 'vite';

import {
  assertOneImplPerKey,
  classifyOwnership,
  collectPluginNames,
  effectiveScopeFor,
  findTaggedRawCompilers,
  groupByKey,
  partitionAppPlugins,
} from './ManagedPlugins';

import type { PluginOption, Plugin } from 'vite';
import type { ManagedContributionShape, ManagedGroupMember, OwnershipRegion, PrepareInput, PreparedPlan } from './ManagedPlugins';
import type { PluginSource } from './VitePlugins';

/**
 * ESC-1 - the renderer-neutral host pre-pass (RFC 0006 / `docs/solid` ESC-1 reduced checkpoint §4-§6).
 *
 * Two internal phases feed the existing `composePlugins` UNCHANGED:
 *   - Phase 1 {@link prepareOwnership}: once, before any Vite environment. Partition every configured
 *     app's `plugins`, group managed contributions by key, assert one implementation per key, and ask
 *     each renderer to prepare ONE plan for its same-key group against the GLOBAL ownership universe
 *     (all apps). Classify-only - NO Vite plugin is constructed here.
 *   - Phase 2 {@link assembleManagedSources}: per Vite environment, after its overrides resolve.
 *     Scan the resolved chain for tagged unscoped raw JSX compilers (hard error under managed
 *     ownership), construct FRESH managed compiler plugins for the keys this environment instantiates,
 *     and a FRESH fail-closed ownership diagnostic - all host-owned, prepended so the diagnostic sits
 *     first within the `enforce:'pre'` tier.
 *
 * When no app declares a managed contribution the pre-pass is a complete no-op: existing single-framework
 * projects compose exactly as before.
 */

/** One app's plugin declaration handed to phase 1 (the Vite-free core keeps `plugins` as `unknown[]`). */
export type AppPluginInput = {
  appId: string;
  appRoot: string;
  plugins: ReadonlyArray<unknown> | undefined;
};

/** The global preparation product phase 2 consumes. */
export type PreparedOwnership = {
  /** key -> the single prepared plan for that key's same-key group, over the global universe. */
  plans: Map<string, PreparedPlan>;
  /** appId -> that app's raw Vite plugins (managed contributions removed). */
  rawByApp: Map<string, PluginOption[]>;
  /** appId -> the distinct managed keys that app declares (build containment: instantiate only these). */
  keysByApp: Map<string, string[]>;
  /** True when any app declares a managed contribution. */
  active: boolean;
};

/**
 * Phase 1 - prepare the GLOBAL ownership universe from ALL configured apps (never a filtered subset, so
 * chain-global raw contributions can never leak into an unrelated app's build). Renderer-owned
 * `prepare()` is classify-only and async; the host groups, asserts identity, and awaits one plan per key.
 */
export async function prepareOwnership(apps: ReadonlyArray<AppPluginInput>, input: PrepareInput): Promise<PreparedOwnership> {
  const rawByApp = new Map<string, PluginOption[]>();
  const keysByApp = new Map<string, string[]>();
  const members: ManagedGroupMember[] = [];

  for (const app of apps) {
    const { raw, managed } = partitionAppPlugins(app.appId, app.plugins);
    rawByApp.set(app.appId, raw);
    keysByApp.set(app.appId, [...new Set(managed.map((contribution) => contribution.key))]);
    for (const contribution of managed) {
      members.push({ contribution, appId: app.appId, appRoot: app.appRoot });
    }
  }

  const plans = new Map<string, PreparedPlan>();
  if (members.length > 0) {
    for (const [key, group] of groupByKey(members)) {
      const impl = assertOneImplPerKey(key, group);
      const plan = await impl.prepare(group, input);
      if (plan.key !== key) throw new Error(`[taujs] renderer "${key}" returned a plan for key "${plan.key}".`);
      plans.set(key, plan);
    }
  }

  return { plans, rawByApp, keysByApp, active: members.length > 0 };
}

/**
 * Phase 2 - assemble the host-owned managed sources for ONE Vite environment. Returns the ordered
 * `PluginSource[]` to PREPEND before the environment's user sources (diagnostic first, then the managed
 * compilers - all `enforce:'pre'`, so within Vite's stable pre tier the diagnostic runs first).
 */
export function assembleManagedSources(opts: {
  prepared: PreparedOwnership;
  /** Keys to construct in THIS environment: dev = all active keys; build = this app's keys only (§6). */
  keysToInstantiate: ReadonlyArray<string>;
  /** Every raw plugin in this environment's resolved chain (for tag-scan + name-collision). */
  resolvedChain: ReadonlyArray<unknown>;
  /** Environment label surfaced in errors (`'dev'` / `'build:<entry>'`). */
  env: string;
  /** Non-throwing warning sink (dev logger / build console). */
  warn: (message: string) => void;
}): { hostSources: PluginSource[] } {
  const { prepared, keysToInstantiate, resolvedChain, env, warn } = opts;

  // No managed ownership anywhere -> nothing to add; existing projects are untouched.
  if (!prepared.active || keysToInstantiate.length === 0) {
    // Still enforce the different-key hard error if a tagged raw compiler coexists with managed
    // ownership declared elsewhere (dev shares one chain; a filtered build without this app's key does
    // not, and correctly does not fail here).
    if (prepared.active) failOnTaggedRawCompilers(prepared, resolvedChain, env);
    return { hostSources: [] };
  }

  // §2 blocking-gap rule: any tagged unscoped raw JSX compiler alongside managed ownership is a hard
  // error, key- and name-independent (a chain-global raw React compiler contaminates Solid TSX while
  // the diagnostic - which sees only managed claims - reports a single owner).
  failOnTaggedRawCompilers(prepared, resolvedChain, env);

  // Construct FRESH managed compiler plugins for this environment (never reuse across builds, §6).
  const managedPlugins: PluginOption[] = [];
  const managedNames: string[] = [];
  for (const key of keysToInstantiate) {
    const plan = prepared.plans.get(key);
    if (!plan) throw new Error(`[taujs:${env}] no prepared ownership plan for compiler key "${key}".`);
    const scope = effectiveScopeFor(key, prepared.plans);
    // The renderer builds this with its own Vite type instance (see PreparedPlan.createPlugin); cast to
    // the host's PluginOption at this one boundary before it enters composePlugins.
    const plugin = plan.createPlugin(scope) as PluginOption;
    managedPlugins.push(plugin);
    for (const name of collectPluginNames(Array.isArray(plugin) ? plugin : [plugin])) managedNames.push(name);
  }

  // Secondary net: a raw plugin whose NAME collides with a managed compiler (e.g. direct
  // @vitejs/plugin-react alongside managed React - same underlying plugin names) is a hard error; a
  // silent first-wins drop could discard user compiler options.
  const managedNameSet = new Set(managedNames);
  for (const name of collectPluginNames(resolvedChain)) {
    if (managedNameSet.has(name)) {
      throw new Error(
        `[taujs:${env}] a raw Vite plugin named "${name}" collides with a managed compiler of the same name. Remove the raw compiler plugin - the managed contribution (scopedPluginReact/scopedPluginSolid) supplies it.`,
      );
    }
  }

  const diagnostic = createOwnershipDiagnostic(prepared.plans, env, warn);

  return {
    hostSources: [
      { source: 'taujs:ownership-diagnostic', plugins: [diagnostic] },
      { source: 'taujs:managed-compilers', plugins: managedPlugins },
    ],
  };
}

function failOnTaggedRawCompilers(prepared: PreparedOwnership, resolvedChain: ReadonlyArray<unknown>, env: string): void {
  const tagged = findTaggedRawCompilers(resolvedChain);
  if (tagged.length === 0) return;
  const first = tagged[0]!;
  const scoped = first.key === 'react' ? 'scopedPluginReact()' : first.key === 'solid' ? 'scopedPluginSolid()' : `scopedPlugin${first.key}()`;
  throw new Error(
    `[taujs:${env}] a raw JSX compiler (unscoped "${first.key}", plugin "${first.name}") is active alongside managed compiler ownership. ` +
      `Raw pluginReact()/pluginSolid() compile chain-globally and contaminate other frameworks' files. Use the scoped equivalent (${scoped}).`,
  );
}

/** Path canonicalisation for ownership matching (checkpoint §8). */
function canonicaliseId(id: string): string | undefined {
  if (id.includes('\0')) return undefined; // virtual / null-byte ids are excluded
  const query = id.indexOf('?');
  const withoutQuery = query === -1 ? id : id.slice(0, query);
  return withoutQuery.replace(/\\/g, '/');
}

const JSX_ID = /\.[jt]sx$/;

/**
 * The fail-closed ownership diagnostic (safeguard 2, checkpoint §5). Host-owned, `enforce:'pre'`,
 * transforms NOTHING - it evaluates the renderer-supplied claim/boundary matchers per resolved JSX/TSX
 * id and hard-errors (or warns) on ambiguous ownership before esbuild can silently swallow it. Dedup is
 * per environment, keyed by canonical id + severity.
 */
export function createOwnershipDiagnostic(plans: ReadonlyMap<string, PreparedPlan>, env: string, warn: (message: string) => void): Plugin {
  const keys = [...plans.keys()];
  const claimsFilter = new Map<string, (id: string) => boolean>();
  const boundaryFilter = new Map<string, (id: string) => boolean>();
  for (const [key, plan] of plans) {
    // The project's own exclude is subtracted from BOTH claims and boundaries (checkpoint §3), so a
    // deliberately excluded file is neither owned nor flagged. createFilter([]) matches everything -
    // guard so an empty include set owns nothing.
    const exclude = plan.exclude && plan.exclude.length ? plan.exclude : undefined;
    claimsFilter.set(key, plan.claims.length ? createFilter(plan.claims, exclude) : () => false);
    boundaryFilter.set(key, plan.boundaries.length ? createFilter(plan.boundaries, exclude) : () => false);
  }
  const seen = new Set<string>();

  return {
    name: 'taujs:ownership-diagnostic',
    enforce: 'pre',
    transform(_code, id) {
      const canonical = canonicaliseId(id);
      if (!canonical || !JSX_ID.test(canonical)) return null;

      const owners = keys.filter((key) => claimsFilter.get(key)!(canonical));
      let region: OwnershipRegion = 'outside';
      if (owners.length === 0) {
        region = keys.some((key) => boundaryFilter.get(key)!(canonical)) ? 'expected-framework' : 'outside';
      }

      const severity = classifyOwnership(owners, region);
      if (severity === 'ok' || severity === 'ignore') return null;

      const dedupeKey = `${severity}:${canonical}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);

      if (severity === 'error') {
        if (owners.length >= 2) {
          this.error(
            `[taujs:${env}] "${canonical}" is claimed by more than one framework compiler (${owners.join(', ')}). ` +
              `A doubly-claimed file is excluded from every compiler and fails at runtime. Assign it to exactly one compiler's tsconfig project.`,
          );
        } else {
          this.error(
            `[taujs:${env}] "${canonical}" lies within a framework compiler's declared boundary but is owned by NO compiler ` +
              `(its tsconfig project does not include it). It would fall through to esbuild and fail at runtime (e.g. "React is not defined"). ` +
              `Add it to the owning compiler's tsconfig project.`,
          );
        }
      } else {
        warn(`[taujs:${env}] "${canonical}" lies within a declared project boundary with no compiler; esbuild will handle it.`);
      }

      return null;
    },
  };
}
