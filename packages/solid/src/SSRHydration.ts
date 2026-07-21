import { hydrate, render } from 'solid-js/web';

import { createSSRStore, provideSSRStore } from './SSRDataStore.js';
import { createUILogger } from './utils/Logger.js';

import type { JSX } from 'solid-js';
import type { SolidLogger } from './utils/Logger.js';

/**
 * Client-side bootstrap for a τjs Solid app, and its hydration-observability surface.
 *
 * The lifecycle callbacks are ADVISORY observers of one `hydrateApp` invocation:
 * - `onStart` fires once when application hydration begins (hydrate path only), after the
 *   `hydration:start` beacon and before the native `hydrate`.
 * - `onSuccess` fires once when the framework establishes the application root - a successful return
 *   from Solid's `hydrate(...)` on the hydrate path, or `render(...)` on the CSR-fallback path. It
 *   does NOT mean every resource or `<Suspense>` boundary settled.
 * - `onHydrationError` fires once for a failed root establishment (a synchronous hydrate/render
 *   throw, or a missing root element).
 *
 * Exactly one of `onSuccess` | `onHydrationError` settles per invocation; each fires at most once.
 * The internal τjs hydration beacons are hydration-only and always precede the corresponding user
 * observer.
 */
export type HydrateAppOptions = {
  app: (props: { location: string }) => JSX.Element;
  /**
   * Must match the `renderId` the SERVER rendered this root with - it is the shared deterministic
   * namespace for Solid's markers and serialised data (design 4). A mismatch means the client
   * cannot find the server's markers.
   */
  renderId?: string;
  rootElementId?: string;
  /** Receives hydration lifecycle logs. A Pino/server-shaped or UI-shaped logger; see `SolidLogger`. */
  logger?: SolidLogger;
  /** Gate verbose start/success/CSR lifecycle logs. Warnings and errors are never gated. Default `false`. */
  enableDebug?: boolean;
  /** Observes the start of application hydration (hydrate path only). */
  onStart?: () => void;
  /** Observes successful root establishment (hydrate or CSR). */
  onSuccess?: () => void;
  /** Observes a failed root establishment. */
  onHydrationError?: (error: unknown) => void;
};

/** The dev-only introspection beacon, set by the server-injected dev script and never by users. */
type TaujsDevtoolsHook = { emit?: (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown) => void };

const emitBeacon = (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown): void => {
  try {
    (window as { __TAUJS_DEVTOOLS_HOOK__?: TaujsDevtoolsHook }).__TAUJS_DEVTOOLS_HOOK__?.emit?.(event, payload);
  } catch {
    // the beacon must never affect hydration
  }
};

export function hydrateApp({
  app,
  renderId,
  rootElementId = 'root',
  logger,
  enableDebug = false,
  onStart,
  onSuccess,
  onHydrationError,
}: HydrateAppOptions): void {
  // `logger ?? console`: with no supplied logger, warnings/errors fall back to `console.warn`/
  // `console.error` (parity with @taujs/react and @taujs/vue), while verbose lifecycle logging stays
  // gated by `enableDebug`. This only shapes the client hydration seam - `createUILogger`'s
  // server-path defaults are unchanged.
  const { log, error } = createUILogger(logger ?? console, { debugCategory: 'ssr', context: { scope: 'solid-hydration' }, enableDebug });

  // Advisory observer isolation: a callback throw is logged and swallowed - it is never fed to
  // `onHydrationError`, never manufactures a beacon, and never tears down the root it observes.
  const runObserver = (label: string, run: () => void) => {
    try {
      run();
    } catch (cbErr) {
      error(`Hydration ${label} callback threw (ignored):`, cbErr);
    }
  };

  // Beacon policy: the hydrate path emits `hydration:*` beacons; the CSR-fallback path emits none (a
  // CSR mount is not a hydration). Set once when the path is chosen, read by the report helpers.
  let emitBeacons = false;

  // Single settlement: exactly one of `onSuccess` | `onHydrationError`, each at most once. Solid's
  // `hydrate`/`render` return synchronously, so success is reported inline after the native call -
  // but the guard is explicit so a later edit cannot produce success followed by failure. `onStart`
  // is hydration-only and, running once per invocation, fires at most once.
  let settled = false;

  // Verbose lifecycle logs (`log`) are gated by `enableDebug` inside `createUILogger`; warnings and
  // errors are never gated. There is one gate, in the logger adapter - the calls here are
  // unconditional so gating cannot drift between the two.
  const reportStart = () => {
    log('Hydration started');
    if (emitBeacons) emitBeacon('hydration:start');
    runObserver('onStart', () => onStart?.());
  };

  const reportSuccess = (message: string) => {
    if (settled) return;
    settled = true;
    log(message);
    if (emitBeacons) emitBeacon('hydration:success');
    runObserver('onSuccess', () => onSuccess?.());
  };

  const reportFailure = (message: string, err: unknown) => {
    if (settled) return;
    settled = true;
    error(message, err);
    if (emitBeacons) emitBeacon('hydration:error', err);
    runObserver('onHydrationError', () => onHydrationError?.(err));
  };

  const bootstrap = () => {
    const rootElement = document.getElementById(rootElementId);

    if (!rootElement) {
      // A missing root is a bootstrap failure: emit an error beacon with no preceding `start`, and
      // report through the single failure path (design 4 / react + vue precedent).
      emitBeacons = true;
      reportFailure(`taujs: root element with id "${rootElementId}" not found`, new Error(`taujs: root element with id "${rootElementId}" not found`));

      return;
    }

    const initialData = (window as { __INITIAL_DATA__?: Record<string, unknown> }).__INITIAL_DATA__;
    const location = window.location.pathname + window.location.search;

    // Missing initial data falls back to CSR (design 4): a CSR mount is NOT a hydration, so it emits
    // no beacon and no `onStart`. A successful CSR root establishment still reports `onSuccess`; a
    // failed one reports `onHydrationError`.
    if (initialData === undefined) {
      log('No initial SSR data; mounting CSR');

      try {
        rootElement.innerHTML = '';
        const store = createSSRStore<Record<string, unknown>>({});
        render(() => provideSSRStore(store, () => app({ location })), rootElement);
        reportSuccess('CSR mount succeeded');
      } catch (err) {
        reportFailure('CSR mount failed', err);
      }

      return;
    }

    // Hydration path. On the pinned Solid runtime `hydrate(...)` establishes the root synchronously
    // and returns, so a successful return is an honest "root established" signal (design 2). Internal
    // first: the `start` beacon precedes `onStart`, and the `success` beacon precedes `onSuccess`.
    emitBeacons = true;
    reportStart();

    try {
      const store = createSSRStore(initialData);
      hydrate(() => provideSSRStore(store, () => app({ location })), rootElement, renderId ? { renderId } : undefined);
      reportSuccess('Hydration succeeded');
    } catch (err) {
      // A hydration failure reports and STOPS. It deliberately does NOT silently remount as CSR
      // (design 4): a silent remount hides a real server/client divergence behind a page that looks
      // fine, and destroys the server-rendered markup that would have shown the mismatch.
      reportFailure('Hydration failed', err);
    }
  };

  if (document.readyState !== 'loading') bootstrap();
  else document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
}
