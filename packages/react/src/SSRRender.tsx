import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import type { Writable } from 'node:stream';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { getStoreReadiness } from './internal';
import { createUILogger } from './utils/Logger';

import type { LoggerLike } from './utils/Logger';

import { createStreamController, startShellTimer, wireWritableGuards } from './utils/Streaming';

/**
 * R1-01: structured, NON-FATAL render-error observation.
 *
 * `phase` is the OBSERVED timing — had the shell committed when React's `onError` fired? It is
 * descriptive only and NEVER a fatality signal (a `pre-shell` `onError` can be followed by a
 * successful shell commit, verified against real react-dom/server). `recoverable` is `true` only
 * for `post-shell` errors (boundary-scoped — React recovers them client-side) and `'unknown'` for
 * `pre-shell` (its outcome is resolved by the separate fatal channels: a subsequent `onShellError`
 * fails the render, a subsequent shell commit means it recovered).
 */
export type RenderErrorInfo = {
  error: unknown;
  phase: 'pre-shell' | 'post-shell';
  recoverable: boolean | 'unknown';
};

export type RenderCallbacks<T> = {
  /**
   * REQUIRED (operationally): commits the response head + connects the sink. A throwing `onHead`
   * enters the fatal path — the response cannot proceed without it.
   */
  onHead?: (head: string) => void;
  /** Advisory (observes; isolated — a throw is logged, not fatal). */
  onShellReady?: () => void;
  /** Advisory. Fires exactly once with the resolved route data. */
  onAllReady?: (data: T) => void;
  /** @deprecated Legacy alias of `onAllReady`, fires when final data is available. Use `onAllReady`. */
  onFinish?: (data: T) => void;
  /** FATAL error channel: a fatal stream error (shell error / timeout / guard / non-recoverable). */
  onError?: (err: unknown) => void;
  /**
   * Advisory, NON-FATAL structured render-error channel (R1-01). Fires for React render errors that
   * do NOT themselves fail the response — notably post-shell boundary errors React recovers
   * client-side. Never a fatality signal; fatality stays with `onError`/`onShellError`/timers/guards.
   */
  onRenderError?: (info: RenderErrorInfo) => void;
};

export type StreamOptions = {
  /** Timeout in ms for shell to be ready (default: 10000) */
  shellTimeoutMs?: number;
  /**
   * R1-01: timeout in ms for route data to settle AFTER React has finished rendering, before the
   * response is failed (default: 30000). Bounds the end-gate so a never-settling loader cannot hold
   * the response (and its listeners/streams) open indefinitely.
   */
  dataTimeoutMs?: number;
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
  const { shellTimeoutMs = 10_000, dataTimeoutMs = 30_000 } = streamOptions;

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
      onRenderError: callbacks.onRenderError ?? (NOOP as (info: RenderErrorInfo) => void),
    };
    const { log, warn, error } = createUILogger(opts?.logger ?? logger, {
      debugCategory: 'ssr',
      context: { scope: 'react-streaming' },
      enableDebug,
    });
    const routeContext = opts?.routeContext;

    // Merge renderer defaults with per-call overrides
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;
    const effectiveDataTimeout = opts?.dataTimeoutMs ?? dataTimeoutMs;

    // Stream controller centralises cleanup & settlement
    const controller = createStreamController(writable, { log, warn, error });

    // EVERY fatal path routes through here (single site that fires `cb.onError` for a fatal —
    // no double-fire). The ORIGINAL error is the rejection reason.
    //
    // Ordering (gate-review finding 2): claim the terminal fatal state via `controller.fatalAbort`
    // FIRST, THEN run the isolated host `cb.onError`. The host callback may SYNCHRONOUSLY abort the
    // very AbortSignal we wired to `controller.benignAbort` (the server's `onError` calls
    // `ac.abort()`, and `ac.signal` is this renderer's `signal`). If that re-entrant benign abort
    // ran BEFORE we claimed fatal, it would win the one-shot controller and RESOLVE `done` — silently
    // downgrading a fatal to a benign completion and violating the `RenderStreamHandle` contract
    // (fatal ⇒ `done` rejects). fatalAbort-first makes the re-entrant `benignAbort` a no-op.
    //
    // `cb.onError` is still SWALLOWED on throw (and cannot veto settlement, already claimed) — it may
    // run from a timer or a writable EventEmitter listener where a throw would be an uncaughtException.
    const failFatal = (err: unknown) => {
      controller.fatalAbort(err);
      try {
        cb.onError(err);
      } catch (cbErr) {
        warn('onError callback threw:', cbErr);
      }
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

    // Set by armDataDeadline (below) to its idempotent disarm. Composed into the controller's cleanup
    // so ANY termination path tears the data deadline down PROMPTLY — the recheck showed relying on the
    // writable's 'close' event is unsound (a writable created with `emitClose: false` is destroyed
    // without emitting 'close', leaving the timer/closure/listener live until dataTimeoutMs).
    let stopDataDeadline: (() => void) | undefined;

    // Writable guards (handles error/close/finish)
    const { cleanup: guardsCleanup } = wireWritableGuards(writable, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => failFatal(err),
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(() => {
      try {
        guardsCleanup();
      } catch {}
      try {
        stopDataDeadline?.();
      } catch {}
    });

    // Shell timeout guard
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;

      const timeoutErr = new Error(`Shell not ready after ${effectiveShellTimeout}ms`);
      failFatal(timeoutErr);
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    let piped = false;
    let shellCommitted = false;
    let delivered = false;

    try {
      // Store is created here so the renderer can read its INTERNAL readiness (design 1) for the
      // bounded end-gate; the public SSRStore type is unchanged.
      const store = createSSRStore(initialData);
      const readiness = getStoreReadiness(store) ?? Promise.resolve();

      // Single-fire delivery (design 2): fires onAllReady/onFinish exactly once, from the end-gate
      // after data has settled — replacing the thrown-thenable retry dance. Reading the snapshot can
      // still throw (e.g. a loader that resolves to `undefined` settles status:'success' with no
      // data): route that through failFatal so it becomes a clean fatal, never a hung response.
      const deliverFinalData = () => {
        if (delivered) return;

        let data: T;
        try {
          data = store.getSnapshot();
        } catch (snapErr) {
          failFatal(snapErr instanceof Error ? snapErr : new Error('SSR data unavailable at delivery'));
          return;
        }

        delivered = true;
        try {
          cb.onAllReady(data);
        } catch (cbErr) {
          error('onAllReady callback threw:', cbErr);
        }
        try {
          cb.onFinish(data);
        } catch (cbErr) {
          error('onFinish callback threw:', cbErr);
        }
      };

      // Route-data liveness deadline (design 3, gate-review finding 1). The bound on route-data
      // settlement must NOT depend on React calling the sink's end(): a <Suspense> consumer of the
      // store keeps React's stream open until the thrown data promise settles, so for a never-settling
      // loader React NEVER ends — and if the deadline lived only in the end path (below) nothing would
      // ever fire. Arm it explicitly once the shell is committed (a post-shell data budget matching
      // `dataTimeoutMs`), independent of end(). On expiry it enters the single fatal path (which aborts
      // React + tears the response down).
      //
      // Teardown (recheck finding): it is disarmed when route data settles, on controller termination
      // (via `stopDataDeadline`, composed into the controller cleanup above — the AUTHORITATIVE path,
      // since a writable with `emitClose: false` never emits 'close'), and defensively on 'close'.
      // `teardown` ALWAYS clears the timer and removes the listener idempotently, including after the
      // timer itself has won — so nothing (timer, closure, listener, readiness continuation) is
      // retained past the terminal event.
      let dataDeadlineArmed = false;
      const armDataDeadline = () => {
        if (dataDeadlineArmed) return;
        dataDeadlineArmed = true;
        if (store.status !== 'pending') return; // already settled — nothing to bound

        let timer: ReturnType<typeof setTimeout>;
        const teardown = () => {
          clearTimeout(timer);
          try {
            writable.removeListener('close', disarm);
          } catch {}
        };
        let settled = false;
        const disarm = () => {
          if (settled) return;
          settled = true;
          teardown();
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          teardown(); // clear our own listener even when the timer wins
          if (controller.isAborted) return; // another path already owns settlement
          failFatal(new Error(`Route data not ready after ${effectiveDataTimeout}ms`));
        }, effectiveDataTimeout);

        // Data settled (resolve OR swallowed error) → disarm. Controller termination → stopDataDeadline
        // (authoritative). 'close' is a secondary signal for the emitClose:true case.
        readiness.then(disarm, disarm);
        writable.once('close', disarm);
        stopDataDeadline = disarm;
      };

      // Deferred end (design 2/3): React pipes final output into the delegating sink; we defer the
      // real writable's end() until route data has settled so LATE data (no-consumer path) is
      // serialized before finish. Liveness is owned by armDataDeadline above, NOT here — so a Suspense
      // consumer whose data never settles (React never reaches this end()) is still bounded.
      let endStarted = false;
      const deferredEnd = () => {
        if (controller.isAborted || endStarted) return;
        endStarted = true;

        readiness
          .then(() => {
            // Aborted during the data wait (incl. the data deadline firing): the writable is already
            // torn down — do not deliver to a gone response nor end() a destroyed stream.
            if (controller.isAborted) return;
            if (store.status === 'error') {
              failFatal(store.lastError ?? new Error('SSR data fetch failed'));
              return;
            }
            deliverFinalData();
            // deliverFinalData may itself fatal-abort (e.g. undefined snapshot); don't end() then.
            if (controller.isAborted) return;
            writable.end();
          })
          .catch((e) => {
            if (controller.isAborted) return;
            failFatal(e);
          });
      };

      // React only ever calls write(view) [single chunk arg], end(), destroy(err), on/once/
      // removeListener(event, handler), and (guarded) flush(). We omit flush() so React skips it,
      // and forward the rest to the real writable so its own listeners/backpressure are authoritative.
      const endGate = {
        write: (chunk: unknown): boolean => (controller.isAborted ? true : writable.write(chunk as Uint8Array)),
        end: () => deferredEnd(),
        destroy: (err?: unknown) => writable.destroy(err as Error | undefined),
        on: (event: string, handler: (...args: unknown[]) => void) => (writable.on(event, handler), endGate),
        once: (event: string, handler: (...args: unknown[]) => void) => (writable.once(event, handler), endGate),
        removeListener: (event: string, handler: (...args: unknown[]) => void) => (writable.removeListener(event, handler), endGate),
        emit: (event: string, ...args: unknown[]) => writable.emit(event, ...args),
        get destroyed() {
          return writable.destroyed;
        },
        get writable() {
          return writable.writable;
        },
      };

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

            // onHead is REQUIRED (design 6): it commits the response head and connects the sink. A
            // throwing onHead is fatal — do NOT pipe into an unconsumed sink (hung response).
            try {
              cb.onHead(head);
            } catch (cbErr) {
              failFatal(cbErr);
              return;
            }

            if (!piped) {
              piped = true;
              shellCommitted = true;
              // The delegating sink duck-types the Node Writable surface React's pipe uses.
              stream.pipe(endGate as unknown as Writable);
            }

            // Shell is committed: bound the remaining route-data wait independent of React's end()
            // (finding 1) — a Suspense consumer whose data never settles keeps React streaming, so
            // React may never call end(); this deadline fires regardless.
            armDataDeadline();

            // Advisory (design 6): a throw is logged, not fatal.
            try {
              cb.onShellReady();
            } catch (cbErr) {
              error('onShellReady callback threw:', cbErr);
            }
          } catch (err) {
            failFatal(err);
          }
        },
        onAllReady() {
          // Delivery is owned by the bounded end-gate (deferred until data readiness). This is
          // advisory — React signalling all content is ready.
          if (controller.isAborted) return;
          log('All content ready:', location);
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

          // R3 + recoverability ruling (decisions 2026-07-11): React's onError fires for EVERY
          // render error, INCLUDING post-shell boundary errors it recovers client-side. `phase` is
          // the OBSERVED timing (had the shell committed when onError fired) — descriptive only,
          // NEVER a fatality signal. `recoverable` is true only post-shell (boundary-scoped by
          // React's semantics), 'unknown' pre-shell (its outcome is resolved by the separate fatal
          // channels: a subsequent onShellError fails it; a subsequent shell commit means it
          // recovered). This channel is NON-FATAL — fatality stays with onShellError / timers /
          // guards / outer catch.
          const phase: RenderErrorInfo['phase'] = shellCommitted ? 'post-shell' : 'pre-shell';
          const recoverable: RenderErrorInfo['recoverable'] = phase === 'post-shell' ? true : 'unknown';

          // Recheck-2: pass the RAW error to the non-throwing UI logger (no eager coercion).
          error('React render error:', err);

          // Advisory (design 6): isolate a throwing onRenderError.
          try {
            cb.onRenderError({ error: err, phase, recoverable });
          } catch (cbErr) {
            error('onRenderError callback threw:', cbErr);
          }
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
