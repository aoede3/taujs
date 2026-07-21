import { createPlugin } from 'seroval';

import type { AsyncParsePluginContext, Plugin, SerializePluginContext, SerovalNode, StreamParsePluginContext, SyncParsePluginContext } from 'seroval';

/**
 * The τjs error sanitiser (design 5, mandate M5) - a PURE DISCLOSURE-CONTROL TRANSFORM.
 *
 * Solid serialises boundary-handled errors and rejected application resources into the HTML
 * through seroval, WITH their message, stack, cause and custom properties. S0-C2 measured secret
 * messages and absolute server paths reaching the page in development AND production. This plugin
 * is installed FIRST in Solid's plugin chain (custom plugins are prepended,
 * solid-js/web/dist/server.js:151) so it pre-empts seroval's built-in Error node, and it is
 * NON-DISABLEABLE: no option turns it off and user seroval plugins are not exposed in v1.
 *
 * FIXED PUBLIC SHAPE. Every matched error serialises as exactly
 * `{ name: 'Error', message: '[redacted]' }`. The original `name` is NOT preserved: `Error.
 * prototype.name` is writable, so an app-controlled name is an unbounded disclosure channel - an
 * error named `ValidationError(user=alice@example.com ...)` would otherwise reach the page
 * verbatim through the one component whose entire job is preventing that. The V6-checks reference
 * candidate retained `name`; that policy is SUPERSEDED and must not be copied back.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (v6 ruling, and the SEAM-proof behind it): it emits no
 * callback, log, metric, trace or provenance signal, and it has no public configuration. An
 * ordinary application `Error` value reaches it through the IDENTICAL seam as a rejected
 * resource's reason - the two are byte-identical at this boundary - so any emission here would be
 * a false report of a render failure on a successful render. It does not know why the value
 * exists and must not try to infer it.
 *
 * The cost, accepted by the ruling: ordinary `Error` values are redacted too. An application that
 * needs a transportable domain error sends an explicit safe DTO such as
 * `{ code: 'NOT_FOUND', publicMessage: 'Item unavailable' }`, not a native `Error` carrying a
 * stack and a cause across the browser boundary.
 */

/** The neutral constants that replace every matched error's identity. */
export const REDACTED_NAME = 'Error';
export const REDACTED_MESSAGE = '[redacted]';

/** Both members are `SerovalNode`s - what `PluginInfo` requires and what `ctx.serialize` consumes. */
export type SanitisedErrorInfo = {
  name: SerovalNode;
  message: SerovalNode;
};

type SyncishParseContext = SyncParsePluginContext | StreamParsePluginContext;

/**
 * Produce the fixed envelope. Nothing is read from the source error, so `stack`, `cause` and every
 * custom property are stripped BY CONSTRUCTION rather than by enumeration - there is no property
 * list to keep in sync with, and a future Error shape cannot leak through a gap in one.
 */
function sanitise(ctx: SyncishParseContext): SanitisedErrorInfo {
  return { name: ctx.parse(REDACTED_NAME), message: ctx.parse(REDACTED_MESSAGE) };
}

async function sanitiseAsync(ctx: AsyncParsePluginContext): Promise<SanitisedErrorInfo> {
  return { name: await ctx.parse(REDACTED_NAME), message: await ctx.parse(REDACTED_MESSAGE) };
}

export const SanitisedErrorPlugin: Plugin<Error, SanitisedErrorInfo> = createPlugin<Error, SanitisedErrorInfo>({
  tag: 'taujs/solid/SanitisedError',

  /**
   * SUPPORTED MATCHING BOUNDARY (R2), deliberately narrow: same-realm `Error` instances, plus the
   * same-realm Errors Solid's `castError` (solid-js/dist/server.js:607) creates for thrown or
   * rejected cross-realm and non-Error reasons - it wraps them as
   * `new Error('Unknown error', { cause: original })`, which is why stripping `cause` is
   * load-bearing for disclosure and not merely stack hygiene.
   *
   * An ordinary CROSS-REALM Error supplied as successful application data is NOT promised to match
   * (`instanceof` is realm-local). That is accepted rather than papered over: an error-shaped
   * predicate would match equal-shaped ordinary app data, which the SEAM-proof's case 5 rules out.
   * If seroval cannot serialise such a value, its failure channel invokes the R3 fatal rule - a
   * different channel entirely, never conflated with this one.
   */
  test(value: unknown): boolean {
    return value instanceof Error;
  },

  parse: {
    sync(_value: Error, ctx: SyncParsePluginContext): SanitisedErrorInfo {
      return sanitise(ctx);
    },
    async(_value: Error, ctx: AsyncParsePluginContext): Promise<SanitisedErrorInfo> {
      return sanitiseAsync(ctx);
    },
    stream(_value: Error, ctx: StreamParsePluginContext): SanitisedErrorInfo {
      return sanitise(ctx);
    },
  },

  /**
   * Emits a real, constructible Error so the client's deserialised value behaves like one - the
   * withdrawn S0-C2 candidate returned raw strings here, which ABORTED serialisation and emitted a
   * payload calling `$R` slots that were never assigned (`TypeError: $R[6] is not a function` in a
   * browser; the boundary never hydrates). Its `secret=0` result was redaction by destroying the
   * payload, which is why acceptance requires executability, not just absence of secrets.
   */
  serialize(node: SanitisedErrorInfo, ctx: SerializePluginContext): string {
    return `Object.assign(new Error(${ctx.serialize(node.message)}),{name:${ctx.serialize(node.name)}})`;
  },

  /**
   * The client's deserialised value is a REAL Error, so it naturally acquires its own client-side
   * stack at construction. That is expected and is not a leak: the security requirement is that no
   * SERVER-side stack or source property crosses the boundary, and none does - nothing is read
   * from the source error anywhere in this plugin. Do not "fix" the client stack away; a stackless
   * error would be worse for client-side debugging and buys nothing.
   */
  deserialize(): Error {
    return Object.assign(new Error(REDACTED_MESSAGE), { name: REDACTED_NAME });
  },
});
