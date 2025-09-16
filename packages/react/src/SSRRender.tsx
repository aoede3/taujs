import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';
import type { Writable } from 'node:stream';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createLogger } from './utils/Logger';
import { safeDestroyWritable } from './utils/Writable';

import type { Logger } from './utils/Logger';

type HeadContentFn<T> = (ctx: { data: T; meta: Record<string, unknown> }) => string;

export type RenderCallbacks<T> = {
  onHead?: (head: string) => void;
  onFinish?: (data: T) => void;
  onShellError?: (err: unknown) => void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  onError?: (err: unknown) => void;
};

export function createRenderer<T extends {}>({
  appComponent,
  headContent,
  debug = false,
  logger,
}: {
  appComponent: (props: { location: string }) => React.ReactElement;
  headContent: HeadContentFn<T>;
  debug?: boolean;
  logger?: Partial<Logger>;
}) {
  const { log, warn, error } = createLogger(debug, logger);

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
  ) => {
    const { onAllReady, onError, onHead, onShellReady } = callbacks;
    const isBenignAbort = (e: unknown) => {
      const msg = String((e as any)?.message ?? e ?? '');
      return /aborted|abort(ed)? by the server|closed early|socket hang up|premature|ECONNRESET|EPIPE/i.test(msg);
    };
    let abortFn: () => void = () => {};
    let aborted = false;

    log('Starting renderStream with location:', location);

    try {
      const store = createSSRStore(initialData);
      const appElement = <SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>;

      const { pipe, abort: reactAbort } = renderToPipeableStream(appElement, {
        nonce: cspNonce,
        bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

        onShellReady() {
          log('Shell ready for location:', location);

          try {
            const dynamicHead = headContent({ data: {} as T, meta });
            onHead?.(dynamicHead);
          } catch (headErr) {
            error('Error generating head content:', headErr);
            onError?.(headErr);
            return;
          }

          onShellReady?.();
          pipe(writable);
        },

        onAllReady() {
          log('All content ready for location:', location);
          const retry = () => {
            try {
              const data = store.getSnapshot();
              onAllReady?.(data);
            } catch (thrown) {
              // React throwing tantrum, promise, blah
              if (thrown && typeof (thrown as any).then === 'function') {
                (thrown as Promise<unknown>).then(retry).catch((e) => {
                  error('Data promise rejected on allReady retry:', e);
                  onError?.(e);
                });
              } else {
                error('Unexpected throw from getSnapshot:', thrown);
                onError?.(thrown);
              }
            }
          };
          retry();
        },

        onError(err) {
          if (aborted || isBenignAbort(err)) {
            warn('Client disconnected before stream finished');
            return;
          }

          error('Error during renderStream:', err);
          onError?.(err);
        },
      });

      abortFn = () => {
        if (aborted) return;
        aborted = true;

        try {
          reactAbort();
        } catch {}

        try {
          safeDestroyWritable(writable);
        } catch {}

        log('Stream aborted for location:', location);
      };

      if (signal) {
        const onAbort = () => {
          warn('AbortSignal triggered, aborting stream for location:', location);
          abortFn();
        };

        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    } catch (err) {
      error('Unhandled error in renderStream setup:', err);
      onError?.(err);
    }

    return {
      abort() {
        warn('Manual abort called for location:', location);
        abortFn();
      },
    };
  };

  return { renderSSR, renderStream };
}
