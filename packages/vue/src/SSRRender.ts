import { createSSRApp, h, type Component, type VNode } from 'vue';
import { renderToString, pipeToNodeWritable, type SSRContext } from '@vue/server-renderer';

import { createSSRStore, SSRStoreProvider, type SSRStore } from './SSRDataStore';
import { createUILogger } from './utils/Logger';

import type { Writable } from 'node:stream';
import type { LoggerLike } from './utils/Logger';

import { createStreamController, isBenignStreamErr, startShellTimer, wireWritableGuards } from './utils/Streaming';

export type RenderCallbacks<T> = {
  onHead?: (head: string) => boolean | void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  onFinish?: (data: T) => void; // legacy alias of onAllReady
  onError?: (err: unknown) => void;
};

export type StreamOptions = {
  /** Timeout in ms for shell to be ready (default: 10000) */
  shellTimeoutMs?: number;
  /** Whether to use cork/uncork for batched writes (default: true) */
  useCork?: boolean;
};

export type HeadContext<T extends Record<string, unknown> = Record<string, unknown>, R = unknown> = {
  data: T;
  meta: Record<string, unknown>;
  routeContext?: R;
};

type SSRResult = { headContent: string; appHtml: string; aborted: boolean };

type StreamCallOptions<R> = StreamOptions & {
  logger?: LoggerLike;
  routeContext?: R;
};

const NOOP = () => {};

function isPromiseLike(x: unknown): x is Promise<unknown> {
  return !!x && (typeof x === 'object' || typeof x === 'function') && typeof (x as any).then === 'function';
}

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
  const { shellTimeoutMs = 10_000, useCork = true } = streamOptions;

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
      const html = await renderToString(app);

      if (aborted) {
        warn('SSR completed after client abort', { location });
        return { headContent: '', appHtml: '', aborted: true };
      }

      log('Completed SSR:', location);

      return { headContent: dynamicHead, appHtml: html, aborted: false };
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
    _bootstrapModules?: string, // Vue SSR doesn't use React bootstrapModules; kept for signature parity.
    meta: Record<string, unknown> = {},
    _cspNonce?: string, // Vue SSR renderer doesn't accept nonce here; keep parity for TauJS.
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
    const effectiveUseCork = opts?.useCork ?? useCork;

    const controller = createStreamController(writable, { log, warn, error });

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
      fatalAbort: (err) => {
        // Vue Suspense can throw Promises; don't treat that as fatal.
        if (isPromiseLike(err)) return;
        cb.onError(err);
        controller.fatalAbort(err);
      },
      onError: (err) => {
        // Vue Suspense can throw Promises; don't treat that as an error.
        if (isPromiseLike(err)) return;
        cb.onError(err);
      },
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(guardsCleanup);

    // Shell timeout guard (Vue doesn't give a real "shell ready" hook; we stop this once head is written and piping begins)
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;

      const timeoutErr = new Error(`Shell not ready after ${effectiveShellTimeout}ms`);
      cb.onError(timeoutErr);
      controller.fatalAbort(timeoutErr);
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    let started = false;

    const writeHeadAndMaybeWait = (head: string) => {
      // Enable only when both requested and supported
      const canCork = effectiveUseCork && typeof (writable as any).cork === 'function' && typeof (writable as any).uncork === 'function';

      if (canCork)
        try {
          (writable as any).cork();
        } catch {}

      let wroteOk = true;
      try {
        const res = typeof (writable as any).write === 'function' ? (writable as any).write(head) : true;
        wroteOk = res !== false;
      } finally {
        if (canCork)
          try {
            (writable as any).uncork();
          } catch {}
      }

      let forceWait = false;
      try {
        forceWait = cb.onHead(head) === false;
      } catch (cbErr) {
        warn('onHead callback threw:', cbErr);
      }

      return { wroteOk, forceWait };
    };

    try {
      const store = createSSRStore(initialData);
      const app = createAppWithStore(store, appComponent, { location, routeContext });

      // Prefer current snapshot if available (sync path).
      let headData: T | undefined;
      try {
        headData = store.getSnapshot();
      } catch {
        // Ignore any errors; data will be undefined
      }

      const head = headContent({
        data: headData ?? ({} as T),
        meta,
        routeContext,
      });
      const { wroteOk, forceWait } = writeHeadAndMaybeWait(head);

      const startPipe = () => {
        if (controller.isAborted || started) return;
        started = true;

        // "shell ready": head is written and we’re about to start piping HTML
        try {
          stopShellTimer();
        } catch {}
        log('Shell ready:', location);

        // Ensure Vue SSR errors flow into TauJS abort path, but ignore Suspense Promises.
        app.config.errorHandler = (err) => {
          if (controller.isAborted) return;
          if (isPromiseLike(err)) return;
          cb.onError(err);
          controller.fatalAbort(err);
        };

        const ssrCtx: SSRContext = {};
        try {
          pipeToNodeWritable(app, ssrCtx, writable);
        } catch (err) {
          if (controller.isAborted) return;
          if (isPromiseLike(err)) return; // Suspense control flow
          cb.onError(err);
          controller.fatalAbort(err);
        }
      };

      if (forceWait || !wroteOk) {
        if (typeof (writable as any).once === 'function') {
          (writable as any).once('drain', startPipe);
        } else {
          startPipe();
        }
      } else {
        startPipe();
      }

      try {
        cb.onShellReady();
      } catch (cbErr) {
        warn('onShellReady callback threw:', cbErr);
      }

      // Deliver final data when ready.
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
          // Promise rejection is real failure (not "suspense")
          error('Data promise rejected:', e);
          cb.onError(e);
          controller.fatalAbort(e);
        });

      controller.setStreamAbort(() => {
        // With pipeToNodeWritable we don’t hold a Readable. Writable guards + AbortSignal
        // should handle the disconnect path; optionally destroy the writable:
        try {
          (writable as any)?.destroy?.();
        } catch {}
      });
    } catch (err) {
      if (!isPromiseLike(err)) {
        cb.onError(err);
        controller.fatalAbort(err);
      }
      // If it's a Promise, it's Suspense control flow; do not abort the stream.
    }

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done,
    };
  };

  return { renderSSR, renderStream };
}
