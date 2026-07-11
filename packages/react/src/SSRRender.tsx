import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createUILogger } from './utils/Logger';

import type { Writable } from 'node:stream';
import type { LoggerLike } from './utils/Logger';

import { createStreamController, isBenignStreamErr, startShellTimer, wireWritableGuards } from './utils/Streaming';

export type RenderCallbacks<T> = {
  onHead?: (head: string) => void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  /** @deprecated Legacy alias of `onAllReady`, fires when final data is available. Use `onAllReady`. */
  onFinish?: (data: T) => void;
  onError?: (err: unknown) => void;
};

export type StreamOptions = {
  /** Timeout in ms for shell to be ready (default: 10000) */
  shellTimeoutMs?: number;
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

export function createRenderer<T extends Record<string, unknown> = Record<string, unknown>, R = unknown>({
  appComponent,
  headContent,
  streamOptions = {},
  logger,
  enableDebug = false,
}: {
  appComponent: (props: { location: string; routeContext?: R }) => React.ReactElement;
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

    const routeContext = opts?.routeContext;

    try {
      log('Starting SSR:', location);

      const dynamicHead = headContent({ data: initialData, meta, routeContext });
      const store = createSSRStore(initialData);
      const html = renderToString(<SSRStoreProvider store={store}>{appComponent({ location, routeContext })}</SSRStoreProvider>);

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
    opts?: StreamCallOptions<R>, // per-call override
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
    const routeContext = opts?.routeContext;

    // Merge renderer defaults with per-call overrides
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;

    // Stream controller centralises cleanup & settlement
    const controller = createStreamController(writable, { log, warn, error });

    // Recheck: EVERY fatal path routes through here so the host `onError` callback can NEVER veto
    // controller cleanup/settlement. A throwing `onError` is logged and SWALLOWED — it must not
    // veto `fatalAbort` (below, always runs) NOR escape, since this may be called from a timer or a
    // writable EventEmitter listener where a throw would be an uncaughtException. The ORIGINAL error
    // is the rejection reason. Also the single site that fires `cb.onError` for a fatal (no double-fire).
    const failFatal = (err: unknown) => {
      try {
        cb.onError(err);
      } catch (cbErr) {
        warn('onError callback threw:', cbErr);
      }
      controller.fatalAbort(err);
    };

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

    // Writable guards (handles error/close/finish)
    const { cleanup: guardsCleanup } = wireWritableGuards(writable, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => failFatal(err),
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(guardsCleanup);

    // Shell timeout guard
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;

      const timeoutErr = new Error(`Shell not ready after ${effectiveShellTimeout}ms`);
      failFatal(timeoutErr);
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    let piped = false;

    try {
      const store = createSSRStore(initialData);
      const appElement = <SSRStoreProvider store={store}>{appComponent({ location, routeContext })}</SSRStoreProvider>;

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
                  // swallowed; will be handled in onAllReady
                });
              }
            }

            const head = headContent({ data: headData ?? ({} as T), meta, routeContext });

            try {
              cb.onHead(head);
            } catch (cbErr) {
              warn('onHead callback threw:', cbErr);
            }

            if (!piped) {
              piped = true;
              stream.pipe(writable);
            }

            try {
              cb.onShellReady();
            } catch (cbErr) {
              warn('onShellReady callback threw:', cbErr);
            }
          } catch (err) {
            failFatal(err);
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
                  failFatal(e);
                });
              } else {
                error('Unexpected throw from getSnapshot:', thrown);
                failFatal(thrown);
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

          failFatal(err);
        },

        onError(err) {
          if (controller.isAborted) return;
          // R0-02: this error is render-origin (React's server render surfaced it), so it is
          // never benign by shape — a disconnect-shaped message/code thrown from app code must
          // not be swallowed. Real client disconnects arrive via wireWritableGuards ('socket').
          // Recheck-2: pass the RAW error to the non-throwing UI logger — do NOT coerce
          // `err.message` here. A hostile error (throwing `message` getter / `Symbol.toPrimitive`)
          // would throw at this line BEFORE `failFatal`, skipping settlement/cleanup and escaping
          // React's async renderer callback as an uncaughtException.
          warn('React stream error:', err);

          if (isBenignStreamErr(err, 'render')) {
            controller.benignAbort('Client disconnected before stream finished');

            return;
          }

          failFatal(err);
        },
      });

      controller.setStreamAbort(() => stream.abort());
    } catch (err) {
      failFatal(err);
    }

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done, // resolves on success/benign cancel; rejects on fatal error
    };
  };

  return { renderSSR, renderStream };
}
