import { createApp, createSSRApp, h, nextTick, type App, type Component, type VNode } from 'vue';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore.js';
import { createUILogger, createVueErrorHandler } from './utils/Logger.js';

import type { LoggerLike } from './utils/Logger.js';

// Dev-only introspection hook, set by the server-injected dev script (never by users).
// Absent in production: emission costs one property check and can never throw into
// hydration. User callbacks always run, unchanged, after the internal emission. Ported
// verbatim from @taujs/react's SSRHydration (P0B-04) — same event names, same guard.
type TaujsDevtoolsHook = { emit?: (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown) => void };

const emitDevHook = (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown): void => {
  try {
    const hook = (window as { __TAUJS_DEVTOOLS_HOOK__?: TaujsDevtoolsHook }).__TAUJS_DEVTOOLS_HOOK__;
    hook?.emit?.(event, payload);
  } catch {
    // the beacon must never affect hydration
  }
};

export type HydrateAppOptions<T> = {
  /** Root app component. */
  appComponent: Component | (() => VNode);
  rootElementId?: string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  dataKey?: string;
  onHydrationError?: (err: unknown) => void;
  /**
   * Configure the client `App` before mount (`app.use`, directives, provides). Pass the
   * SAME function used for `createRenderer`'s `setupApp` so Pinia/vue-i18n/etc. attach
   * identically on server and client. Synchronous, no `window`/DOM access, idempotent per
   * app instance; a throw is routed to `onHydrationError` (plus a `hydration:error` beacon
   * on the hydrate path — the CSR-fallback path emits no beacon events).
   */
  setupApp?: (app: App) => void;
  /** Receives the `App` instance (divergence from react, whose callbacks take no args). */
  onStart?: (app: App) => void;
  /** Receives the `App` instance (divergence from react, whose callbacks take no args). */
  onSuccess?: (app: App) => void;
};

/**
 * Vue client bootstrap. Contract-parity with taujs/react, with documented Vue-native
 * divergences:
 * - If window[dataKey] is missing, mount CSR (and clear existing DOM) — no hydration
 *   events are emitted (a CSR mount is not a hydration).
 * - Otherwise, hydrate SSR markup, emitting `hydration:start|success|error` to the
 *   dev-only `window.__TAUJS_DEVTOOLS_HOOK__` around the user callbacks.
 *
 * Both frameworks surface client render failures ASYNCHRONOUSLY, not as throws from the
 * mount/hydrate call (React via the root's `onUncaughtError`, established and tested in R2-01;
 * Vue via `app.config.errorHandler` plus recoverable warnings) — so this installs an error
 * handler before mount and treats errors during the hydration phase as hydration failures.
 * `onStart`/`onSuccess` receive the `App` instance (react's take no args). All user callbacks are
 * advisory and isolated: a throw is logged, never altering settlement or preventing mount.
 */
export function hydrateApp<T>({
  appComponent,
  rootElementId = 'root',
  enableDebug = false,
  logger,
  dataKey = '__INITIAL_DATA__',
  onHydrationError,
  onStart,
  onSuccess,
  setupApp,
}: HydrateAppOptions<T>) {
  const { log, warn, error } = createUILogger(logger, {
    debugCategory: 'ssr',
    context: { scope: 'vue-hydration' },
    enableDebug,
  });

  // User lifecycle callbacks are ADVISORY observers - every one is isolated here (hardening-lessons
  // §1). This is load-bearing, not defensive: `onStart`/`onSuccess` run inside the hydration
  // try/catch, and `onHydrationError` runs from Vue's errorHandler / a catch block. Un-isolated, an
  // observer throw would (a) be misread as a hydration failure - a throwing `onStart` would emit
  // `hydration:error` and PREVENT `app.mount`, (b) manufacture an error AFTER success - a throwing
  // `onSuccess` would emit `hydration:error` for an attempt that already emitted
  // `hydration:success`, or (c) escape `hydrateApp` entirely from inside a catch block. An observer
  // must never alter settlement, stop the app mounting, or escape the framework boundary; a throw is
  // logged only, and is NEVER fed back into `reportHydrationFailure`.
  const runObserver = (label: string, run: () => void) => {
    try {
      run();
    } catch (cbErr) {
      error(`${label} callback threw (ignored):`, cbErr);
    }
  };

  const normalizeRoot = (): Component => {
    // Allow passing either a component or a render function.
    if (typeof appComponent === 'function' && !(appComponent as any).setup && !(appComponent as any).render) {
      return { name: 'TauJsRoot', render: appComponent as any };
    }
    return appComponent as Component;
  };

  const mountCSR = (rootEl: HTMLElement, initialData: T) => {
    rootEl.innerHTML = '';

    const store = createSSRStore(initialData);

    const app = createApp({
      name: 'TauJsCSR',
      render: () => h(SSRStoreProvider, { store }, { default: () => h(normalizeRoot()) }),
    });

    try {
      // Same setupApp runs on the CSR path so it works whether the client hydrates or falls
      // back to CSR.
      setupApp?.(app);
      app.mount(rootEl);
    } catch (err) {
      // R2: a throwing setupApp/mount is an application error — route to onHydrationError
      // (the only client error channel). The CSR path emits NO beacon events: a CSR mount is
      // not a hydration, and react's CSR path emits nothing either. Isolated: this runs inside a
      // catch block, so an un-isolated observer throw would escape hydrateApp.
      error('CSR mount error:', err);
      runObserver('onHydrationError', () => onHydrationError?.(err));
    }
  };

  const startHydration = (rootEl: HTMLElement, initialData: T) => {
    if (enableDebug) log('Hydration started');
    if (enableDebug) log('Initial data loaded:', initialData);

    const store = createSSRStore(initialData);
    if (enableDebug) log('Store created:', store);

    // "Hydration phase": the window during which an error is attributable to hydration.
    // It ends on the first post-mount tick, so ordinary runtime errors afterwards are
    // logged only, not reported as hydration failures. `errored` guards against the
    // double-emit that would otherwise happen when app.config.errorHandler fires DURING a
    // mount() that still returns normally (Vue swallows a handled error) — once we've
    // emitted hydration:error we must suppress hydration:success. Known limitation: an
    // async/<Suspense> error completing after the first tick is misclassified as post-phase.
    let inHydrationPhase = true;
    let errored = false;
    const vueErrLog = createVueErrorHandler(logger, enableDebug);

    const reportHydrationFailure = (err: unknown) => {
      if (!inHydrationPhase || errored) return;
      errored = true;
      emitDevHook('hydration:error', err);
      // Isolated: this runs from Vue's app.config.errorHandler and from the outer catch, where an
      // un-isolated observer throw would escape hydrateApp.
      runObserver('onHydrationError', () => onHydrationError?.(err));
    };

    try {
      const app = createSSRApp({
        name: 'TauJsHydration',
        render: () => h(SSRStoreProvider, { store }, { default: () => h(normalizeRoot()) }),
      });

      // R4: configure the app (setupApp) before notifying, so onStart/onSuccess and the
      // mount all see a fully-configured app. A throw here is caught below and routed to
      // reportHydrationFailure (it fires before emitDevHook('hydration:start'), so a setupApp
      // failure emits hydration:error without a preceding start — hydration never began).
      setupApp?.(app);

      // Install BEFORE mount (Vue surfaces hydration problems here, not as throws). R3: chain
      // after any handler a user installed in setupApp (Sentry etc.) so τjs's routing always
      // runs and the user's still observes.
      const userErrorHandler = app.config.errorHandler;
      app.config.errorHandler = (err, instance, info) => {
        try {
          userErrorHandler?.(err, instance, info);
        } catch {}
        vueErrLog(err, instance, info);
        reportHydrationFailure(err);
      };

      // Debug-only: forward Vue warnings (hydration mismatches surface as warnings) to the
      // logger. Log-only — do NOT auto-classify a mismatch warning as a hydration failure.
      if (enableDebug) {
        app.config.warnHandler = (msg, _instance, trace) => {
          warn('Vue warning during hydration:', { msg, trace });
        };
      }

      // Beacon then user callback (internal-first), onStart receiving the configured App. Isolated:
      // an un-isolated throw would hit the outer catch, be misreported as a hydration failure, and
      // PREVENT app.mount below - an advisory observer must never stop the app hydrating.
      emitDevHook('hydration:start');
      runObserver('onStart', () => onStart?.(app));

      // createSSRApp(...).mount() hydrates by default; no non-public second argument (F11).
      app.mount(rootEl);

      if (!errored) {
        if (enableDebug) log('Hydration completed');
        emitDevHook('hydration:success');
        // Isolated: an un-isolated throw would hit the outer catch and emit hydration:error +
        // onHydrationError for an attempt that has ALREADY emitted hydration:success.
        runObserver('onSuccess', () => onSuccess?.(app));
      }

      // Close the hydration phase after the current tick.
      void nextTick(() => {
        inHydrationPhase = false;
      });
    } catch (err) {
      // Synchronous mount throw — route through the same single-fire failure path.
      error('Hydration error:', err);
      reportHydrationFailure(err);
    }
  };

  const bootstrap = () => {
    const rootEl = document.getElementById(rootElementId);
    if (!rootEl) {
      // R2-03 (R5): a missing root is a bootstrap failure — report it through the client error
      // channel, mirroring react's R2-01. Emits `hydration:error` WITHOUT a preceding `start` (vue
      // precedent: a setupApp failure emits the same way; hydration never began). This case precedes
      // the phase/`errored` machinery, so it is reported directly rather than routed through it.
      // `onHydrationError` is isolated (hardening-lessons §1): a throwing observer must not escape
      // bootstrap() (which may run directly on a non-loading document).
      error(`Root element with id "${rootElementId}" not found.`);
      const err = new Error(`Root element with id "${rootElementId}" not found.`);
      emitDevHook('hydration:error', err);
      runObserver('onHydrationError', () => onHydrationError?.(err));

      return;
    }

    const data = (window as any)[dataKey] as T | undefined;

    if (data === undefined) {
      const empty = {} as T;
      if (enableDebug) warn(`No initial SSR data at window["${dataKey}"]. Mounting CSR.`);
      mountCSR(rootEl, empty);
      return;
    }

    startHydration(rootEl, data);
  };

  if (document.readyState !== 'loading') {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
}
