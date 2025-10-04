import type { FastifyPluginAsync, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PluginOption } from 'vite';
import type { CSPDirectives } from './security/CSP';
import type { ServiceRegistry } from './utils/DataServices';
import type { AppConfig, SecurityConfig } from './config';
import type { DebugInput } from './logging/Parser';

export type RouteCSPConfig = {
  disabled?: boolean;
  mode?: 'merge' | 'replace';
  directives?: CSPDirectives | ((args: { url: string; params: PathToRegExpParams; headers: FastifyRequest['headers']; req: FastifyRequest }) => CSPDirectives);
  generateCSP?: (directives: CSPDirectives, nonce: string, req: FastifyRequest) => string;
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
  serviceRegistry: ServiceRegistry;
  security?: SecurityConfig;
  registerStaticAssets?:
    | false
    | {
        plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>;
        options?: Record<string, unknown>;
      };
  debug?: DebugInput;
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
  csp?: RouteCSPConfig | false;
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
    headers?: Record<string, string | string[]>;
    [key: string]: unknown;
  },
) => Promise<DataResult>;

export type PathToRegExpParams = Partial<Record<string, string | string[]>>;

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
      hydrate?: boolean;
      meta: Record<string, unknown>;
      middleware?: Middleware;
      data?: DataHandler<Params>;
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
