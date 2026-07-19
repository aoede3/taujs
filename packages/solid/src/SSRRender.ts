import { generateHydrationScript, renderToStream, renderToStringAsync } from 'solid-js/web';

import { createSSRStore, provideSSRStore } from './SSRDataStore.js';
import { detachStore, getStoreReadiness, getStoreState } from './internal.js';
import { brandRenderFunctions, SOLID_RENDERER_KEY } from './renderContract.js';
import { escapeHtml } from './utils/Html.js';
import { SanitisedErrorPlugin } from './utils/SanitiseError.js';
import { createUILogger } from './utils/Logger.js';
import { createStreamController, startTimer, wireWritableGuards } from './utils/Streaming.js';

import type { JSX } from 'solid-js';
import type { Writable } from 'node:stream';
import type { SolidLogger } from './utils/Logger.js';

/**
 * The Solid render module (design 2 + 3). Mirrors React's controller SHAPE; its completion, error
 * and cancellation SEMANTICS follow the ruled Solid matrix, which differs in ways that copying
 * React by analogy would erase.
 *
 * What Solid does NOT do, and why it is correct that it does not:
 *
 * `onRenderError` is never invoked, and no `RenderErrorInfo` is ever constructed. The narrow
 * advisory-seam proof (evidence/SEAM-proof-commands.md) FAILED on case 2: what the seroval plugin
 * is handed for a post-shell REJECTED resource and for an ordinary RESOLVED `Error` value is
 * byte-identical, so driving an advisory from it would report render failures on successful
 * responses. Matrix rows #5/#6 are therefore Solid-managed DEGRADED COMPLETION - the stream
 * completes, `done` RESOLVES because transport completed, the serialised rejection is sanitised,
 * and the client `ErrorBoundary` handles it at hydration. A conformance test asserting Solid emits
 * `onRenderError` would be asserting a defect. The callback stays in the contract for React.
 *
 * The one Solid error channel that IS fatal is seroval's SERIALISATION FAILURE (R3) - see
 * `onSerialisationFailure` below. It is a different channel from a successfully serialised
 * rejection and the two are never conflated.
 */

export type HeadContext<T extends Record<string, unknown>, R, H extends Record<string, unknown>> = {
  data: T;
  headData?: H;
  meta: Record<string, unknown>;
  routeContext?: R;
};

export type RenderErrorInfo = {
  error: unknown;
  phase: 'pre-shell' | 'post-shell';
  recoverable: boolean | 'unknown';
};

export type RenderCallbacks<T = unknown> = {
  onHead?: (headContent: string) => void;
  onShellReady?: () => void;
  onAllReady?: (initialData: T) => void;
  onError?: (error: unknown) => void;
  /** Present for contract compatibility. Solid v1 NEVER calls it - see the module note above. */
  onRenderError?: (info: RenderErrorInfo) => void;
};

export type RenderOptions = {
  logger?: SolidLogger;
  routeContext?: unknown;
  headData?: Record<string, unknown>;
  cspNonce?: string;
  shouldHydrate?: boolean;
};

export type InitialDataInput = Record<string, unknown> | Promise<Record<string, unknown>> | (() => Promise<Record<string, unknown>>);

export type RenderStreamHandle = { abort(): void; done: Promise<void> };

/**
 * The frozen public shapes of the two render functions (design 1.5). They are STRUCTURAL mirrors of
 * the host contract, not imports from it: `@taujs/solid` carries no runtime `@taujs/server`
 * dependency, so a standalone consumer stays host-free. `contract.test-d.ts` (acceptance leg 7.5)
 * proves the IMPLEMENTATION's inferred output satisfies the host contract with zero casts - these
 * aliases are for consumers, and are deliberately not used to annotate the implementation.
 */
export type RenderSSRFn = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: RenderOptions,
) => Promise<{ headContent: string; appHtml: string }>;

export type RenderStreamFn = (
  sink: Writable,
  callbacks: RenderCallbacks,
  initialData: InitialDataInput,
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: RenderOptions,
) => RenderStreamHandle;

export type StreamOptions = {
  /** Bound on shell readiness (default 10_000). */
  shellTimeoutMs?: number;
  /** Bound on the WHOLE renderStream lifecycle (default 30_000). Every terminal clears it. */
  completionTimeoutMs?: number;
};

export type SSROptions = {
  /** Bound on the `ssr` strategy's single render promise (default 10_000). */
  prerenderTimeoutMs?: number;
};

const NOOP = () => {};

/**
 * Design 4 (R1). `shouldHydrate` is the host-RESOLVED policy (`attr.hydrate !== false`), delivered
 * symmetrically on both paths in `RenderOptions`. The renderer EXECUTES that policy and never
 * infers another one - in particular it never derives hydration intent from `bootstrapModules`.
 *
 * An older host that omits the field is treated as hydrating, which is the historical behaviour.
 */
const resolveShouldHydrate = (opts?: RenderOptions): boolean => opts?.shouldHydrate !== false;

/**
 * Solid's hydration bootstrap, nonced. This defines `_$HY`, which Solid's emitted resource and
 * `$df` patch scripts REFERENCE but never define, and which the client `hydrate()` dereferences
 * unguarded (`solid-js/web/dist/web.js:350`). It is returned through the adapter's existing
 * `headContent` result - there is no new public option, no nonce field on `HeadContext` and no
 * host document context.
 */
/*
 * `solid-js/web` has TWO declaration files: the SERVER one takes `{ nonce?, eventNames? }`
 * (`web/types/server.d.ts:67`), the CLIENT one takes no arguments (`web/types/client.d.ts:84`).
 * Under this package's tsconfig the CLIENT types resolve, while the runtime here is unambiguously
 * the SERVER build. This single narrowly-scoped alias states the signature that is actually
 * executed - verified against the pinned tuple, which emits `<script nonce="...">` for the nonced
 * form. It is the ONLY cast in this module and it exists to fix a types/runtime mismatch, not to
 * paper over a shape the runtime does not have.
 */
const generateHydrationScriptServer = generateHydrationScript as unknown as (options?: { nonce?: string; eventNames?: string[] }) => string;

const hydrationBootstrap = (cspNonce?: string): string =>
  cspNonce ? generateHydrationScriptServer({ nonce: cspNonce }) : generateHydrationScriptServer();

/** The host client entry, for the STREAMING path only (on `ssr` the host emits it itself). */
const clientEntryScript = (src: string, cspNonce?: string): string =>
  `<script type="module" src="${escapeHtml(src)}"${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''} async></script>`;

/**
 * Normalise the host's `initialData` into the store's `T | Promise<T>` seed.
 *
 * The lazy thunk is invoked EXACTLY ONCE, here, inside the caller's guarded path - and a
 * SYNCHRONOUS throw from it propagates, which the caller turns into a pre-shell fatal (design 1.5).
 */
function normaliseInitialData(initialData: InitialDataInput): Record<string, unknown> | Promise<Record<string, unknown>> {
  return typeof initialData === 'function' ? initialData() : initialData;
}

export function createRenderer<
  T extends Record<string, unknown> = Record<string, unknown>,
  R = unknown,
  H extends Record<string, unknown> = Record<string, unknown>,
>({
  appComponent,
  headContent,
  renderId,
  streamOptions = {},
  ssrOptions = {},
  logger,
}: {
  appComponent: (props: { location: string; routeContext?: R }) => JSX.Element;
  headContent: (ctx: HeadContext<T, R, H>) => string;
  renderId?: string;
  streamOptions?: StreamOptions;
  ssrOptions?: SSROptions;
  logger?: SolidLogger;
}) {
  const { shellTimeoutMs = 10_000, completionTimeoutMs = 30_000 } = streamOptions;
  const { prerenderTimeoutMs = 10_000 } = ssrOptions;

  // Validate ONCE, at the factory. `startTimer` arms only for finite positive values, so without
  // this every invalid input (-1, NaN, null, a string from untyped JS) silently became "no bound"
  // - the watchdog quietly disabled, which is the opposite of what a timeout option means. Only
  // `0` and `Infinity` are documented sentinels for that.
  const assertTimeout = (value: number, name: string): void => {
    const ok = value === 0 || value === Infinity || (typeof value === 'number' && Number.isFinite(value) && value > 0);
    if (!ok) {
      throw new TypeError(`createRenderer: ${name} must be a positive finite number of milliseconds, 0, or Infinity (received ${String(value)})`);
    }
  };
  assertTimeout(shellTimeoutMs, 'streamOptions.shellTimeoutMs');
  assertTimeout(completionTimeoutMs, 'streamOptions.completionTimeoutMs');
  assertTimeout(prerenderTimeoutMs, 'ssrOptions.prerenderTimeoutMs');

  // ---------------------------------------------------------------------------------------------
  // renderSSR - the `ssr` strategy. A SINGLE promise; deliberately no stream vocabulary (INDEX
  // conventions rule 5). The host resolves route data BEFORE calling this.
  // ---------------------------------------------------------------------------------------------
  const renderSSR = async (
    initialDataResolved: Record<string, unknown>,
    location: string,
    meta: Record<string, unknown> = {},
    signal?: AbortSignal,
    opts?: RenderOptions,
  ): Promise<{ headContent: string; appHtml: string }> => {
    const { log, warn } = createUILogger(opts?.logger ?? logger, { debugCategory: 'ssr', context: { scope: 'solid-ssr' } });
    const routeContext = opts?.routeContext as R | undefined;

    if (signal?.aborted) {
      warn('SSR skipped; already aborted');

      return { headContent: '', appHtml: '' };
    }

    // The T/H narrowing seam for this strategy: the contract-facing parameters are BROAD so a
    // renderer instantiated with non-default generics stays assignable to the host contract under
    // strictFunctionTypes; route-config inference is the type authority, as for the body data.
    const store = createSSRStore<Record<string, unknown>>(initialDataResolved);
    const shouldHydrate = resolveShouldHydrate(opts);
    const cspNonce = opts?.cspNonce;

    // Design 4, cells 1-2. `ssr + true`: Solid's bootstrap goes out exactly once through
    // headContent, and `nonce` is passed to the render so Solid's own resource scripts are nonced.
    // `ssr + false`: `noScripts: true` on the fully resolved string path - the output is static
    // markup with no `$R`, `_$HY` or `$df` at all. That is why the bootstrap is unnecessary there,
    // and it is also why the SSR path must never emit orphaned `_$HY.r` writes.
    //
    // `noScripts` is correct HERE and forbidden for streaming, where it would suppress the
    // deferred patches the response depends on.
    const head = headContent({ data: initialDataResolved as T, headData: opts?.headData as H | undefined, meta, routeContext }) +
      (shouldHydrate ? hydrationBootstrap(cspNonce) : '');

    // M1: the SSR single-promise path uses the SAME holder design as streaming. Its timeout is a
    // retention class of its own (S0-B2 R-C), so detachment must happen on every exit - including
    // a mid-render abort, which is the case that previously leaked.
    let settled = false;
    let removeAbortListener = () => {};
    const detach = () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      detachStore(store);
    };

    try {
      // B1 exp01, pinned by a store test: a SYNCHRONOUS render throw escapes `renderToStringAsync`
      // BEFORE a promise exists. So this must be inside try/catch, not merely `.catch`-ed.
      const rendered = renderToStringAsync(
        () => provideSSRStore(store, () => appComponent({ location, routeContext })),
        // The sanitiser is installed FIRST and is non-disableable (design 5). Under
        // `noScripts` nothing is serialised at all, but it is still installed - the policy is not
        // conditional on the hydration cell.
        (shouldHydrate
          ? { renderId, nonce: cspNonce, plugins: [SanitisedErrorPlugin] }
          : { renderId, noScripts: true, plugins: [SanitisedErrorPlugin] }) as never,
      ) as Promise<string>;

      // Solid exposes no way to cancel an in-flight render, so an abandoned one runs to completion
      // (or never settles). Pre-observe it: without this, a render that eventually REJECTS after we
      // have already returned raises an `unhandledRejection` - a process exit under Node's default
      // mode. Detachment is what bounds the abandoned render's cost: the root may outlive the
      // response, but it holds no τjs state.
      rendered.catch(() => {});

      const timeoutError = new Error(`Solid SSR render exceeded prerenderTimeoutMs (${prerenderTimeoutMs}ms)`);
      let stopTimer = () => {};
      const deadline = new Promise<never>((_, reject) => {
        stopTimer = startTimer(prerenderTimeoutMs, () => reject(timeoutError));
      });

      // Race the caller's signal too. Checking `signal.aborted` only before and after the render
      // left an abort DURING a never-settling render waiting for the prerender deadline, holding
      // the request and the holder for up to `prerenderTimeoutMs`.
      const ABORTED = Symbol('aborted');
      const abortRace = new Promise<typeof ABORTED>((resolve) => {
        if (!signal) return;
        const onAbort = () => resolve(ABORTED);
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {}
        };
      });

      let outcome: string | typeof ABORTED;
      try {
        outcome = await Promise.race([rendered, deadline, abortRace]);
      } finally {
        stopTimer();
      }

      if (outcome === ABORTED || signal?.aborted) {
        warn('SSR aborted by caller');

        // `detach()` runs in the `finally` below - promptly, not at the prerender deadline.
        return { headContent: '', appHtml: '' };
      }

      log('Completed SSR');

      return { headContent: head, appHtml: outcome };
    } finally {
      detach();
    }
  };

  // ---------------------------------------------------------------------------------------------
  // renderStream - the `streaming` strategy.
  // ---------------------------------------------------------------------------------------------
  const renderStream = (
    sink: Writable,
    callbacks: RenderCallbacks<T> = {},
    initialData: InitialDataInput,
    location: string,
    bootstrapModules?: string,
    meta: Record<string, unknown> = {},
    signal?: AbortSignal,
    opts?: RenderOptions,
  ): RenderStreamHandle => {
    const cb = {
      onHead: callbacks.onHead ?? NOOP,
      onShellReady: callbacks.onShellReady ?? NOOP,
      onAllReady: (callbacks.onAllReady ?? NOOP) as (data: T) => void,
      onError: callbacks.onError ?? NOOP,
    };
    const { log, warn, error } = createUILogger(opts?.logger ?? logger, { debugCategory: 'ssr', context: { scope: 'solid-streaming' } });
    const routeContext = opts?.routeContext as R | undefined;
    const shouldHydrate = resolveShouldHydrate(opts);
    const cspNonce = opts?.cspNonce;

    const controller = createStreamController(sink, { log, warn, error });

    /**
     * The single fatal site. Claims the terminal FIRST, then runs the host's isolated `onError`:
     * the host callback may synchronously abort the very AbortSignal wired to `benignAbort`, and a
     * re-entrant benign abort arriving first would win the one-shot controller and RESOLVE `done`,
     * silently downgrading a fatal and violating the handle contract.
     */
    const failFatal = (err: unknown) => {
      if (controller.terminated) return;
      controller.fatalAbort(err);
      try {
        cb.onError(err);
      } catch (cbErr) {
        warn('onError callback threw', cbErr);
      }
    };

    // Completion watchdog: bounds the WHOLE lifecycle, including the exactly-once lazy thunk and
    // post-shell no-end. Every terminal clears it (registered as controller cleanup).
    const stopCompletionTimer = startTimer(completionTimeoutMs, () => {
      if (controller.terminated) return;
      failFatal(
        new Error(
          controller.shellCommitted
            ? `Solid stream did not complete within completionTimeoutMs (${completionTimeoutMs}ms); shell was committed, so the document is incomplete`
            : `Solid stream did not reach shell within completionTimeoutMs (${completionTimeoutMs}ms)`,
        ),
      );
    });
    controller.addCleanup(stopCompletionTimer);

    // The shell timer is NOT armed here. The ruled contract (design 2) starts it "immediately
    // before the Solid render begins", and the completion timer bounds the WHOLE lifecycle
    // INCLUDING route-data resolution. Arming it here would charge a slow loader against the shell
    // budget and report a data stall as a shell stall - two different faults with two different
    // operator responses. It is armed in `runRender` instead.
    let stopShellTimer = () => {};
    controller.addCleanup(() => stopShellTimer());

    const { cleanup: guardsCleanup } = wireWritableGuards(sink, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => failFatal(err),
    });
    controller.addCleanup(guardsCleanup);

    if (signal) {
      const onAbort = () => controller.benignAbort('AbortSignal triggered; cancelling Solid stream');
      if (signal.aborted) {
        controller.benignAbort('AbortSignal already aborted before render');

        return { abort: NOOP, done: controller.done };
      }
      signal.addEventListener('abort', onAbort, { once: true });
      controller.addCleanup(() => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      });
    }

    // --- store construction. The lazy thunk runs EXACTLY ONCE, here, and a synchronous throw is a
    // pre-shell fatal (design 1.5).
    let store: ReturnType<typeof createSSRStore<Record<string, unknown>>>;
    try {
      store = createSSRStore<Record<string, unknown>>(normaliseInitialData(initialData));
    } catch (thunkThrow) {
      failFatal(thunkThrow);

      return { abort: NOOP, done: controller.done };
    }
    // M1: every terminal releases τjs-owned request state, exactly once (the controller enforces
    // the once-ness across all terminal kinds).
    controller.setDetach(() => detachStore(store));

    const readiness = getStoreReadiness(store) ?? Promise.resolve();

    // --- two-latch `onAllReady` (design 2, binding: ESC-0 C3 CONFIRMED). Route-data-ready AND
    // Solid-completed, then exactly once. A fatal incomplete delivery calls NEITHER latch, so it
    // never seeds a truncated document.
    let dataReady = false;
    let solidCompleted = false;
    let allReadyFired = false;

    const tryFireAllReady = () => {
      if (allReadyFired || controller.terminated) return;
      if (!dataReady || !solidCompleted) return;

      const state = getStoreState(store);
      // A rejected route load is a PRE-shell fatal owned by the gate below; it must never seed.
      if (state?.status !== 'success') return;

      allReadyFired = true;
      try {
        cb.onAllReady(store.data() as T);
      } catch (cbErr) {
        // Matrix row #9: advisory-callback throws are ISOLATED; the response still completes.
        error('onAllReady callback threw', cbErr);
      }
    };

    void readiness.then(() => {
      dataReady = true;
      tryFireAllReady();
    });

    // --- the delegating sink. Solid calls write/end on this; the terminal guard makes both
    // no-ops after a terminal so a late Solid settlement resumes nothing (RFC 0006:330).
    let endRequested = false;
    const facade = {
      write: (chunk: unknown): boolean => {
        if (controller.terminated) return true;

        try {
          return sink.write(chunk as Uint8Array);
        } catch (writeErr) {
          // A SYNCHRONOUS write failure is render-origin by construction (Solid is mid-render and
          // called us). Matrix #7a: never benign by shape. Without this it escapes into Solid's
          // internals, where there is no handler - the response then hangs until a watchdog fires
          // instead of failing immediately.
          failFatal(writeErr);

          return true;
        }
      },
      end: () => {
        if (controller.terminated || endRequested) return;
        endRequested = true;

        // Solid has finished. Defer the real `end()` until route data has settled so the host's
        // finish listener serialises the authoritative value rather than `{}`.
        void readiness.then(() => {
          if (controller.terminated) return;

          const state = getStoreState(store);
          if (state?.status !== 'success') {
            failFatal(state?.error ?? new Error('Solid stream: route data unavailable at completion'));

            return;
          }

          try {
            // The host has ALREADY gated `bootstrapModules` on its own `shouldHydrate`
            // (HandleRender.ts:663 passes `undefined` when false). Re-checking the ruled policy
            // here is deliberate defence in depth, not a second source of truth: the renderer
            // executes the host-resolved policy and must not emit a client entry the policy
            // forbids, whichever way the host wired it.
            if (shouldHydrate && bootstrapModules) sink.write(clientEntryScript(bootstrapModules, cspNonce));
          } catch (bootstrapErr) {
            failFatal(bootstrapErr);

            return;
          }

          try {
            if (!sink.writableEnded && !sink.destroyed) sink.end();
          } catch (endErr) {
            failFatal(endErr);

            return;
          }
          controller.complete('Solid stream completed');
        });
      },
      destroy: (err?: unknown) => {
        // Terminal-guarded like every other adapter-owned sink op: after a terminal the controller
        // already owns the sink's fate, and a late Solid-initiated destroy must resume nothing.
        if (controller.terminated) return facade;
        try {
          sink.destroy(err as Error | undefined);
        } catch {}

        return facade;
      },
      on: (event: string, handler: (...args: unknown[]) => void) => (sink.on(event, handler), facade),
      once: (event: string, handler: (...args: unknown[]) => void) => (sink.once(event, handler), facade),
      removeListener: (event: string, handler: (...args: unknown[]) => void) => (sink.removeListener(event, handler), facade),
      emit: (event: string, ...args: unknown[]) => sink.emit(event, ...args),
      get destroyed() {
        return sink.destroyed;
      },
      get writable() {
        return sink.writable;
      },
    };

    const runRender = () => {
      const state = getStoreState(store);
      if (state?.status !== 'success') {
        // Snapshot bridge: route-data rejection is a PRE-SHELL FATAL, never a post-shell `{}` seed
        // (design 3; C2 correction).
        failFatal(state?.error ?? new Error('Solid stream: route data failed before render'));

        return;
      }

      // The head is COMPUTED here (route data is committed by now), but deliberately NOT emitted
      // here. In the real host `onHead` writes the 200 response head and connects the stream, so
      // calling it before the render would commit a 200 for a response that may still fail
      // pre-shell - a synchronous root throw, or an R3 serialisation failure that fires before
      // `onCompleteShell`, would both arrive with the response already committed. It is invoked
      // from `onCompleteShell` below, immediately BEFORE the shell is marked committed.
      // Design 4, cells 3-4. BOTH streaming cells retain Solid's bootstrap and its resource/patch
      // scripts, all nonced: under `hydrate:false` the deferred `$df` patches still need `_$HY`, so
      // suppressing them would break the response itself. What `hydrate:false` removes is the HOST
      // CLIENT ENTRY - so application hydration never runs, and its beacon is therefore absent.
      // `noScripts` is deliberately NEVER used on this path.
      let head: string;
      try {
        head =
          headContent({ data: store.data() as T, headData: opts?.headData as H | undefined, meta, routeContext }) + hydrationBootstrap(cspNonce);
      } catch (headErr) {
        failFatal(headErr);

        return;
      }

      // Design 2: "the shell timer starts immediately before the Solid render begins".
      stopShellTimer = startTimer(shellTimeoutMs, () => {
        if (controller.terminated || controller.shellCommitted) return;
        failFatal(new Error(`Solid shell not ready after ${shellTimeoutMs}ms`));
      });

      let stream: { pipe: (destination: unknown) => void };
      try {
        // `renderToStream(...).pipe(w)` DIRECTLY - never `pipeToNodeWritable`/`pipeToWritable`
        // with `onReady`, which OVERWRITE a caller-supplied `onCompleteShell`
        // (solid-js/web/dist/server.js:693,709) and would silently break the shell latch below.
        stream = renderToStream(() => provideSSRStore(store, () => appComponent({ location, routeContext })), {
          renderId,
          nonce: cspNonce,
          // FIRST in the chain, non-disableable (design 5). Solid prepends custom plugins
          // (web/dist/server.js:151), so this pre-empts seroval's built-in Error node.
          plugins: [SanitisedErrorPlugin],
          onCompleteShell() {
            if (controller.terminated) return;
            stopShellTimer();

            // onHead is operationally REQUIRED: it commits the response head and connects the
            // sink. A throwing onHead is FATAL (matrix row #8) and must leave the shell UNMARKED,
            // so the fatal teardown still treats this as pre-shell and never claims a committed
            // document.
            try {
              cb.onHead(head);
            } catch (headErr) {
              failFatal(headErr);

              return;
            }

            controller.markShellCommitted();

            try {
              cb.onShellReady();
            } catch (cbErr) {
              // Matrix row #9: isolated. Solid itself does NOT isolate these (B1 exp09b), so the
              // adapter must, or a throw here becomes an unhandledRejection and the stream hangs.
              error('onShellReady callback threw', cbErr);
            }
          },
          onCompleteAll() {
            if (controller.terminated) return;
            solidCompleted = true;
            tryFireAllReady();
          },
          /**
           * R3: seroval's SERIALISATION FAILURE channel. This is NOT a successfully serialised
           * resource rejection (#5/#6, which is unobservable degraded completion) - it means the
           * payload cannot be completed safely, so it is FATAL infrastructure/delivery failure.
           * Pre-shell: never commit. Post-shell: destroy the sink, never `end()`, never claim
           * completed delivery. The controller enforces both and settles exactly once.
           */
          onError(serialisationError: unknown) {
            if (controller.terminated) return;
            failFatal(serialisationError);
          },
        } as never) as never;
      } catch (renderThrow) {
        // Matrix row #1: a synchronous root throw precedes any handle.
        failFatal(renderThrow);

        return;
      }

      stream.pipe(facade);
    };

    // Snapshot bridge: the adapter must hold the RESOLVED route value before rendering, so the
    // whole render is gated on readiness. The documented consequence is that a route-data stall
    // blocks shell emission entirely - bounded by the shell and completion watchdogs above.
    void readiness.then(() => {
      if (controller.terminated) return;
      try {
        runRender();
      } catch (outer) {
        failFatal(outer);
      }
    });

    return {
      abort: () => controller.benignAbort('Manual abort'),
      done: controller.done,
    };
  };

  // Renderer v1: the identity brand goes on BOTH functions (function-level, so it survives the
  // scaffold's `export const { renderSSR, renderStream } = createRenderer(...)` destructure).
  return brandRenderFunctions({ renderSSR, renderStream }, SOLID_RENDERER_KEY);
}
