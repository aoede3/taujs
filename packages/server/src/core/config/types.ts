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

export type RouteAttributes<Params extends PathToRegExpParams = PathToRegExpParams, Middleware = BaseMiddleware, L extends Logs = Logs> =
  | {
      render: 'ssr';
      hydrate?: boolean;
      meta?: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params, L>;
    }
  | {
      render: 'streaming';
      hydrate?: boolean;
      meta: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params, L>;
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

export type CoreTaujsConfig = {
  apps: readonly CoreAppConfig[];
  security?: CoreSecurityConfig;
  server?: {
    host?: string;
    port?: number;
    hmrPort?: number;
  };
};
