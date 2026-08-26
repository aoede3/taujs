import type { Writable } from 'node:stream';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';

import type { CoreTaujsConfig, Route, RouteParams } from './core/config/types';
import type { DeferredDataRegistry } from './core/routes/DeferredData';
import type { DebugConfig, Logs } from './core/logging/types';
import type { ServiceRegistry } from './core/services/DataServices';

import type { RuntimeLoggerSelection } from './logging/RuntimeLogger';
import type { AppConfig, SecurityConfig } from './Config';
import type { StaticAssetsRegistration } from './utils/StaticAssets';
import type { TaujsViteOverride } from './ViteConfig';

export type SSRServerOptions = {
  /**
   * RFC 0010. Embedded development only. Owns the single caller-root `onRequest` hook which
   * delegates otherwise-unmatched requests to the τjs-owned Vite server. `createServer` supplies it
   * only when a caller instance was passed AND the process is in development, so production never
   * receives the handle at all. It must not be used for routing, policy, tracing, errors or
   * lifecycle.
   *
   * Typed as `Pick<FastifyInstance, 'addHook'>` rather than the whole instance: passing `app` still
   * works structurally, but nothing downstream can reach `setErrorHandler`, `setNotFoundHandler`,
   * `decorate` or `get` through this handle. The narrow authorisation is enforced by the compiler
   * instead of by discipline, and it needs no wrapper or abstraction to do it.
   */
  viteRequestHookOwner?: Pick<FastifyInstance, 'addHook'>;
  alias?: Record<string, string>;
  clientRoot: string;
  /**
   * Project root for relative declarative alias normalisation (RFC 0005 §3) - thread the same
   * value `taujsBuild({ projectRoot })` receives so dev and build resolve identically. Defaults
   * to `process.cwd()` downstream.
   */
  projectRoot?: string;
  configs: readonly AppConfig[];
  routes: Route<RouteParams>[];
  serviceRegistry?: ServiceRegistry;
  security?: SecurityConfig;
  /** `undefined` → default production registration; `false` → no static plugin; otherwise the caller's registration. */
  staticAssets?: StaticAssetsRegistration;
  /**
   * RFC 0012: the validated installation-level EMISSION coordinate, threaded from
   * `createServer` (`extractPathCoordinates`). Composed in front of every τjs-generated URL
   * (bootstrap, css, preload, dev beacon). `''` (the default) is today's root-absolute
   * emission byte-for-byte. RECEPTION is the register-time `prefix`, not this value.
   */
  publicBasePath?: string;
  /** RFC 0013: resolved development HMR transport (`'fixed-port'` default). */
  hmrTransport?: 'fixed-port' | 'attached';
  debug?: DebugConfig;
  /** Internal runtime logger selection threaded from createServer; not a public createServer option. */
  runtimeLogger?: RuntimeLoggerSelection;
  devNet?: { host: string; hmrPort: number };
  /**
   * Full resolved config — consumed by dev introspection surfaces (graph endpoint) AND, per RFC 0005
   * VS4, the dev `config.vite` wiring (`resolveDevViteConfig`). `vite` lives on the `TaujsConfig`
   * extension (Vite-typed), not the Vite-free `CoreTaujsConfig`, so it is re-attached here via the
   * same minimal intersection `taujsBuild` uses - assignable from both a bare `CoreTaujsConfig` and a
   * full `TaujsConfig` (`CreateServer` forwards `opts.config`, a `TaujsConfig`).
   */
  taujsConfig?: CoreTaujsConfig & { vite?: TaujsViteOverride };
  /**
   * Post-freeze ruling 2026-08-08: resolved introspection host admissions (lowercase
   * exact-match set), validated at `createServer` entry (`resolveIntrospectionAllowedHosts`)
   * and threaded like the coordinates above so registration never re-derives it.
   */
  introspectionAllowedHosts?: ReadonlySet<string>;
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

export type ManifestEntry = {
  file: string;
  src?: string;
  isDynamicEntry?: boolean;
  imports?: string[];
  /**
   * Vite emits this alongside `imports`. taujs declares it so the preload policy's exclusion of
   * dynamic imports is VISIBLE in the type rather than implicit in the absence of a field: the
   * static-import closure walks `imports` only, deliberately (see `getStaticModulePreloadLinks`).
   */
  dynamicImports?: string[];
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
  /**
   * RFC 0007 (decision 14): the request-local registry of declared `attr.deferred` entries -
   * present ONLY when a streaming route declares them, and conditionally spread exactly like
   * `headData`. This is the accepted INTERNAL host-to-renderer transport, NOT a public application
   * API: every promise is already started and already pre-observed by the host, a resolved entry
   * is the host's settlement snapshot (parsed JSON, no identity relationship to the loader's
   * object), and a value that could not be snapshotted arrives as a detail-free rejection. The
   * renderer projects each named promise onto its native Suspense/resource primitive and starts
   * nothing.
   */
  deferredData?: DeferredDataRegistry;
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
