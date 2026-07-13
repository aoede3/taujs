import type { RENDERTYPE } from '../constants';
import type { RegistryCaller, ServiceContext, ServiceDescriptor, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { RequestContext } from '../telemetry/Telemetry';

export type RenderType = (typeof RENDERTYPE)[keyof typeof RENDERTYPE];

export type PathToRegExpParams = Partial<Record<string, string | string[]>>;

export type RouteCSPConfig = {
  disabled?: boolean;
  mode?: 'merge' | 'replace';
  directives?: unknown | ((args: { url: string; params: PathToRegExpParams; headers: Record<string, string>; req?: unknown }) => unknown);
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

export type DataHandler<Params extends PathToRegExpParams, L extends Logs = Logs> = (
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
export type ServiceDataHandler<Result, Params extends PathToRegExpParams = PathToRegExpParams, L extends Logs = Logs> = DataHandler<Params, L> & {
  readonly [SERVICE_RESULT]: Result;
};

/**
 * RFC 0004 (H1): per-route dynamic head data, resolved BEFORE the renderer starts on BOTH
 * strategies and delivered to the renderer as `opts.headData` (never serialised into
 * `__INITIAL_DATA__` - ruling 1). `attr.meta` remains the static layer (ruling 5).
 */
export type HeadAttributes<Params extends PathToRegExpParams = PathToRegExpParams, L extends Logs = Logs> = {
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

export type RouteAttributes<Params extends PathToRegExpParams = PathToRegExpParams, Middleware = BaseMiddleware, L extends Logs = Logs> =
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
      head?: HeadAttributes<Params, L>;
    };

export type Route<Params extends PathToRegExpParams = PathToRegExpParams> = {
  attr?: RouteAttributes<Params>;
  path: string;
  appId?: string;
};

export type RoutePathsAndAttributes<Params extends PathToRegExpParams = PathToRegExpParams> = Omit<Route<Params>, 'element'>;

export type AppId<C extends { apps: readonly { appId: string }[] }> = C['apps'][number]['appId'];

export type AppOf<C extends { apps: readonly any[] }, A extends AppId<C>> = Extract<C['apps'][number], { appId: A }>;

export type RoutesOfApp<C extends { apps: readonly any[] }, A extends AppId<C>> = AppOf<C, A>['routes'] extends readonly any[]
  ? AppOf<C, A>['routes'][number]
  : never;

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
        ? Exclude<Awaited<Ret>, ServiceDescriptor> extends never
          ? Record<string, unknown>
          : Exclude<Awaited<Ret>, ServiceDescriptor>
        : unknown
    : undefined
  : undefined;

export type RoutePathOf<R> = R extends { path: infer P } ? P : never;

export type SingleRouteContext<C extends { apps: readonly any[] }, A extends AppId<C>, R extends RoutesOfApp<C, A>> = R extends any
  ? {
      appId: A;
      path: RoutePathOf<R>;
      data: RouteDataOf<R>;
      attr: R extends { attr?: infer Attr } ? Attr : never;
    }
  : never;

export type RouteContext<C extends { apps: readonly any[] }> = {
  [A in AppId<C>]: SingleRouteContext<C, A, RoutesOfApp<C, A>>;
}[AppId<C>];

export type RoutesData<C extends { apps: readonly any[] }> = RouteContext<C>['data'];

export type RouteData<C extends { apps: readonly any[] }, Path extends string> = Extract<RouteContext<C>, { path: Path }>['data'];

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

export type AppRoute = Omit<Route<PathToRegExpParams>, 'appId'> & {
  attr?: RouteAttributes<PathToRegExpParams>;
};

export type CoreAppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: readonly unknown[];
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
};
