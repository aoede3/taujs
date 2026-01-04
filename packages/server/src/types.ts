import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify';

import type { Route, PathToRegExpParams } from './core/config/types';
import type { DebugConfig, Logs } from './core/logging/types';
import type { ServiceRegistry } from './core/services/DataServices';

import type { AppConfig, SecurityConfig } from './Config';
import type { StaticAssetsRegistration } from './utils/StaticAssets';

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  configs: readonly AppConfig[];
  routes: Route<PathToRegExpParams>[];
  serviceRegistry?: ServiceRegistry;
  security?: SecurityConfig;
  staticAssets?: StaticAssetsRegistration;
  debug?: DebugConfig;
  devNet?: { host: string; hmrPort: number };
};

export type GenericPlugin = FastifyPluginCallback<Record<string, unknown>> | FastifyPluginAsync<Record<string, unknown>>;

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

export type RenderCallbacks<T = unknown> = {
  onHead?: (headContent: string) => void;
  onShellReady?: () => void;
  onAllReady?: (initialData: T) => void;
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

export type StreamSink = {
  write(chunk: string | Uint8Array): void;
  end(): void;
  on?(event: 'close' | 'drain' | 'error', cb: (...a: any[]) => void): void;
};

export type RenderStream = (
  sink: StreamSink,
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

export type Config<P = unknown> = {
  appId: string;
  entryPoint: string;
  entryClient?: string;
  entryServer?: string;
  htmlTemplate?: string;
  plugins?: readonly P[];
};

export type ProcessedConfig<P = unknown> = {
  appId: string;
  clientRoot: string;
  entryClient: string;
  entryPoint: string;
  entryServer: string;
  htmlTemplate: string;
  plugins?: readonly P[];
};
