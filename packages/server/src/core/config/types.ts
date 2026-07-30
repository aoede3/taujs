import type { RENDERTYPE } from '../constants';
import type { RegistryCaller, ServiceContext, ServiceDescriptor, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { RequestContext } from '../telemetry/Telemetry';

export type RenderType = (typeof RENDERTYPE)[keyof typeof RENDERTYPE];

export type RouteParams = Partial<Record<string, string | string[]>>;

/** @deprecated Use `RouteParams`. Retained as a type alias for pre-v1 source compatibility. */
export type PathToRegExpParams = RouteParams;

export type RouteCSPConfig = {
  disabled?: boolean;
  mode?: 'merge' | 'replace';
  directives?: unknown | ((args: { url: string; params: RouteParams; headers: Record<string, string>; req?: unknown }) => unknown);
  generateCSP?: (directives: unknown, nonce: string, req?: unknown) => string;
  reportOnly?: boolean;
};

export type BaseMiddleware = {
  auth?: {
    redirect?: string;
    roles?: string[];
    strategy?: string;
  };
  csp?: RouteCSPConfig | false;
};

export type DataResult = Record<string, unknown> | ServiceDescriptor;

export type RequestServiceContext<L extends Logs = Logs> = ServiceContext &
  RequestContext<L> & {
    call?: RegistryCaller<ServiceRegistry>;
    headers: Record<string, string>;
  };

export type DataHandler<Params extends RouteParams, L extends Logs = Logs> = (
  params: Params,
  ctx: (RequestServiceContext<L> & { call: RegistryCaller<ServiceRegistry> }) & { [key: string]: unknown },
) => Promise<DataResult>;

// RFC 0004 (H1): TYPE-ONLY brand symbol - `declare` means it never exists at runtime, and
// `serviceData()` stamps no such property on the handler it returns.
declare const SERVICE_RESULT: unique symbol;

/**
 * RFC 0004 (H1): a `DataHandler` produced by `serviceData()`, carrying the selected service
 * method's eventual (post-dispatch) result as a PHANTOM type brand. The callable's declared
 * return stays the honest service DESCRIPTOR - the runtime value really is the descriptor, and
 * the server dispatches it - while the brand tells the type system what that dispatch resolves
 * to, so `HeadDataOf` (and future `RouteDataOf` work) can infer the real payload instead of the
 * descriptor shape.
 */
export type ServiceDataHandler<Result, Params extends RouteParams = RouteParams, L extends Logs = Logs> = DataHandler<Params, L> & {
  readonly [SERVICE_RESULT]: Result;
};

/**
 * RFC 0004 (H1): per-route dynamic head data, resolved BEFORE the renderer starts on BOTH
 * strategies and delivered to the renderer as `opts.headData` (never serialised into
 * `__INITIAL_DATA__` - ruling 1). `attr.meta` remains the static layer (ruling 5).
 */
export type HeadAttributes<Params extends RouteParams = RouteParams, L extends Logs = Logs> = {
  /** Head data loader - same shape as `attr.data` (plain object or `ServiceDescriptor`, incl. `serviceData()` sugar). */
  data: DataHandler<Params, L>;
  /**
   * Head loader deadline in ms - POSITIVE FINITE only, validated at boot (default 3000). On
   * expiry with the request still live, the render proceeds with `headData: undefined` plus an
   * advisory log (RFC 0004 Policy ii). There is deliberately no wait-forever sentinel: the head
   * blocks the shell, so its deadline stays bounded.
   */
  timeoutMs?: number;
  /**
   * Opt-in recoverability for ORDINARY loader rejection: `true` degrades a rejection like a
   * deadline expiry (undefined + advisory) instead of failing the request. Default `false` -
   * real application defects stay visible on the existing error path.
   */
  optional?: boolean;
};

/**
 * RFC 0007 (R1): the flat, STREAMING-ONLY record of route-owned deferred loaders. Values are the
 * existing `DataHandler` shape (`serviceData()` sugar included) - no new helper, no dependencies
 * between entries, and no optionality: `deferred` describes timing, not whether a value may be
 * missing. Keys are stable route-local identifiers matching `^[A-Za-z][A-Za-z0-9_]*$`, validated at
 * boot beside the other extract-routes checks.
 */
export type DeferredDataAttributes<Params extends RouteParams = RouteParams, L extends Logs = Logs> = Readonly<Record<string, DataHandler<Params, L>>>;

export type RouteAttributes<Params extends RouteParams = RouteParams, Middleware = BaseMiddleware, L extends Logs = Logs> =
  | {
      render: 'ssr';
      hydrate?: boolean;
      meta?: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params, L>;
      head?: HeadAttributes<Params, L>;
    }
  | {
      render: 'streaming';
      hydrate?: boolean;
      meta: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params, L>;
      // RFC 0007 (R1): the streaming arm ONLY. `deferred` on an `ssr` route is a type error here
      // AND a boot hard error for untyped input - data required by a non-streamed response belongs
      // in `data`.
      deferred?: DeferredDataAttributes<Params, L>;
      head?: HeadAttributes<Params, L>;
    };

export type Route<Params extends RouteParams = RouteParams> = {
  attr?: RouteAttributes<Params>;
  path: string;
  appId?: string;
};

export type RoutePathsAndAttributes<Params extends RouteParams = RouteParams> = Omit<Route<Params>, 'element'>;

export type AppId<C extends { apps: readonly { appId: string }[] }> = C['apps'][number]['appId'];

export type AppOf<C extends { apps: readonly any[] }, A extends AppId<C>> = Extract<C['apps'][number], { appId: A }>;

// NonNullable is load-bearing (public-alias repair, 2026-07-30): the broad config family declares
// `routes?:` (optional), so the raw property is `readonly AppRoute[] | undefined` and would fail
// the array test - collapsing every derived context and data type to `never`, including the
// public `RouteContext`/`RouteData` aliases. Literal configs with a required routes tuple are
// unaffected. Pinned by `test/PublicRouteContext.test-d.ts`.
export type RoutesOfApp<C extends { apps: readonly any[] }, A extends AppId<C>> =
  NonNullable<AppOf<C, A>['routes']> extends readonly any[] ? NonNullable<AppOf<C, A>['routes']>[number] : never;

export type RouteDataOf<R> = R extends { attr?: { data?: (...args: any) => infer Ret } } ? Awaited<Ret> : unknown;

/**
 * RFC 0004 (H1): the type `headContent` receives as `headData` for a route. Three arms, pinned
 * by `test/HeadDataOf.test-d.ts` (a signed hard gate):
 * - `serviceData()` sugar: the SELECTED METHOD's resolved result, read from the phantom brand -
 *   never the descriptor, never `Record<string, unknown>`;
 * - closure handler: its resolved return type (descriptor returns collapse to
 *   `Record<string, unknown>` - the dispatch result is untyped for hand-built descriptors);
 * - no `attr.head`: `undefined`.
 */
export type HeadDataOf<R> = R extends { attr?: infer A }
  ? A extends { head: { data: infer H } }
    ? H extends { readonly [SERVICE_RESULT]: infer Res }
      ? Res
      : H extends (...args: any) => infer Ret
        ? DescriptorMemberToRecord<Awaited<Ret>>
        : unknown
    : undefined
  : undefined;

/**
 * RFC 0007: the type a renderer's deferred accessor receives for a route, following `HeadDataOf`'s
 * three arms exactly:
 * - `serviceData()` sugar: the SELECTED METHOD's resolved result, read from the phantom brand;
 * - closure handler: its resolved return type (descriptor returns collapse to
 *   `Record<string, unknown>` - the dispatch result is untyped for hand-built descriptors);
 * - no `attr.deferred`: `undefined`.
 *
 * Note the inferred type describes the loader's DECLARED result. What arrives is that value's JSON
 * snapshot (failure semantics item 2) - the same caveat that already applies to `attr.data`
 * crossing `__INITIAL_DATA__`.
 */
export type DeferredDataOf<R> = R extends { attr?: infer A }
  ? A extends { deferred: infer D }
    ? {
        [K in keyof D]: D[K] extends { readonly [SERVICE_RESULT]: infer Res }
          ? Res
          : D[K] extends (...args: any) => infer Ret
            ? DescriptorMemberToRecord<Awaited<Ret>>
            : unknown;
      }
    : undefined
  : undefined;

/**
 * Distributes over a closure handler's return union: a descriptor MEMBER resolves (via service
 * dispatch) to an untyped record, so it contributes `Record<string, unknown>` to the union - it
 * must never be EXCLUDED, which would falsely narrow a mixed `{ title } | ServiceDescriptor`
 * return to `{ title }` alone (gate-recheck finding: the dispatched branch may resolve to any
 * record). Pure-object returns stay precise; pure-descriptor returns collapse to the record.
 */
type DescriptorMemberToRecord<V> = V extends ServiceDescriptor ? Record<string, unknown> : V;

export type RoutePathOf<R> = R extends { path: infer P } ? P : never;

/**
 * Ruled 2026-07-29 (followup: RouteContext type/runtime drift): the public context type mirrors
 * the runtime value HandleRender constructs - `{ appId, path, attr, params }` - EXACTLY. `data`
 * was never supplied at runtime (route data reaches the renderer's store, not the context) and is
 * deliberately absent; `params` is the matched route parameters, typed as the same broad
 * `RouteParams` every data handler receives. Pinned by `test/RouteContext.test-d.ts` and by the
 * HandleRender runtime assertions on both render strategies.
 */
export type SingleRouteContext<C extends { apps: readonly any[] }, A extends AppId<C>, R extends RoutesOfApp<C, A>> = R extends any
  ? {
      appId: A;
      path: RoutePathOf<R>;
      // Three arms, mirroring the runtime (the context key always exists; its value is the
      // route's attr or `undefined`): a required `attr` keeps its declared type; an optional
      // `attr?:` declaration admits `undefined`; a route with no attr member types `undefined`.
      // The single optional-probe arm this replaces resolved no-attr routes to `never` (the
      // weak-type rule fails the probe outright) - a field the runtime populates with undefined.
      attr: R extends { attr: infer Attr } ? Attr : R extends { attr?: infer Attr } ? Attr | undefined : undefined;
      params: RouteParams;
    }
  : never;

export type RouteContext<C extends { apps: readonly any[] }> = {
  [A in AppId<C>]: SingleRouteContext<C, A, RoutesOfApp<C, A>>;
}[AppId<C>];

// Internal: preserves the exact pre-ruling data derivation for RoutesData/RouteData after `data`
// left the public context. Distribution mechanics are identical to SingleRouteContext's, so the
// derived unions are unchanged by the ruling.
type SingleRouteDataEntry<C extends { apps: readonly any[] }, A extends AppId<C>, R extends RoutesOfApp<C, A>> = R extends any
  ? { path: RoutePathOf<R>; data: RouteDataOf<R> }
  : never;

type RouteDataEntry<C extends { apps: readonly any[] }> = {
  [A in AppId<C>]: SingleRouteDataEntry<C, A, RoutesOfApp<C, A>>;
}[AppId<C>];

export type RoutesData<C extends { apps: readonly any[] }> = RouteDataEntry<C>['data'];

export type RouteData<C extends { apps: readonly any[] }, Path extends string> = Extract<RouteDataEntry<C>, { path: Path }>['data'];

export type CoreSecurityConfig = {
  csp?: {
    defaultMode?: 'merge' | 'replace';
    directives?: unknown;
    generateCSP?: (directives: unknown, nonce: string, req?: unknown) => string;
    reporting?: {
      endpoint: string;
      onViolation?: (report: unknown, req: unknown) => void;
      reportOnly?: boolean;
    };
  };
};

export type AppRoute = Omit<Route<RouteParams>, 'appId'> & {
  attr?: RouteAttributes<RouteParams>;
};

export type CoreAppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: readonly unknown[];
  // Renderer v1 (RFC 0006): the app's opaque branded renderer contribution. `unknown` here keeps the
  // Vite-free core dependency-free (the required, branded shape is enforced on the public `AppConfig`);
  // it is carried through extract/process so the host pre-pass + identity validation can read it.
  renderer?: unknown;
  routes?: readonly AppRoute[];
};

// Dev-only introspection posture (RFC `introspection` config surface). Deliberately no
// `enabled` flag: dev-on / prod-absent is structural, not a toggle.
export type CoreIntrospectionConfig = {
  /** Relaxes ONLY the overlay remote-address check; shouts in the boot summary when enabled. */
  allowNonLoopback?: boolean;
  redaction?: {
    /** Extends the default denylist (password, token, secret, ssn, auth, cookie, session, key). */
    denyKeys?: string[];
    replaceDefaultDenyKeys?: boolean;
  };
};

export type CoreTaujsConfig = {
  apps: readonly CoreAppConfig[];
  security?: CoreSecurityConfig;
  introspection?: CoreIntrospectionConfig;
  server?: {
    host?: string;
    port?: number;
    hmrPort?: number;
  };
  // RFC 0005 (VS2): the declarative home for the alias maps that are programmatic-only today
  // (`createServer`/`taujsBuild` options). Vite-free (plain `Record`), so it lives on the core
  // structural type - readable by BOTH dev (via `TaujsConfig`) and build (`taujsBuild` receives
  // `CoreTaujsConfig`). Relative values normalise against `projectRoot` at config load (VS5).
  // Typed here but unread until VS5.
  alias?: Record<string, string>;
};
