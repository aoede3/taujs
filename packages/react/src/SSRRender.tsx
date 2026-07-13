import React from 'react';
import { renderToPipeableStream } from 'react-dom/server';
// R3-06 (+ gate-review fix): the CONDITIONAL subpath, deliberately. Node resolves it to
// static.node.js (which exports prerenderToNodeStream); a browser bundler resolves it to
// static.browser.js, which is browser-COMPATIBLE (no node builtins) and tree-shaken from client
// output like the rest of this module. The earlier `react-dom/static.node` import resolved the
// NODE build into browser graphs — clean final bytes, but externalization warnings for
// util/crypto/async_hooks/stream, and a hard resolve error under stricter bundlers (webpack 5).
// Namespace import + destructure: static.browser.js lacks this export, so a named import could
// trip CJS named-export detection in some bundlers; property access cannot.
import * as ReactDOMStatic from 'react-dom/static';

const { prerenderToNodeStream } = ReactDOMStatic;

import type { Writable } from 'node:stream';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore.js';
import { getStoreReadiness } from './internal.js';
import { createUILogger } from './utils/Logger.js';

import type { LoggerLike } from './utils/Logger.js';

import { createStreamController, startShellTimer, wireWritableGuards } from './utils/Streaming.js';

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

export type SSROptions = {
  /**
   * R3-06 (Q3, Policy A - signed 2026-07-12): deadline in ms for the `ssr` strategy's render
   * (default: 10000; `0`/`Infinity` = wait forever). The `ssr` strategy now renders COMPLETE HTML -
   * it waits for `React.lazy`/`use()` content that `renderToString` silently dropped. Nothing is
   * served until the render finishes, so this deadline is a TTFB ceiling (hence the SHELL-class
   * default, matching `shellTimeoutMs` - route data does not count against it; the server resolves
   * data BEFORE the render starts). On expiry: if the shell completed, the fallback-state HTML is
   * SERVED (React's documented abort degrade - the client completes the boundaries; an advisory
   * warning is logged, since the `ssr` path has no `onRenderError` callback channel); if the shell
   * never completed, the render THROWS into the host's error path instead of serving a blank page.
   */
  prerenderTimeoutMs?: number;
};

/**
 * Context passed to `headContent`: `data` is the resolved route data, `meta`/`routeContext` the
 * route's static metadata and per-request context. NB `headContent` returns RAW `<head>` HTML — any
 * value interpolated from `data`, `headData` (or other services/user input) must be escaped with
 * `escapeHtml` (see the `headContent` option's docs).
 *
 * RFC 0004 (H2): `headData` is the route's `attr.head` payload, resolved by the host BEFORE the
 * render starts on BOTH strategies and delivered via `opts.headData`. It is OPTIONAL in the type
 * by contract: `undefined` when the route declares no `attr.head`, and when the head loader
 * degraded under the signed policy (deadline expiry, or an `optional` loader failure) — handle
 * the undefined case (typically by falling back to `meta`).
 */
export type HeadContext<
  T extends Record<string, unknown> = Record<string, unknown>,
  R = unknown,
  H extends Record<string, unknown> = Record<string, unknown>,
> = {
  data: T;
  headData?: H;
  meta: Record<string, unknown>;
  routeContext?: R;
};

type SSRResult = { headContent: string; appHtml: string; aborted: boolean };

type StreamCallOptions<R> = StreamOptions & {
  logger?: LoggerLike;
  // RFC 0004 (H2): broad at the contract boundary (same contravariance reality as headData/T);
  // narrowed to `R` at the single read below. `R` remains the app-facing type via HeadContext
  // and appComponent.
  routeContext?: unknown;
  // RFC 0004 (H2): BROAD at the contract boundary (the host cannot know `H`); narrowed to `H` at
  // the single seam where `headContent` is invoked — the same trust model as the body data.
  headData?: Record<string, unknown>;
};

const NOOP = () => {};

export function createRenderer<
  T extends Record<string, unknown> = Record<string, unknown>,
  R = unknown,
  H extends Record<string, unknown> = Record<string, unknown>,
>({
  appComponent,
  headContent,
  streamOptions = {},
  ssrOptions = {},
  logger,
  enableDebug = false,
  identifierPrefix,
}: {
  appComponent: (props: { location: string; routeContext?: R }) => React.ReactElement;
  /**
   * Returns the per-route `<head>` inner HTML. The return value is written into `<head>` VERBATIM as
   * RAW HTML — it is deliberately NOT auto-escaped, so you can emit `<meta>`/`<link>`/`<script>` tags.
   * Therefore any value interpolated from `data` (services or user input) MUST be escaped first with
   * `escapeHtml` (exported from `@taujs/react`), e.g.
   * `` `<meta property="og:image" content="${escapeHtml(data.ogImage)}">` ``. See the head-management
   * guide, "Best Practices — Escape User Content".
   */
  headContent: (ctx: HeadContext<T, R, H>) => string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  streamOptions?: StreamOptions;
  ssrOptions?: SSROptions;
  /**
   * React's `identifierPrefix` for `useId` (passed to `prerenderToNodeStream` and `renderToPipeableStream`).
   * It MUST be identical on the server and the client for a given root (pass the same value to
   * `hydrateApp`), or hydration mismatches. Set it when rendering MORE THAN ONE τjs root on a page
   * (the app-per-boundary / micro-frontend model) so each root's `useId` values are collision-free.
   * A server-derived default from `appId` is a possible future (R3-03); today it is app-supplied.
   */
  identifierPrefix?: string;
}) {
  const { shellTimeoutMs = 10_000, dataTimeoutMs = 30_000 } = streamOptions;
  const { prerenderTimeoutMs = 10_000 } = ssrOptions;

  // Gate-review fix: validate ONCE at the factory. The timer site arms only for finite positive
  // values, so without this check every invalid input (-1, NaN, null, a string from untyped JS,
  // -Infinity) silently became "wait forever" — only 0 and Infinity are documented sentinels.
  const validTimeout =
    prerenderTimeoutMs === 0 ||
    prerenderTimeoutMs === Infinity ||
    (typeof prerenderTimeoutMs === 'number' && Number.isFinite(prerenderTimeoutMs) && prerenderTimeoutMs > 0);
  if (!validTimeout) {
    throw new TypeError(
      `createRenderer: ssrOptions.prerenderTimeoutMs must be a positive finite number of milliseconds, 0, or Infinity (received ${String(prerenderTimeoutMs)})`,
    );
  }

  // RFC 0004 (H2): the contract-facing parameter types are BROAD (`Record<string, unknown>`) so a
  // renderer instantiated with non-default generics stays assignable to the host's RenderSSR /
  // RenderStream contracts under strictFunctionTypes (the non-default conformance test pins this).
  // The values are trusted as `T`/`H` at ONE internal seam each — route-config inference is the
  // type authority, exactly as it always was for the body data.
  const renderSSR = async (
    initialData: Record<string, unknown>,
    location: string,
    meta: Record<string, unknown> = {},
    signal?: AbortSignal,
    opts?: { logger?: LoggerLike; routeContext?: unknown; headData?: Record<string, unknown> },
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
    // One controller composes the caller's signal with the internal deadline (R3-06). Manual
    // composition instead of `AbortSignal.any`: portable to every environment this renders in
    // (jsdom's AbortSignal has no `.any`, and hosts may shim the global), and which source fired
    // stays distinguishable via `aborted` (caller) vs `deadlineHit` (deadline).
    const renderAbort = new AbortController();
    const onAbort = () => {
      aborted = true;
      renderAbort.abort(signal?.reason ?? new Error('SSR aborted by caller'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // The R narrowing seam (RFC 0004 H2).
    const routeContext = opts?.routeContext as R | undefined;

    try {
      log('Starting SSR:', location);

      // The T/H narrowing seam for this strategy (see the note on renderSSR's signature).
      const dynamicHead = headContent({ data: initialData as T, headData: opts?.headData as H | undefined, meta, routeContext });
      const store = createSSRStore(initialData as T);

      // R3-06 (Q3, Policy A): `prerenderToNodeStream` replaces `renderToString`, which could not
      // suspend - any `React.lazy`/`use()` subtree SILENTLY became its fallback plus a
      // client-render marker, with zero diagnostics (route data is unaffected either way: the
      // server resolves it before calling renderSSR, so the store never suspends on this path).
      //
      // Deadline semantics (probes 04/05, react-dom 19.2.7): an aborted prerender NEVER rejects.
      // Abort with the shell complete resolves with fallback-state boundaries in the prelude
      // (the client completes them on hydration - React's documented degrade); abort before the
      // shell completes resolves with a 0-BYTE prelude, which must become an error, never a blank
      // 200. Real render errors outside a boundary reject the promise into the host's error path,
      // as renderToString's throw did.
      let deadlineHit = false;
      const deadlineTimer =
        Number.isFinite(prerenderTimeoutMs) && prerenderTimeoutMs > 0
          ? setTimeout(() => {
              deadlineHit = true;
              renderAbort.abort(new Error(`SSR prerender deadline (${prerenderTimeoutMs}ms) reached`));
            }, prerenderTimeoutMs)
          : undefined;

      let appHtml = '';
      try {
        const { prelude } = await prerenderToNodeStream(<SSRStoreProvider store={store}>{appComponent({ location, routeContext })}</SSRStoreProvider>, {
          identifierPrefix,
          signal: renderAbort.signal,
          onError(err) {
            // Advisory: boundary errors, abort reasons, and pre-reject errors all surface here.
            // Raw value to the non-throwing UI logger - never coerce error properties eagerly
            // (recheck-2 lesson). Fatality is decided by the outcome policy below, never here.
            warn('SSR prerender onError:', err);
          },
        });

        // Concat as buffers - naive string += can split a multi-byte character across chunks.
        const chunks: Buffer[] = [];
        for await (const chunk of prelude) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        appHtml = Buffer.concat(chunks).toString('utf8');
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }

      if (aborted) {
        warn('SSR completed after client abort', { location });

        return { headContent: '', appHtml: '', aborted: true };
      }

      if (deadlineHit) {
        if (appHtml.length === 0) {
          // The shell never completed (suspension outside any boundary): never serve a blank 200.
          throw new Error(`SSR render exceeded prerenderTimeoutMs (${prerenderTimeoutMs}ms) before the shell completed`);
        }

        // Policy A degrade: serve the fallback-state HTML; the client completes the boundaries.
        // The `ssr` path has no `onRenderError` callback channel, so the logger IS the advisory.
        warn('SSR render hit prerenderTimeoutMs; serving fallback-state HTML (client completes the pending boundaries)', {
          location,
          prerenderTimeoutMs,
        });
      }

      log('Completed SSR:', location);

      return { headContent: dynamicHead, appHtml, aborted: false };
    } finally {
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {}
    }
  };

  const renderStream = (
    writable: Writable,
    callbacks: RenderCallbacks<T> = {},
    initialData: Record<string, unknown> | Promise<Record<string, unknown>> | (() => Promise<Record<string, unknown>>),
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
    // The R narrowing seam (RFC 0004 H2).
    const routeContext = opts?.routeContext as R | undefined;

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
      // bounded end-gate; the public SSRStore type is unchanged. This is the streaming strategy's
      // T narrowing seam (RFC 0004 H2 - see the note on renderSSR's signature).
      const store = createSSRStore(initialData as T | Promise<T> | (() => Promise<T>));
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
        identifierPrefix,
        bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

        onShellReady() {
          if (controller.isAborted) return;

          try {
            stopShellTimer();
          } catch {}

          log('Shell ready:', location);

          try {
            // Prefer current snapshot if available (sync path).
            let snapshotData: T | undefined;
            try {
              snapshotData = store.getSnapshot();
            } catch (thrown) {
              // In async/lazy cases, snapshot may not be ready yet. That's fine.
              // If it's a promise (thenable), attach a rejection handler to prevent unhandled rejection
              if (thrown && typeof (thrown as any).then === 'function') {
                (thrown as Promise<unknown>).catch(() => {
                  // swallowed; will be handled in onAllReady
                });
              }
            }

            // RFC 0004 (H2): `headData` (host-resolved, pre-shell) rides alongside the snapshot -
            // the H narrowing seam for this strategy. `data` semantics are UNCHANGED (current
            // snapshot, or `{}` while route data is still pending at shell-ready).
            const head = headContent({ data: snapshotData ?? ({} as T), headData: opts?.headData as H | undefined, meta, routeContext });

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
