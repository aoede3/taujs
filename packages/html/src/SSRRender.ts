/**
 * `@taujs/html` - the framework-free HTML renderer. `createRenderer({ render? })` returns
 * `{ renderSSR, renderStream }`, the same shape every τjs renderer produces, so diagnostics and the
 * scaffold need no special case.
 *
 * Streaming machinery (`createStreamController`, `wireWritableGuards`, `startShellTimer`,
 * `assertTimeout`) is copied from `packages/vue/src/utils/Streaming.ts`; the shell/deferred-timeout
 * shapes, the terminal-guard discipline and the streaming bootstrap tag are pattern-parity with
 * `packages/vue/src/SSRRender.ts` at `73f2867`, adapted to a renderer with no component tree: there is
 * no store, no app instance and no framework Suspense - the critical data is a plain object handed to
 * `render`, and deferred data is observed as bare promise settlement rather than projected onto a
 * framework primitive.
 *
 * `render` is entirely optional (the zero-config form): when absent both fragments are `''` and the
 * template owns the whole document, exactly the framework-free shell case this package exists for.
 * `@taujs/html` supplies NO templating and NO escaping helper for `render`'s own output - only the
 * module-local `escapeHtml` this file uses for its OWN attribute writing (the bootstrap tag). The
 * application owns its HTML safety.
 */
import type { Writable } from 'node:stream';

import { brandRenderFunctions, HTML_RENDERER_KEY } from './renderContract.js';
import { assertTimeout, createStreamController, startShellTimer, wireWritableGuards } from './utils/Streaming.js';
import { escapeHtml } from './utils/Html.js';
import { createUILogger } from './utils/Logger.js';

import type { LoggerLike } from './utils/Logger.js';

/** The two raw HTML fragments `render` may produce. Both are written to the response VERBATIM. */
export type HtmlFragments = { headContent?: string; appHtml?: string };

/** The context `render` is invoked with, once per `renderSSR`/`renderStream` call. */
export type RenderContext<T, R = unknown, H = Record<string, unknown>> = {
  /** The resolved critical route data. */
  data: T;
  /** The request target the host passed (path + query). */
  location: string;
  /** `attr.meta`, `{}` when the route declares none. */
  meta: Record<string, unknown>;
  /** `opts.routeContext` from the host. */
  routeContext?: R;
  /** `opts.headData` from the host, absent when the route declares no head. */
  headData?: H;
  /** The host's request signal. */
  signal?: AbortSignal;
};

export type StreamOptions = { shellTimeoutMs?: number; deferredTimeoutMs?: number };

export type HtmlRendererOptions<T, R, H> = {
  /**
   * Returns raw `{ headContent, appHtml }` HTML, written to the response VERBATIM - neither field is
   * auto-escaped. Any value derived from request data or services must be escaped by the application
   * before it is interpolated; `@taujs/html` provides no escaping helper. May be sync or async;
   * called exactly once per `renderSSR`/`renderStream` call, after the critical data has resolved.
   * Omit it to let the template own the whole document (both fragments become `''`).
   */
  render?: (ctx: RenderContext<T, R, H>) => HtmlFragments | Promise<HtmlFragments>;
  logger?: LoggerLike;
  enableDebug?: boolean;
  streamOptions?: StreamOptions;
};

/** Internal: broad at the boundary (the host stores heterogeneous render modules), narrowed at the two call sites below. */
type RenderOptionsBag = {
  logger?: LoggerLike;
  routeContext?: unknown;
  headData?: Record<string, unknown>;
  cspNonce?: string;
  shouldHydrate?: boolean;
};

/** Internal: the streaming call bag additionally carries the host's deferred-data registry and a per-call shell-timeout override. `deferredTimeoutMs` is FACTORY-ONLY, so it is not part of this bag. */
type StreamCallOptionsBag = RenderOptionsBag & {
  shellTimeoutMs?: number;
  deferredData?: Readonly<Record<string, Promise<Record<string, unknown>>>>;
};

/** Internal: the render-module callback bag `renderStream` is invoked with. */
type RenderCallbacks<T> = {
  onHead?: (headContent: string) => void;
  onShellReady?: () => void;
  onAllReady?: (data: T) => void;
  onError?: (err: unknown) => void;
};

type RenderStreamHandle = { abort(): void; done: Promise<void> };

/** Internal: matches the host's `RenderSSR` (`packages/server/src/types.ts:194-207`). */
type RenderSSR = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: RenderOptionsBag,
) => Promise<{ headContent: string; appHtml: string; aborted: boolean }>;

/** Internal: matches the host's `RenderStream` (`packages/server/src/types.ts:228-242`). */
type RenderStream = (
  sink: Writable,
  callbacks: RenderCallbacks<unknown>,
  initialData: Record<string, unknown> | Promise<Record<string, unknown>> | (() => Promise<Record<string, unknown>>),
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: StreamCallOptionsBag,
) => RenderStreamHandle;

const NOOP = () => {};

/** Vue's precedent (`SSRRender.ts:123`): the deferred deadline's default, and the cap on any derivation of it. */
const DEFERRED_TIMEOUT_DEFAULT_MS = 15_000;

/** Same idiom as `packages/renderer-conformance/shellTimeout.ts`'s `describeValue`: strings QUOTED, everything else `String()`. */
const describeValue = (value: unknown): string => (typeof value === 'string' ? `'${value}'` : String(value));

const renderResultError = (received: unknown): TypeError =>
  new TypeError(`createRenderer: render() must return { headContent?: string, appHtml?: string } (received ${describeValue(received)})`);

/** Validate + normalise a `render()` result: `undefined` fields become `''`; anything else is a `TypeError`. */
function normaliseRenderResult(result: unknown): { headContent: string; appHtml: string } {
  if (typeof result !== 'object' || result === null) throw renderResultError(result);

  const { headContent, appHtml } = result as Record<string, unknown>;
  if (headContent !== undefined && typeof headContent !== 'string') throw renderResultError(result);
  if (appHtml !== undefined && typeof appHtml !== 'string') throw renderResultError(result);

  return { headContent: headContent ?? '', appHtml: appHtml ?? '' };
}

/**
 * Create the τjs HTML renderer: `{ renderSSR, renderStream }`. Both functions are branded with
 * `key: 'html', contractVersion: 'v1'` (survives the entry-server's destructure) so the host can
 * validate them against the app's `renderer: htmlRenderer()` declaration.
 */
export function createRenderer<T extends Record<string, unknown> = Record<string, unknown>, R = unknown, H = Record<string, unknown>>(
  options: HtmlRendererOptions<T, R, H> = {},
): { renderSSR: RenderSSR; renderStream: RenderStream } {
  const { render, logger, enableDebug = false, streamOptions = {} } = options;
  const { shellTimeoutMs = 10_000, deferredTimeoutMs = DEFERRED_TIMEOUT_DEFAULT_MS } = streamOptions;

  // Conformance vector `packages/renderer-conformance/shellTimeout.ts`: validated at the FACTORY,
  // same rule, same message text, as @taujs/react, @taujs/vue and @taujs/solid.
  assertTimeout(shellTimeoutMs, 'streamOptions.shellTimeoutMs');

  // No sentinel: this deadline is what keeps "bounded total response time" true for a renderer whose
  // deferred delivery has no other backstop (service calls carry no automatic deadline).
  if (!(typeof deferredTimeoutMs === 'number' && Number.isFinite(deferredTimeoutMs) && deferredTimeoutMs > 0)) {
    throw new TypeError(
      `createRenderer: streamOptions.deferredTimeoutMs must be a positive finite number of milliseconds (received ${String(deferredTimeoutMs)})`,
    );
  }

  const renderSSR: RenderSSR = async (initialData, location, meta = {}, signal, opts) => {
    if (signal?.aborted) {
      return { headContent: '', appHtml: '', aborted: true };
    }

    let aborted = false;
    const onAbort = () => (aborted = true);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (!render) {
        return { headContent: '', appHtml: '', aborted };
      }

      const ctx: RenderContext<T, R, H> = {
        data: initialData as T,
        location,
        meta,
        routeContext: opts?.routeContext as R | undefined,
        headData: opts?.headData as H | undefined,
        signal,
      };

      const result = await render(ctx);
      const { headContent, appHtml } = normaliseRenderResult(result);

      return { headContent, appHtml, aborted };
    } finally {
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {}
    }
  };

  const renderStream: RenderStream = (writable, callbacks, initialData, location, bootstrapModules, meta = {}, signal, opts) => {
    if (signal?.aborted) {
      return { abort: () => {}, done: Promise.resolve() };
    }

    // The deadline's time ORIGIN: measured from here, armed later at shell commitment.
    const renderStartedAt = Date.now();

    // A per-call override never passed through the factory, so it is validated HERE, named for this
    // site (parity with @taujs/vue's renderStream).
    if (opts?.shellTimeoutMs !== undefined) assertTimeout(opts.shellTimeoutMs, 'streamOptions.shellTimeoutMs', 'renderStream');
    const effectiveShellTimeout = opts?.shellTimeoutMs ?? shellTimeoutMs;

    const cspNonce = opts?.cspNonce;
    const routeContext = opts?.routeContext as R | undefined;
    const headData = opts?.headData as H | undefined;

    const cb = {
      onHead: callbacks.onHead ?? NOOP,
      onShellReady: callbacks.onShellReady ?? NOOP,
      onAllReady: callbacks.onAllReady ?? NOOP,
      onError: callbacks.onError ?? NOOP,
    };

    const { log, warn, error } = createUILogger(opts?.logger ?? logger, {
      debugCategory: 'ssr',
      context: { scope: 'html-streaming' },
      enableDebug,
    });

    const controller = createStreamController(writable, { log, warn, error });

    // The response-level deferred completion deadline (section 4.2/4.4): armed at shell commitment
    // with whatever remains of the budget, never reset per key. `deadline` resolves the moment the
    // armed timer fires; `deadlineFired` distinguishes that from the other two race branches.
    let deferredTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineFired = false;
    let resolveDeadline: () => void = () => {};
    const deadline = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    const stopDeferredDeadline = () => {
      if (deferredTimer !== undefined) clearTimeout(deferredTimer);
      deferredTimer = undefined;
    };
    const armDeferredDeadline = () => {
      if (deferredTimer !== undefined) return;

      deferredTimer = setTimeout(
        () => {
          deferredTimer = undefined;
          deadlineFired = true;
          resolveDeadline();
        },
        Math.max(deferredTimeoutMs - (Date.now() - renderStartedAt), 1),
      );
    };

    // Advisory observers are ISOLATED: a throw is logged and swallowed - it must never enter the
    // fatal path or suppress a sibling callback.
    const runObserver = (label: string, run: () => void) => {
      try {
        run();
      } catch (cbErr) {
        warn(`${label} callback threw (ignored):`, cbErr);
      }
    };

    // Single, idempotent fatal path.
    const fail = (err: unknown) => {
      if (controller.isAborted) return;
      // Ordering: claim the terminal fatal state BEFORE invoking re-entrant host code (the host's
      // onError may synchronously abort the SAME AbortSignal wired below to controller.benignAbort;
      // fatalAbort-first makes that re-entrant benignAbort a no-op).
      controller.fatalAbort(err);
      try {
        cb.onError(err);
      } catch (cbErr) {
        warn('onError callback threw:', cbErr);
      }
    };

    if (signal) {
      const handleAbortSignal = () => controller.benignAbort(`AbortSignal triggered; aborting stream for location: ${location}`);
      signal.addEventListener('abort', handleAbortSignal, { once: true });
      controller.setRemoveAbortListener(() => {
        try {
          signal.removeEventListener('abort', handleAbortSignal);
        } catch {}
      });
    }

    // Writable guards BEFORE any writes.
    const { cleanup: guardsCleanup } = wireWritableGuards(writable, {
      benignAbort: (why) => controller.benignAbort(why),
      fatalAbort: (err) => fail(err),
      onFinish: () => controller.complete('Stream finished (normal completion)'),
    });
    controller.setGuardsCleanup(() => {
      try {
        guardsCleanup();
      } catch {}
      try {
        stopDeferredDeadline();
      } catch {}
    });

    // Time-to-first-content watchdog: fires only if no content is produced before it expires.
    const stopShellTimer = startShellTimer(effectiveShellTimeout, () => {
      if (controller.isAborted) return;
      fail(new Error(`Shell timeout: no content produced within ${effectiveShellTimeout}ms for ${location}`));
    });
    controller.setStopShellTimer(stopShellTimer);

    log('Starting stream:', location);

    const run = async () => {
      try {
        // Step 6: resolve the critical data - a function is invoked and awaited; a promise is
        // awaited; anything else is used as-is.
        const resolvedData: Record<string, unknown> = await (typeof initialData === 'function' ? initialData() : initialData);
        if (controller.isAborted) return;

        // Step 7: invoke `render` once (when supplied), await, validate, normalise.
        let headContent = '';
        let appHtml = '';
        if (render) {
          const ctx: RenderContext<T, R, H> = {
            data: resolvedData as T,
            location,
            meta,
            routeContext,
            headData,
            signal,
          };
          const result = await render(ctx);
          const normalised = normaliseRenderResult(result);
          headContent = normalised.headContent;
          appHtml = normalised.appHtml;
        }
        if (controller.isAborted) return;

        // Step 8: stop the shell timer, commit the head. REQUIRED - a throw here is FATAL.
        stopShellTimer();
        try {
          cb.onHead(headContent);
        } catch (cbErr) {
          error('onHead callback threw (fatal):', cbErr);
          throw cbErr;
        }
        if (controller.isAborted) return;

        // Step 9: arm the deferred deadline, only when there is something to wait for.
        const deferredData = opts?.deferredData;
        const deferredKeys = deferredData ? Object.keys(deferredData) : [];
        const shouldWaitForDeferred = deferredKeys.length > 0 && opts?.shouldHydrate !== false;
        if (deferredKeys.length > 0 && opts?.shouldHydrate === false) {
          log('deferred data present but hydrate is false; not waiting');
        }
        if (shouldWaitForDeferred) armDeferredDeadline();

        // Step 10: advisory onShellReady, THEN write appHtml (skip the write entirely for '').
        runObserver('onShellReady', () => cb.onShellReady());
        if (controller.isAborted) return;
        if (appHtml) {
          try {
            writable.write(appHtml);
          } catch {}
        }

        // Step 11: wait for deferred settlement, the deadline, or an abort - whichever first.
        if (shouldWaitForDeferred && deferredData) {
          const pending = new Set(deferredKeys);
          let resolveAllSettled: () => void = () => {};
          const allSettled = new Promise<void>((resolve) => {
            resolveAllSettled = resolve;
          });
          if (pending.size === 0) resolveAllSettled();

          for (const key of deferredKeys) {
            const settleOne = () => {
              pending.delete(key);
              if (pending.size === 0) resolveAllSettled();
            };
            // ONE settle handler per entry, never rejecting; the registry itself is never mutated
            // and the host's own pre-observation is untouched.
            deferredData[key]!.then(settleOne, settleOne);
          }

          // Resolves the moment the controller becomes aborted, from whatever source.
          const abortedSignal = controller.done.then(
            () => undefined,
            () => undefined,
          );

          await Promise.race([allSettled, deadline, abortedSignal]);
          if (controller.isAborted) return;

          if (deadlineFired) {
            const n = pending.size;
            warn(`Deferred deadline (${deferredTimeoutMs}ms) expired with ${n} entr${n === 1 ? 'y' : 'ies'} pending for ${location}`);
          }
        }

        // Step 12: advisory onAllReady with the resolved critical data.
        runObserver('onAllReady', () => cb.onAllReady(resolvedData));
        if (controller.isAborted) return;

        // Step 13: the streaming bootstrap tag, owned by the renderer.
        if (bootstrapModules) {
          const nonceAttr = cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : '';
          try {
            writable.write(`<script type="module" src="${escapeHtml(bootstrapModules)}" async${nonceAttr}></script>`);
          } catch {}
        }

        // Step 14: end the sink. The 'finish' guard then calls controller.complete.
        try {
          writable.end();
        } catch {}
      } catch (err) {
        fail(err);
      } finally {
        // Step 15: clear the deferred timer on every exit path.
        stopDeferredDeadline();
      }
    };

    void run();

    return {
      abort: () => controller.benignAbort(`Manual abort for location: ${location}`),
      done: controller.done,
    };
  };

  return brandRenderFunctions({ renderSSR, renderStream }, HTML_RENDERER_KEY);
}
