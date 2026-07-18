import type { Writable } from 'node:stream';

import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify';

import type { CoreTaujsConfig, Route, PathToRegExpParams } from './core/config/types';
import type { DebugConfig, Logs } from './core/logging/types';
import type { ServiceRegistry } from './core/services/DataServices';

import type { AppConfig, SecurityConfig } from './Config';
import type { StaticAssetsRegistration } from './utils/StaticAssets';
import type { TaujsViteOverride } from './ViteConfig';

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  /**
   * Project root for relative declarative alias normalisation (RFC 0005 §3) - thread the same
   * value `taujsBuild({ projectRoot })` receives so dev and build resolve identically. Defaults
   * to `process.cwd()` downstream.
   */
  projectRoot?: string;
  configs: readonly AppConfig[];
  routes: Route<PathToRegExpParams>[];
  serviceRegistry?: ServiceRegistry;
  security?: SecurityConfig;
  staticAssets?: StaticAssetsRegistration;
  debug?: DebugConfig;
  devNet?: { host: string; hmrPort: number };
  /**
   * Full resolved config — consumed by dev introspection surfaces (graph endpoint) AND, per RFC 0005
   * VS4, the dev `config.vite` wiring (`resolveDevViteConfig`). `vite` lives on the `TaujsConfig`
   * extension (Vite-typed), not the Vite-free `CoreTaujsConfig`, so it is re-attached here via the
   * same minimal intersection `taujsBuild` uses - assignable from both a bare `CoreTaujsConfig` and a
   * full `TaujsConfig` (`CreateServer` forwards `opts.config`, a `TaujsConfig`).
   */
  taujsConfig?: CoreTaujsConfig & { vite?: TaujsViteOverride };
};

export type GenericPlugin = FastifyPluginCallback<Record<string, unknown>> | FastifyPluginAsync<Record<string, unknown>>;

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

/**
 * Structured, NON-FATAL render-error observation (R1-01). `phase` is the OBSERVED timing (had the
 * shell committed when the renderer surfaced the error) — descriptive only, never a fatality
 * signal. `recoverable` is `true` only for `post-shell` errors (the renderer's client runtime completes
 * the affected boundary) and `'unknown'` for `pre-shell` (outcome resolved by the fatal channels).
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

/**
 * ESC-2 (RFC 0006): the named render-options bag shared by {@link RenderSSR} + {@link RenderStream} - the
 * single home for per-render metadata, superseding the two identical inline `{ logger, routeContext,
 * headData }` bags.
 *
 * - `cspNonce` is AUTHORITATIVE when present: it replaces the removed positional stream argument (the host
 *   derives the request nonce once and passes it here on the streaming path).
 * - `shouldHydrate` is the host-RESOLVED hydration policy (`attr.hydrate !== false`). The host keeps its
 *   operative hydration mechanism consistent with it (the stream `bootstrapModules` gate; the SSR bootstrap
 *   tag), so a renderer may treat `shouldHydrate` as the authoritative declaration without a second source
 *   of truth.
 *
 * Both fields are optional and additive - a renderer that ignores them behaves exactly as before.
 */
export type RenderOptions = {
  logger?: RendererLogger;
  routeContext?: unknown;
  headData?: Record<string, unknown>;
  cspNonce?: string;
  shouldHydrate?: boolean;
};

export type RenderSSR = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  // RFC 0004 (H1): `headData` is the route's resolved `attr.head` payload (undefined when the
  // route declares none, or when the head degraded under the signed policy). BROAD at this
  // boundary by design - the host stores heterogeneous render modules and cannot know a route's
  // `H`; the renderer narrows at its own internal seam (the same trust model as the body data).
  opts?: RenderOptions,
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
  signal?: AbortSignal,
  // ESC-2: `cspNonce` moved from a positional argument here into `opts.cspNonce` (authoritative when
  // present); `opts` also carries the resolved `shouldHydrate` policy. `headData` note: RFC 0004 (H1) -
  // resolved pre-shell, broad at this boundary.
  opts?: RenderOptions,
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
  // Renderer v1: the app's opaque renderer contribution, carried as a single scalar (NOT the plugin `P`
  // array generic). The host reads it structurally in the pre-pass + at render-module load.
  renderer?: unknown;
};

export type ProcessedConfig<P = unknown> = {
  appId: string;
  clientRoot: string;
  entryClient: string;
  entryPoint: string;
  entryServer: string;
  htmlTemplate: string;
  plugins?: readonly P[];
  renderer?: unknown;
};
