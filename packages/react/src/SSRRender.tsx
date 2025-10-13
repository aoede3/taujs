import { Writable as NodeWritable } from 'node:stream';
import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createLogger } from './utils/Logger';

import type { Writable } from 'node:stream';
import type { Logger } from './utils/Logger';

import { createStreamController, isBenignStreamErr, startShellTimer, wireWritableGuards } from './utils/Streaming';

export type RenderCallbacks<T> = {
  onHead?: (head: string) => void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  onFinish?: (data: T) => void; // optional, fires when final data is available (onAllReady)
  onError?: (err: unknown) => void;
};

export type StreamOptions = {
  /** Timeout in ms for shell to be ready (default: 10000) */
  shellTimeoutMs?: number;
  /** Whether to use cork/uncork for batched writes (default: true) */
  useCork?: boolean;
};

export function createRenderer<T extends Record<string, unknown>>({
  appComponent,
  headContent,
  debug = false,
  logger,
  streamOptions = {},
}: {
  appComponent: (props: { location: string }) => React.ReactElement;
  headContent: (ctx: { data: T; meta: Record<string, unknown> }) => string;
  debug?: boolean;
  logger?: Partial<Logger>;
  streamOptions?: StreamOptions;
}) {
  const { log, warn, error } = createLogger(debug, logger);
  const { shellTimeoutMs = 10_000, useCork = true } = streamOptions;

  // Precompute cork support once per renderer
  const nodeSupportsCork = typeof (NodeWritable as any)?.prototype?.cork === 'function' && typeof (NodeWritable as any)?.prototype?.uncork === 'function';

  const renderSSR = async (initialData: T, location: string, meta: Record<string, unknown> = {}) => {
    log('Starting renderSSR with location:', location);
    const dynamicHead = headContent({ data: initialData, meta });
    const store = createSSRStore(initialData);
    const html = renderToString(<SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>);
    log('Completed renderSSR for location:', location);
    return { headContent: dynamicHead, appHtml: html };
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
    opts?: Partial<StreamOptions>, // per-call override
  ) => {
    const { onAllReady, onError, onHead, onShellReady, onFinish } = callbacks;

    // Merge renderer defaults with per-call overrides
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;
    const effectiveUseCork = opts?.useCork ?? useCork;

    // Stream controller centralises cleanup & settlement
    const controller = createStreamController(writable, { warn, error });

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
        onError?.(err);
        controller.fatalAbort(err);
      },
      onError,
    });
    controller.setGuardsCleanup(guardsCleanup);

    // Shell timeout (hang/suspend guard)
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;
      const timeoutErr = new Error(`Shell not ready after ${effectiveShellTimeout}ms`);
      onError?.(timeoutErr);
      controller.fatalAbort(timeoutErr);
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting renderStream with location:', location);

    try {
      const store = createSSRStore(initialData);
      const appElement = <SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>;

      const stream = renderToPipeableStream(appElement, {
        nonce: cspNonce,
        bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

        onShellReady() {
          if (controller.isAborted) return;

          // Shell ready — stop timeout
          try {
            stopShellTimer();
          } catch {}
          log('Shell ready for location:', location);

          try {
            const head = headContent({ data: {} as T, meta });
            onHead?.(head);

            // Backpressure-aware head write with optional cork/uncork
            let corked = false;
            try {
              if (effectiveUseCork && nodeSupportsCork && typeof (writable as any).cork === 'function') {
                (writable as any).cork();
                corked = true;
              }

              const ok = writable.write(head);

              const startPipe = () => {
                if (!controller.isAborted) {
                  stream.pipe(writable);
                  try {
                    onShellReady?.();
                  } catch (cbErr) {
                    warn('onShellReady callback threw:', cbErr);
                  }
                }
              };

              if (!ok) writable.once('drain', startPipe);
              else startPipe();
            } finally {
              if (corked && typeof (writable as any).uncork === 'function') {
                try {
                  (writable as any).uncork();
                } catch {}
              }
            }
          } catch (err) {
            onError?.(err);
            controller.fatalAbort(err);
          }
        },

        onAllReady() {
          if (controller.isAborted) return;
          log('All content ready for location:', location);

          const deliver = () => {
            try {
              const data = store.getSnapshot();
              onAllReady?.(data);
              onFinish?.(data);
            } catch (thrown) {
              // Suspense rethrow — retry after resolution
              if (thrown && typeof (thrown as any).then === 'function') {
                (thrown as Promise<unknown>).then(deliver).catch((e) => {
                  error('Data promise rejected:', e);
                  onError?.(e);
                  controller.fatalAbort(e);
                });
              } else {
                error('Unexpected throw from getSnapshot:', thrown);
                onError?.(thrown);
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
          onError?.(err);
          controller.fatalAbort(err);
        },

        onError(err) {
          if (controller.isAborted) return;
          // wireWritableGuards handles most stream errors via 'error'/'close',
          // but React may surface errors here too; treat client disconnects as benign
          const msg = String((err as any)?.message ?? '');
          if (isBenignStreamErr(err)) {
            controller.benignAbort('Client disconnected before stream finished');
            return;
          }
          onError?.(err);
          controller.fatalAbort(err);
        },
      });

      controller.setStreamAbort(() => stream.abort());
    } catch (err) {
      onError?.(err);
      controller.fatalAbort(err);
    }

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done, // resolves on success/benign cancel; rejects on fatal error
    };
  };

  return { renderSSR, renderStream };
}
