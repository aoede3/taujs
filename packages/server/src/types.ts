import type { ServerResponse } from 'http';
import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { PluginOption } from 'vite';
import type { CSPDirectives } from './security/csp';
import type { ServiceRegistry } from './utils';

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
  configs: Config[];
  routes: Route<PathToRegExpParams>[];
  serviceRegistry: ServiceRegistry;
  security?: {
    csp?: {
      directives?: CSPDirectives;
      generateCSP?: (directives: CSPDirectives, cspNonce: string) => string;
    };
  };
  registerStaticAssets?:
    | false
    | {
        plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>;
        options?: Record<string, unknown>;
      };
  isDebug?: boolean;
};

export type RenderCallbacks = {
  onHead: (headContent: string) => void;
  onFinish: (initialDataResolved: unknown) => void;
  onError: (error: unknown) => void;
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
) => Promise<{
  headContent: string;
  appHtml: string;
}>;

export type RenderStream = (
  serverResponse: ServerResponse,
  callbacks: RenderCallbacks,
  initialDataPromise: Promise<Record<string, unknown>>,
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
  cspNonce?: string,
) => void;

export type RenderModule = {
  renderSSR: RenderSSR;
  renderStream: RenderStream;
};

export type GenericPlugin = FastifyPluginCallback<Record<string, unknown>> | FastifyPluginAsync<Record<string, unknown>>;

export type BaseMiddleware = {
  auth?: {
    required: boolean;
    redirect?: string;
    roles?: string[];
    strategy?: string;
  };
};

export type ServiceCall = {
  serviceName: string;
  serviceMethod: string;
  args?: Record<string, unknown>;
};

export type DataResult = Record<string, unknown> | ServiceCall;

export type DataHandler<Params extends PathToRegExpParams> = (
  params: Params,
  ctx: {
    headers: Record<string, string>;
    [key: string]: unknown;
  },
) => Promise<DataResult>;

export type RouteAttributes<Params extends PathToRegExpParams = PathToRegExpParams, Middleware = BaseMiddleware> =
  | {
      render: 'ssr';
      hydrate?: boolean;
      meta?: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params>;
    }
  | {
      render: 'streaming';
      hydrate?: never;
      meta: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params>;
    };
// Define a specific type for the params object from path-to-regexp
export type PathToRegExpParams = Partial<Record<string, string | string[]>>;

// Now, use this specific type in your Route and RouteAttributes definitions
export type Route<Params extends PathToRegExpParams = PathToRegExpParams> = {
  attr?: RouteAttributes<Params>;
  path: string;
  appId?: string;
};

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

// export type RouteParams = InitialRouteParams & Record<string, unknown>;

export type RoutePathsAndAttributes<Params extends PathToRegExpParams = PathToRegExpParams> = Omit<Route<Params>, 'element'>;
