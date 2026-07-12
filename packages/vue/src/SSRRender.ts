import { createSSRApp, h, type App, type Component, type VNode } from 'vue';
import { renderToSimpleStream, renderToString, type SimpleReadable, type SSRContext } from '@vue/server-renderer';

import { createSSRStore, SSRStoreProvider, type SSRStore } from './SSRDataStore';
import { escapeHtml } from './utils/Html';
import { createUILogger } from './utils/Logger';

import type { Writable } from 'node:stream';
import type { LoggerLike } from './utils/Logger';

import { createStreamController, isBenignStreamErr, startShellTimer, wireWritableGuards } from './utils/Streaming';

export type RenderCallbacks<T> = {
  /**
   * Receives the head string. The server owns the HTML template and writes the head into
   * `<head>`; the renderer must never write head bytes into the stream. Return value is
   * ignored (parity with `@taujs/server`'s `RenderCallbacks.onHead` and `@taujs/react`).
   */
  onHead?: (head: string) => void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  /** @deprecated Legacy alias of `onAllReady`, kept for `@taujs/react` parity. Use `onAllReady`. */
  onFinish?: (data: T) => void;
  onError?: (err: unknown) => void;
};

export type StreamOptions = {
  /**
   * Time-to-first-content watchdog, in ms (default: 10000). Started before rendering and
   * cleared on the first streamed chunk. If no content is produced before it expires the
   * stream is aborted with a fatal error. Vue streaming is in-order and blocks at async
   * boundaries — there is no React-style shell phase, so this guards first-byte latency.
   */
  shellTimeoutMs?: number;
};

/**
 * Context passed to `headContent`: `data` is the resolved route data, `meta`/`routeContext` the
 * route's static metadata and per-request context. NB `headContent` returns RAW `<head>` HTML — any
 * value interpolated from `data` (or other services/user input) must be escaped with `escapeHtml`
 * (see the `headContent` option's docs).
 */
export type HeadContext<T extends Record<string, unknown> = Record<string, unknown>, R = unknown> = {
  data: T;
  meta: Record<string, unknown>;
  routeContext?: R;
};

type SSRResult = {
  headContent: string;
  appHtml: string;
  aborted: boolean;
  /**
   * `<Teleport>` buffers collected during `renderSSR`, keyed by target selector (e.g.
   * `'#modal'`). Populated only by `renderSSR` (the ssr strategy); the server currently
   * reads only `headContent`/`appHtml`, so standalone consumers are the audience.
   * Streaming does **not** produce teleports — see `createRenderer`'s JSDoc.
   */
  teleports?: Record<string, string>;
};

type StreamCallOptions<R> = StreamOptions & {
  logger?: LoggerLike;
  routeContext?: R;
};

const NOOP = () => {};

function normalizeRootComponent(root: Component | ((props: any) => VNode), props: any): Component {
  // Treat as render function if it doesn't look like a Vue component
  if (typeof root === 'function' && !(root as any).setup && !(root as any).render) {
    const renderFn = root as (p: any) => VNode;
    return { name: 'TauJsRoot', render: () => renderFn(props) };
  }

  // Otherwise treat as component
  return { name: 'TauJsRoot', render: () => h(root as any, props) };
}

function createAppWithStore<T>(store: SSRStore<T>, root: Component | ((props: any) => VNode), rootProps: any): ReturnType<typeof createSSRApp> {
  const Root = normalizeRootComponent(root, rootProps);

  return createSSRApp({
    name: 'TauJsSSR',
    render: () => h(SSRStoreProvider, { store }, { default: () => h(Root) }),
  });
}

/**
 * Create the τjs Vue renderer: `{ renderSSR, renderStream }`.
 *
 * **Teleports.** `renderSSR` collects `<Teleport>` content into its `teleports` result
 * (keyed by target selector). `renderStream` does **not** — teleported content cannot be
 * injected into an in-order stream after the fact, and τjs does not fake it. Applications
 * that render `<Teleport>` targets outside the app root must use the `ssr` strategy for
 * those routes, or render the teleported content client-side after hydration. Note τjs's
 * server consumes only `headContent`/`appHtml` today, so splicing `teleports` into a page
 * is a standalone-consumer concern.
 */
export function createRenderer<T extends Record<string, unknown> = Record<string, unknown>, R = unknown>({
  appComponent,
  headContent,
  streamOptions = {},
  logger,
  enableDebug = false,
  setupApp,
}: {
  /**
   * Vue root. You can supply a Vue component, or a function returning VNode.
   * It will be invoked/rendered with props: { location, routeContext? }
   */
  appComponent: Component | ((props: { location: string; routeContext?: R }) => VNode);
  /**
   * Returns the per-route `<head>` inner HTML. The return value is written into `<head>` VERBATIM as
   * RAW HTML — it is deliberately NOT auto-escaped, so you can emit `<meta>`/`<link>`/`<script>` tags.
   * Therefore any value interpolated from `data` (services or user input) MUST be escaped first with
   * `escapeHtml` (exported from `@taujs/vue`), e.g.
   * `` `<meta property="og:image" content="${escapeHtml(data.ogImage)}">` ``. See the head-management
   * guide, "Best Practices — Escape User Content".
   */
  headContent: (ctx: HeadContext<T, R>) => string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  streamOptions?: StreamOptions;
  /**
   * Configure the `App` instance τjs creates per request (`app.use`, directives, global
   * components, provides) — this is how Vue-ecosystem integrations (Pinia, vue-i18n) attach
   * under τjs SSR. Invoked after app creation, before render, on `renderSSR` and
   * `renderStream`; the identical function is also passed to `hydrateApp` on the client.
   *
   * Constraints (must hold for the same function to run verbatim on server and client):
   * synchronous only (no promise form), no `window`/DOM access, and idempotent per app
   * instance (a fresh `App` is created per request and per mount). A throwing `setupApp` is
   * treated as an application error and routed to the path's error channel (`onError` +
   * fatal abort here; `onHydrationError` client-side) — never swallowed.
   */
  setupApp?: (app: App) => void;
}) {
  const { shellTimeoutMs = 10_000 } = streamOptions;

  const renderSSR = async (
    initialData: T,
    location: string,
    meta: Record<string, unknown> = {},
    signal?: AbortSignal,
    opts?: { logger?: LoggerLike; routeContext?: R },
  ): Promise<SSRResult> => {
    const { log, warn } = createUILogger(opts?.logger ?? logger, {
      debugCategory: 'ssr',
      context: { scope: 'vue-ssr' },
      enableDebug,
    });

    if (signal?.aborted) {
      warn('SSR skipped; already aborted', { location });
      return { headContent: '', appHtml: '', aborted: true };
    }

    let aborted = false;
    const onAbort = () => (aborted = true);
    signal?.addEventListener('abort', onAbort, { once: true });

    const routeContext = opts?.routeContext;

    try {
      log('Starting SSR:', location);

      const dynamicHead = headContent({
        data: initialData,
        meta,
        routeContext,
      });
      const store = createSSRStore(initialData);

      const app = createAppWithStore(store, appComponent, {
        location,
        routeContext,
      });
      // App-instance customization before render (a throw propagates as this promise's
      // rejection — renderSSR's error channel).
      setupApp?.(app);
      // Pass a real SSRContext so <Teleport> content is collected into ctx.teleports
      // (additive: the server reads only headContent/appHtml).
      const ctx: SSRContext = {};
      const html = await renderToString(app, ctx);

      if (aborted) {
        warn('SSR completed after client abort', { location });
        return { headContent: '', appHtml: '', aborted: true };
      }

      log('Completed SSR:', location);

      return { headContent: dynamicHead, appHtml: html, aborted: false, teleports: ctx.teleports };
    } finally {
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {}
    }
  };

  const renderStream = (
    writable: Writable,
    callbacks: RenderCallbacks<T>,
    initialData: T | Promise<T> | (() => Promise<T>),
    location: string,
    bootstrapModules?: string,
    meta: Record<string, unknown> = {},
    cspNonce?: string,
    signal?: AbortSignal,
    opts?: StreamCallOptions<R>,
  ) => {
    const cb = {
      onHead: callbacks.onHead ?? NOOP,
      onShellReady: callbacks.onShellReady ?? NOOP,
      onAllReady: callbacks.onAllReady ?? NOOP,
      onFinish: callbacks.onFinish ?? NOOP,
      onError: callbacks.onError ?? NOOP,
    };

    const { log, warn, error } = createUILogger(opts?.logger ?? logger, {
      debugCategory: 'ssr',
      context: { scope: 'vue-streaming' },
      enableDebug,
    });

    const routeContext = opts?.routeContext;
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;

    const controller = createStreamController(writable, { log, warn, error });

    // Single, idempotent fatal path. Vue swallows a component error once an
    // app.config.errorHandler is installed (see @vue/server-renderer handleError), so the
    // handler must abort itself rather than relying on the render promise to reject; the
    // isAborted guard makes this safe to call from both errorHandler and sink.destroy.
    const fail = (err: unknown) => {
      if (controller.isAborted) return;
      // Recheck: the host `onError` callback can NEVER veto controller cleanup/settlement. A
      // throwing `onError` is logged and SWALLOWED — it must not veto `fatalAbort` (below, always
      // runs) NOR escape (this may run inside an errorHandler / sink teardown where a throw would
      // be uncaught). The ORIGINAL error stays the rejection reason.
      try {
        cb.onError(err);
      } catch (cbErr) {
        warn('onError callback threw:', cbErr);
      }
      controller.fatalAbort(err);
    };

    // AbortSignal (benign cancel)
    if (signal) {
      const handleAbortSignal = () => controller.benignAbort(`AbortSignal triggered; aborting stream for location: ${location}`);

      if (signal.aborted) {
        handleAbortSignal();
        return { abort: () => {}, done: Promise.resolve() };
      }

      signal.addEventListener('abort', handleAbortSignal, { once: true });
      controller.setRemoveAbortListener(() => {
        try {
          signal.removeEventListener('abort', handleAbortSignal);
        } catch {}
      });
    }

    // Writable guards BEFORE any writes/piping
    const { cleanup: guardsCleanup } = wireWritableGuards(writable, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => fail(err),
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(guardsCleanup);

    // Time-to-first-content watchdog: fires only if no chunk is produced before it expires.
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;

      fail(new Error(`Stream produced no content within ${effectiveShellTimeout}ms`));
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    let firstChunkSeen = false;
    // Assigned inside the try below, before renderToSimpleStream drives the sink; the sink's
    // completion handler reads it (R1).
    let store: SSRStore<T> | undefined;

    // Finalize the response: emit the client bootstrap (so a streamed route hydrates — the
    // server injects none in streaming strategy, delegating it here), then end the writable.
    // The server's `finish` handler appends the __INITIAL_DATA__ script and template tail;
    // hydrateApp defers to DOMContentLoaded, by which time that data script has executed, so
    // ordering (bootstrap before data script) is safe.
    const finishStream = () => {
      if (controller.isAborted) return;
      if (bootstrapModules) {
        // R2-03 (V2/SEC2): escape the manually-written bootstrap attributes. `escapeHtml` is a no-op
        // on clean module URLs and base64 CSP nonces (attribute-safe for both quote styles), so it is
        // defence-in-depth with no tag-shape change on valid input.
        const nonceAttr = cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : '';
        try {
          writable.write(`<script type="module" src="${escapeHtml(bootstrapModules)}" async${nonceAttr}></script>`);
        } catch {}
      }
      try {
        writable.end();
      } catch {}
    };

    const sink: SimpleReadable = {
      push: (chunk: string | null) => {
        if (controller.isAborted) return;

        if (chunk === null) {
          // R1: gate end-of-stream on the store settling, so the server always serializes
          // resolved data into __INITIAL_DATA__ even when no component awaited it. The
          // non-blocking useSSRData idiom would otherwise end the stream before the data
          // thunk resolves → empty payload. onAllReady (subscribed below, hence before this)
          // fires first and sets the server's finalData; on rejection that chain's .catch →
          // fail() owns teardown, so we do nothing here. Trade-off: a never-settling thunk
          // now holds the stream open — react's semantics for a suspending render, an app
          // bug not a τjs one.
          const ready = store?.ready;
          if (ready) ready.then(finishStream, () => {});
          else finishStream();
          return;
        }

        if (!firstChunkSeen) {
          firstChunkSeen = true;
          // Honest shell semantics: first streamed content byte.
          try {
            stopShellTimer();
          } catch {}
          log('Shell ready:', location);
          try {
            cb.onShellReady();
          } catch (cbErr) {
            warn('onShellReady callback threw:', cbErr);
          }
        }

        try {
          writable.write(chunk);
        } catch {}
      },
      destroy: (err: unknown) => {
        if (controller.isAborted) return;
        // R0-02: `destroy` is fed by the render pipeline — render-origin, never benign by shape.
        // Real client disconnects arrive via the writable guards ('socket') and the AbortSignal,
        // which remain benign-capable.
        if (isBenignStreamErr(err, 'render')) {
          controller.benignAbort('Client disconnected during stream');
          return;
        }
        fail(err);
      },
    };

    try {
      // `store` (the outer let) is what the sink's completion handler reads; `s` is a
      // non-nullable alias for use within this synchronous+async block.
      const s = createSSRStore(initialData);
      store = s;
      const app = createAppWithStore(s, appComponent, { location, routeContext });

      // App-instance customization before render (a throw is caught by this try and routed
      // through fail → onError + fatal abort).
      setupApp?.(app);

      // Head is built once from the current snapshot and delivered ONLY via onHead. In
      // streaming strategy the snapshot is usually still pending, so heads must be
      // derivable from meta/routeContext.
      const head = headContent({
        data: (s.getSnapshot() ?? {}) as T,
        meta,
        routeContext,
      });
      try {
        cb.onHead(head);
      } catch (cbErr) {
        warn('onHead callback threw:', cbErr);
      }

      // Route Vue render-time errors into the fatal path (see `fail` above). R3: chain after
      // any handler a user installed in setupApp (Sentry etc.) so τjs's routing always runs
      // and the user's still observes.
      const userErrorHandler = app.config.errorHandler;
      app.config.errorHandler = (err, instance, info) => {
        try {
          userErrorHandler?.(err, instance, info);
        } catch {}
        fail(err);
      };

      const ssrCtx: SSRContext = {};
      renderToSimpleStream(app, ssrCtx, sink);

      // Deliver final data when the store settles. Subscribed here — before the sink's
      // push(null) subscribes finishStream (R1) — so onAllReady sets the server's finalData
      // before the stream ends.
      s.ready
        .then(() => {
          if (controller.isAborted) return;
          const data = s.getSnapshot();
          if (data !== undefined) {
            cb.onAllReady(data);
            cb.onFinish(data);
          }
        })
        .catch((e) => {
          if (controller.isAborted) return;
          error('Data promise rejected:', e);
          fail(e);
        });

      controller.setStreamAbort(() => {
        // No Readable is held; writable guards + AbortSignal handle disconnects. Destroy
        // the writable defensively on manual/fatal abort.
        try {
          (writable as { destroy?: () => void }).destroy?.();
        } catch {}
      });
    } catch (err) {
      fail(err);
    }

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done,
    };
  };

  return { renderSSR, renderStream };
}
