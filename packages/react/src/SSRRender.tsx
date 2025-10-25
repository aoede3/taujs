import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createUILogger } from './utils/Logger';

import type { Writable } from 'node:stream';
import type { LoggerLike } from './utils/Logger';

import { createStreamController, isBenignStreamErr, startShellTimer, wireWritableGuards } from './utils/Streaming';

export type RenderCallbacks<T> = {
  onHead?: (head: string) => boolean | void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  onFinish?: (data: T) => void; // optional, legacy fires when final data is available (onAllReady)
  onError?: (err: unknown) => void;
};

export type StreamOptions = {
  /** Timeout in ms for shell to be ready (default: 10000) */
  shellTimeoutMs?: number;
  /** Whether to use cork/uncork for batched writes (default: true) */
  useCork?: boolean;
};

type SSRResult = { headContent: string; appHtml: string; aborted: boolean };

type StreamCallOptions = StreamOptions & { logger?: LoggerLike };

const NOOP = () => {};

export function createRenderer<T extends Record<string, unknown>>({
  appComponent,
  headContent,
  streamOptions = {},
  logger,
  enableDebug = false,
}: {
  appComponent: (props: { location: string }) => React.ReactElement;
  headContent: (ctx: { data: T; meta: Record<string, unknown> }) => string;
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
    opts?: { logger?: LoggerLike },
  ): Promise<SSRResult> => {
    const { log, warn } = createUILogger(opts?.logger ?? logger, {
      debugCategory: 'ssr',
      context: { scope: 'react-ssr' },
      enableDebug,
    });

    if (signal?.aborted) {
      warn('SSR skipped; already aborted', { location });

      return { headContent: '', appHtml: '', aborted: true };
    }

    let aborted = false;
    const onAbort = () => (aborted = true);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      log('Starting SSR:', location);

      const dynamicHead = headContent({ data: initialData, meta });
      const store = createSSRStore(initialData);
      const html = renderToString(<SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>);

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
    callbacks: RenderCallbacks<T> = {},
    initialData: T | Promise<T> | (() => Promise<T>),
    location: string,
    bootstrapModules?: string,
    meta: Record<string, unknown> = {},
    cspNonce?: string,
    signal?: AbortSignal,
    opts?: StreamCallOptions, // per-call override
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
      context: { scope: 'react-streaming' },
      enableDebug,
    });

    // Merge renderer defaults with per-call overrides
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;
    const effectiveUseCork = opts?.useCork ?? useCork;

    // Stream controller centralises cleanup & settlement
    const controller = createStreamController(writable, { log, warn, error });

    // Wire AbortSignal (benign cancel)
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

    // Writable guards BEFORE any writes/piping (handles error/close/finish)
    const { cleanup: guardsCleanup } = wireWritableGuards(writable, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => {
        cb.onError(err);
        controller.fatalAbort(err);
      },
      onError: cb.onError,
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(guardsCleanup);

    // Shell timeout guard
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;

      const timeoutErr = new Error(`Shell not ready after ${effectiveShellTimeout}ms`);
      cb.onError(timeoutErr);
      controller.fatalAbort(timeoutErr);
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    try {
      const store = createSSRStore(initialData);
      const appElement = <SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>;

      const stream = renderToPipeableStream(appElement, {
        nonce: cspNonce,
        bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

        onShellReady() {
          if (controller.isAborted) return;

          try {
            stopShellTimer();
          } catch {}

          log('Shell ready:', location);

          try {
            // Prefer current snapshot if available (sync path).
            let headData: T | undefined;
            try {
              headData = store.getSnapshot();
            } catch (thrown) {
              // In async/lazy cases, snapshot may not be ready yet. That's fine.
              // If it's a promise (thenable), attach a rejection handler to prevent unhandled rejection
              if (thrown && typeof (thrown as any).then === 'function') {
                (thrown as Promise<unknown>).catch(() => {
                  // error swallowed here and will be handled in onAllReady
                });
              }
            }
            const head = headContent({ data: headData ?? ({} as T), meta });

            // Enable only when both requested and supported
            const canCork =
              effectiveUseCork &&
              typeof (writable as Writable & { cork?: () => void; uncork?: () => void }).cork === 'function' &&
              typeof (writable as Writable & { cork?: () => void; uncork?: () => void }).uncork === 'function';

            if (canCork)
              try {
                (writable as any).cork();
              } catch {}

            let wroteOk = true;
            try {
              // single head write drives backpressure logic
              const res = typeof (writable as any).write === 'function' ? (writable as any).write(head) : true;
              wroteOk = res !== false;
            } finally {
              if (canCork) {
                try {
                  (writable as any).uncork();
                } catch {}
              }
            }

            // Let onHead() *optionally* force waiting for 'drain'
            let forceWait = false;
            try {
              forceWait = cb.onHead(head) === false;
            } catch (cbErr) {
              warn('onHead callback threw:', cbErr);
            }

            const startPipe = () => stream.pipe(writable);
            if (forceWait || !wroteOk) {
              if (typeof (writable as any).once === 'function') {
                (writable as any).once('drain', startPipe);
              } else {
                // no drain support; best effort start
                startPipe();
              }
            } else startPipe();

            try {
              cb.onShellReady();
            } catch (cbErr) {
              warn('onShellReady callback threw:', cbErr);
            }
          } catch (err) {
            cb.onError(err);
            controller.fatalAbort(err);
          }
        },
        onAllReady() {
          if (controller.isAborted) return;
          log('All content ready:', location);

          const deliver = () => {
            try {
              const data = store.getSnapshot();
              cb.onAllReady(data);
              cb.onFinish(data);
            } catch (thrown) {
              // Suspense rethrow - retry after resolution
              if (thrown && typeof (thrown as any).then === 'function') {
                (thrown as Promise<unknown>).then(deliver).catch((e) => {
                  error('Data promise rejected:', e);
                  cb.onError(e);
                  controller.fatalAbort(e);
                });
              } else {
                error('Unexpected throw from getSnapshot:', thrown);
                cb.onError(thrown);
                controller.fatalAbort(thrown);
              }
            }
          };

          deliver();
        },

        onShellError(err) {
          if (controller.isAborted) return;

          try {
            stopShellTimer();
          } catch {}

          cb.onError(err);
          controller.fatalAbort(err);
        },

        onError(err) {
          if (controller.isAborted) return;
          // wireWritableGuards handles most stream errors via 'error'/'close',
          // but React may surface errors here too; treat client disconnects as benign
          const msg = String((err as any)?.message ?? '');
          warn('React stream error:', msg);

          if (isBenignStreamErr(err)) {
            controller.benignAbort('Client disconnected before stream finished');

            return;
          }

          cb.onError(err);
          controller.fatalAbort(err);
        },
      });

      controller.setStreamAbort(() => stream.abort());
    } catch (err) {
      cb.onError(err);
      controller.fatalAbort(err);
    }

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done, // resolves on success/benign cancel; rejects on fatal error
    };
  };

  return { renderSSR, renderStream };
}
