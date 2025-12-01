import type { FastifyPluginAsync, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PluginOption } from 'vite';
import type { CSPDirectives } from './security/CSP';
import type { RegistryCaller, ServiceDescriptor, ServiceRegistry } from './utils/DataServices';
import type { AppConfig, SecurityConfig } from './Config';
import type { DebugConfig, Logs } from './logging/Logger';
import type { StaticAssetsRegistration } from './utils/StaticAssets';
import type { RequestContext } from './utils/Telemetry';

export type RouteCSPConfig = {
  disabled?: boolean; // soft disable: keep global header, ignore this route's overrides
  mode?: 'merge' | 'replace';
  directives?: CSPDirectives | ((args: { url: string; params: PathToRegExpParams; headers: FastifyRequest['headers']; req: FastifyRequest }) => CSPDirectives);
  generateCSP?: (directives: CSPDirectives, nonce: string, req: FastifyRequest) => string;
  reportOnly?: boolean;
};

export type Config = {
  appId: string;
  entryPoint: string;
  entryClient?: string;
  entryServer?: string;
  htmlTemplate?: string;
};

export type ProcessedConfig = {
  appId: string;
  clientRoot: string;
  entryClient: string;
  entryPoint: string;
  entryServer: string;
  htmlTemplate: string;
  plugins?: PluginOption[];
};

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  configs: AppConfig[];
  routes: Route<PathToRegExpParams>[];
  serviceRegistry?: ServiceRegistry;
  security?: SecurityConfig;
  staticAssets?: StaticAssetsRegistration;
  debug?: DebugConfig;
  devNet?: { host: string; hmrPort: number };
};

export type RenderCallbacks<T = unknown> = {
  onHead?: (headContent: string) => void;
  onShellReady?: () => void; // fallback flushed; pipe starts in renderer
  onAllReady?: (initialData: T) => void; // resolved subtree flushed; safe to inject data/bootstrap
  onError?: (error: unknown) => void;
};

export type SSRManifest = { [key: string]: string[] };

export type ManifestEntry = {
  file: string;
  src?: string;
  isDynamicEntry?: boolean;
  imports?: string[];
  css?: string[];
  assets?: string[];
};

export type Manifest = { [key: string]: ManifestEntry };

export type RenderSSR = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { logger?: Logs; routeContext?: unknown },
) => Promise<{
  headContent: string;
  appHtml: string;
}>;

export type RenderStream = (
  serverResponse: NodeJS.WritableStream,
  callbacks: RenderCallbacks,
  initialData: Record<string, unknown> | Promise<Record<string, unknown>> | (() => Promise<Record<string, unknown>>),
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
  cspNonce?: string,
  signal?: AbortSignal,
  opts?: { logger?: Logs; routeContext?: unknown },
) => { abort(): void };

export type RenderModule = {
  renderSSR: RenderSSR;
  renderStream: RenderStream;
};

export type GenericPlugin = FastifyPluginCallback<Record<string, unknown>> | FastifyPluginAsync<Record<string, unknown>>;

export type BaseMiddleware = {
  auth?: {
    redirect?: string;
    roles?: string[];
    strategy?: string;
  };
  csp?: RouteCSPConfig | false; // false = hard disable, object = apply / maybe soft-disable
};

export type DataResult = Record<string, unknown> | ServiceDescriptor;

export type RequestServiceContext<L extends Logs = Logs> = RequestContext<L> & {
  call: RegistryCaller<ServiceRegistry>;
  headers?: Record<string, string>;
};

export type DataHandler<Params extends PathToRegExpParams, L extends Logs = Logs> = (
  params: Params,
  ctx: RequestServiceContext<L> & { [key: string]: unknown },
) => Promise<DataResult>;

export type PathToRegExpParams = Partial<Record<string, string | string[]>>;

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

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

export type RoutePathsAndAttributes<Params extends PathToRegExpParams = PathToRegExpParams> = Omit<Route<Params>, 'element'>;

// Utility types for extracting app and route information from TaujsConfig for MFE state management
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
