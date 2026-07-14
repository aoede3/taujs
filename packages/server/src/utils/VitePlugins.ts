import type { PluginOption, Plugin } from 'vite';

type PluginInput = PluginOption | PluginOption[] | readonly PluginOption[] | undefined;

/**
 * The reserved framework plugin-name prefix (RFC 0005 §5). A USER plugin whose `name` starts with
 * this is DROPPED - it may neither displace nor impersonate a framework plugin. The two internal τjs
 * plugins that legitimately carry it (`τjs-development-server-debug-logging`,
 * `τjs-ssr-server`) are exempt because they are appended as `internal`, never as a user source.
 *
 * Note: this is the Greek small letter tau (U+03C4), matching the internal plugins' literal names -
 * NOT the Latin "taujs" prefix the renderer wrappers use (`taujs:react-refresh-preamble-fix`), which
 * are ordinary user plugins and deliberately fall OUTSIDE the reservation.
 */
export const RESERVED_PLUGIN_PREFIX = 'τjs-';

function flattenPlugins(input: PluginInput): Plugin[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(flattenPlugins);

  return [input as Plugin];
}

/** An ordered, labelled source of user plugins fed into {@link composePlugins}. */
export type PluginSource = {
  /** Origin label surfaced in warnings: an `appId`, `config.vite`, or `taujsBuild.vite`. */
  source: string;
  plugins?: PluginInput;
};

/** A plugin-name collision across two or more user contributions: every declaring source + the winner. */
export type PluginCollision = {
  name: string;
  /** Every source that declared this name, in encounter order (may repeat if one source declares it twice). */
  sources: string[];
  /** The source whose instance is kept - the first occurrence. */
  winner: string;
};

/** A user plugin dropped for carrying the reserved framework prefix. */
export type ReservedPluginDrop = {
  name: string;
  source: string;
};

/**
 * The ONE collision message shared by dev and build (RFC 0005 §5): dev routes it to `logger.warn`,
 * build to `console.warn`, but the text is identical so the two modes report one format.
 */
export function pluginCollisionMessage({ name, sources, winner }: PluginCollision): string {
  return `Duplicate Vite plugin "${name}" declared by ${sources.join(', ')}; keeping ${winner} (first occurrence wins), other instance(s) dropped`;
}

/** The ONE reserved-prefix message shared by dev and build (RFC 0005 §5). */
export function reservedPluginMessage({ name, source }: ReservedPluginDrop): string {
  return `Vite plugin "${name}" from ${source} uses the reserved "${RESERVED_PLUGIN_PREFIX}" framework prefix and was dropped`;
}

/**
 * RFC 0005 §5 - the ONE plugin composition rule, shared by dev and build.
 *
 * Concatenates the given user `sources` IN DECLARED ORDER, flattening preset packs (arrays of
 * plugins) as it goes, then dedupes by plugin `name` with the FIRST occurrence winning across ALL
 * sources. Callers supply the order:
 *   - Dev (shared server): `apps` in config order, then `config.vite`, then `internal`.
 *   - Build (per app): `app`, then `config.vite`, then `taujsBuild.vite`, then `internal`.
 * (VS4 feeds the dev `config.vite` source once it flows; until then dev composes `apps` -> `internal`.)
 *
 * Every cross-source name collision is reported once via `onCollision` (name, each declaring source,
 * the winner). User plugins whose name starts with {@link RESERVED_PLUGIN_PREFIX} are dropped and
 * reported via `onReservedPrefix`.
 *
 * `internal` framework plugins are appended LAST and are EXEMPT from both the user dedupe and the
 * prefix reservation - a refactor cannot silently reorder framework hooks relative to user ones, and
 * a user plugin can never displace one. Build has no internal plugins today; the slot is reserved.
 *
 * Plugin OPTIONS are never serialised or compared - a plugin routinely holds functions and cyclic
 * state, so identity is by `name` alone. Nameless plugins (a valid `PluginOption` may omit `name`)
 * pass through UNDEDUPED: dedupe requires an identity to compare on, and inventing one would be worse
 * than tolerating a possible duplicate.
 */
export function composePlugins(opts: {
  sources: readonly PluginSource[];
  internal?: PluginInput;
  onCollision?: (collision: PluginCollision) => void;
  onReservedPrefix?: (drop: ReservedPluginDrop) => void;
}): Plugin[] {
  const winnerOf = new Map<string, string>(); // name -> first source that declared it (the winner)
  const declarersOf = new Map<string, string[]>(); // name -> every declaring source, in order
  const kept: Plugin[] = [];

  for (const { source, plugins } of opts.sources) {
    for (const plugin of flattenPlugins(plugins)) {
      const name = typeof plugin?.name === 'string' ? plugin.name : '';

      // Nameless: keep, never dedupe (dedupe requires identity; inventing one is worse). See jsdoc.
      if (!name) {
        kept.push(plugin);
        continue;
      }

      // Reserved framework prefix: a user plugin may not carry it. Drop before it can enter dedupe.
      if (name.startsWith(RESERVED_PLUGIN_PREFIX)) {
        opts.onReservedPrefix?.({ name, source });
        continue;
      }

      const declarers = declarersOf.get(name);
      if (declarers) {
        declarers.push(source); // collision: an earlier source already won this name
        continue;
      }

      declarersOf.set(name, [source]);
      winnerOf.set(name, source);
      kept.push(plugin);
    }
  }

  for (const [name, sources] of declarersOf) {
    if (sources.length > 1) opts.onCollision?.({ name, sources, winner: winnerOf.get(name)! });
  }

  // Internal framework plugins: appended LAST, exempt from user dedupe + the prefix reservation.
  return [...kept, ...flattenPlugins(opts.internal)];
}
