import { createSSRApp, h, type Component, type VNode } from 'vue';
import { renderToSimpleStream, renderToString, type SimpleReadable, type SSRContext } from '@vue/server-renderer';

import { createSSRStore, SSRStoreProvider, type SSRStore } from './SSRDataStore';
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
  onFinish?: (data: T) => void; // legacy alias of onAllReady
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
}: {
  /**
   * Vue root. You can supply a Vue component, or a function returning VNode.
   * It will be invoked/rendered with props: { location, routeContext? }
   */
  appComponent: Component | ((props: { location: string; routeContext?: R }) => VNode);
  headContent: (ctx: HeadContext<T, R>) => string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  streamOptions?: StreamOptions;
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
      cb.onError(err);
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

    const sink: SimpleReadable = {
      push: (chunk: string | null) => {
        if (controller.isAborted) return;

        if (chunk === null) {
          // End of render. Emit the client bootstrap so a streamed route hydrates (the
          // server injects no bootstrap in streaming strategy — it delegates that here),
          // then end the writable. The server's `finish` handler appends the
          // __INITIAL_DATA__ script and template tail. hydrateApp defers to
          // DOMContentLoaded, by which time that data script has executed, so ordering
          // (bootstrap before data script) is safe.
          if (bootstrapModules) {
            const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
            try {
              writable.write(`<script type="module" src="${bootstrapModules}" async${nonceAttr}></script>`);
            } catch {}
          }
          try {
            writable.end();
          } catch {}
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
        if (isBenignStreamErr(err)) {
          controller.benignAbort('Client disconnected during stream');
          return;
        }
        fail(err);
      },
    };

    try {
      const store = createSSRStore(initialData);
      const app = createAppWithStore(store, appComponent, { location, routeContext });

      // Head is built once from the current snapshot and delivered ONLY via onHead. In
      // streaming strategy the snapshot is usually still pending, so heads must be
      // derivable from meta/routeContext.
      const head = headContent({
        data: (store.getSnapshot() ?? {}) as T,
        meta,
        routeContext,
      });
      try {
        cb.onHead(head);
      } catch (cbErr) {
        warn('onHead callback threw:', cbErr);
      }

      // Route Vue render-time errors into the fatal path (see `fail` above).
      app.config.errorHandler = (err) => fail(err);

      const ssrCtx: SSRContext = {};
      renderToSimpleStream(app, ssrCtx, sink);

      // Deliver final data when the store settles.
      store.ready
        .then(() => {
          if (controller.isAborted) return;
          const data = store.getSnapshot();
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
