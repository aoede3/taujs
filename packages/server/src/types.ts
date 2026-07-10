import type { Writable } from 'node:stream';

import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify';

import type { CoreTaujsConfig, Route, PathToRegExpParams } from './core/config/types';
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
  /** Full resolved config — consumed only by dev introspection surfaces (graph endpoint). */
  taujsConfig?: CoreTaujsConfig;
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

/**
 * Minimal structural logger the server passes to a renderer's optional `opts.logger`. The
 * server's rich `Logs` satisfies it (asserted below), and it is in turn assignable to a
 * framework package's looser logger type — so a renderer's `createRenderer(...)` output is
 * assignable to `RenderModule` cast-free (V1-05; see docs/vue/04-gate-v1-review §4).
 * `debug`/`isDebugEnabled` accept `any` category to absorb `Logs`'s `DebugCategory`-typed
 * overloads; framework packages keep their own richer logger types internally.
 */
export type RendererLogger = {
  info?: (meta?: unknown, message?: string) => void;
  warn?: (meta?: unknown, message?: string) => void;
  error?: (meta?: unknown, message?: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug?: (category: any, meta?: unknown, message?: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isDebugEnabled?: (category: any) => boolean;
};

// Compile-time proof that the server's Logs is a valid RendererLogger (V1-05). If Logs ever
// stops conforming, `_LogsConformsToRendererLogger` fails to satisfy the constraint here.
type _AssertExtends<T extends RendererLogger> = T;
type _LogsConformsToRendererLogger = _AssertExtends<Logs>;

export type RenderSSR = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { logger?: RendererLogger; routeContext?: unknown },
) => Promise<{
  headContent: string;
  appHtml: string;
}>;

export type RenderStream = (
  // The server always passes a node Writable (a PassThrough); both framework renderers have
  // always consumed node-Writable APIs. The contract states that truth (V1-05).
  sink: Writable,
  callbacks: RenderCallbacks,
  initialData: Record<string, unknown> | Promise<Record<string, unknown>> | (() => Promise<Record<string, unknown>>),
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
  cspNonce?: string,
  signal?: AbortSignal,
  opts?: { logger?: RendererLogger; routeContext?: unknown },
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
