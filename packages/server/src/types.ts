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

/**
 * Structured, NON-FATAL render-error observation (R1-01). `phase` is the OBSERVED timing (had the
 * shell committed when the renderer surfaced the error) — descriptive only, never a fatality
 * signal. `recoverable` is `true` only for `post-shell` errors (React recovers them client-side)
 * and `'unknown'` for `pre-shell` (outcome resolved by the fatal channels).
 */
export type RenderErrorInfo = {
  error: unknown;
  phase: 'pre-shell' | 'post-shell';
  recoverable: boolean | 'unknown';
};

export type RenderCallbacks<T = unknown> = {
  /** REQUIRED (operationally): commits the head + connects the sink. A throwing `onHead` is fatal. */
  onHead?: (headContent: string) => void;
  /** Advisory (isolated — a throw is logged, not fatal). */
  onShellReady?: () => void;
  /** Advisory. Fires once with the resolved route data. */
  onAllReady?: (initialData: T) => void;
  /** FATAL error channel (shell error / timeout / guard / non-recoverable). */
  onError?: (error: unknown) => void;
  /**
   * Advisory, NON-FATAL structured render-error channel (R1-01) — fires for render errors that do
   * not fail the response (notably post-shell boundary errors React recovers client-side). The
   * server wires this to the request logger. Never a fatality signal.
   */
  onRenderError?: (info: RenderErrorInfo) => void;
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
  // RFC 0004 (H1): `headData` is the route's resolved `attr.head` payload (undefined when the
  // route declares none, or when the head degraded under the signed policy). BROAD at this
  // boundary by design - the host stores heterogeneous render modules and cannot know a route's
  // `H`; the renderer narrows at its own internal seam (the same trust model as the body data).
  opts?: { logger?: RendererLogger; routeContext?: unknown; headData?: Record<string, unknown> },
) => Promise<{
  headContent: string;
  appHtml: string;
}>;

/**
 * The lifecycle handle a renderer's `renderStream` returns (R0-01).
 *
 * - `abort()` requests a benign cancel of an in-flight stream.
 * - `done` resolves on normal completion or benign cancel, and REJECTS on a fatal stream error.
 *
 * The rejection is pre-observed inside the renderer: a no-op handler is attached to the same
 * promise at creation (see each framework's `createStreamController`), so an unobserved `done`
 * can never raise `unhandledRejection` — which Node's default mode turns into a
 * process-terminating `uncaughtException`. Consumers who `await done` still receive the fatal
 * error on their own handler; consumers who ignore `done` are safe. The server observes `done`
 * as acknowledgement (fatal errors are already handled via the `onError` callback) and as
 * defence in depth against a third-party renderer that omits the pre-attached handler.
 */
export type RenderStreamHandle = {
  abort(): void;
  done: Promise<void>;
};

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
  // RFC 0004 (H1): see RenderSSR's `headData` note - resolved pre-shell, broad at this boundary.
  opts?: { logger?: RendererLogger; routeContext?: unknown; headData?: Record<string, unknown> },
) => RenderStreamHandle;

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
