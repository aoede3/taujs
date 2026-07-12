import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createUILogger } from './utils/Logger';

import type { LoggerLike } from './utils/Logger';

// Dev-only introspection hook, set by the server-injected dev script (never by users).
// Absent in production: emission costs one property check and can never throw into
// hydration. User callbacks always run, unchanged, after the internal emission.
type TaujsDevtoolsHook = { emit?: (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown) => void };

const emitDevHook = (event: 'hydration:start' | 'hydration:success' | 'hydration:error', payload?: unknown): void => {
  try {
    const hook = (window as { __TAUJS_DEVTOOLS_HOOK__?: TaujsDevtoolsHook }).__TAUJS_DEVTOOLS_HOOK__;
    hook?.emit?.(event, payload);
  } catch {
    // the beacon must never affect hydration
  }
};

// Re-surface an uncaught error on the GLOBAL error channel (window.onerror /
// addEventListener('error')) that overriding React's `onUncaughtError` otherwise suppresses. Mirrors
// React's own `reportGlobalError`: prefer `globalThis.reportError`, else dispatch a cancelable window
// `ErrorEvent` — so `window.onerror`-based monitoring (Sentry/Bugsnag globalHandlers) still fires on
// runtimes/older browsers that do NOT expose `reportError` (a plain `reportError?.()` is a silent
// no-op there). The caller already logs via the taujs logger, so there is no console fallback here.
// Node `uncaughtException` re-emission is intentionally omitted: this module is browser-only. Never
// throws into hydration.
const surfaceGlobalUncaughtError = (err: unknown): void => {
  try {
    const g = globalThis as { reportError?: (e: unknown) => void };
    if (typeof g.reportError === 'function') {
      g.reportError(err);

      return;
    }

    if (typeof window !== 'undefined' && typeof ErrorEvent === 'function' && typeof window.dispatchEvent === 'function') {
      let message = 'Uncaught render error';
      try {
        if (err instanceof Error && typeof err.message === 'string') message = err.message;
      } catch {
        // hostile message getter — keep the generic message
      }
      window.dispatchEvent(new ErrorEvent('error', { error: err, message, cancelable: true }));
    }
  } catch {
    // global surfacing must never affect hydration
  }
};

// React 19 root error-info shapes (narrowed from @types/react-dom). Descriptive only.
type RootErrorInfo = { componentStack?: string };

/**
 * Options for {@link hydrateApp}.
 *
 * Lifecycle signals (R2-01):
 * - `onStart` — fires once when hydration BEGINS (hydrate path only; paired with the
 *   `hydration:start` dev beacon, internal-first). NOT fired on the CSR-fallback path.
 * - `onSuccess` — fires once on the FIRST ROOT COMMIT (a component effect, not `hydrateRoot`'s
 *   return). It proves the root committed; it does NOT claim every `<Suspense>` boundary hydrated.
 *   On the hydrate path it is paired with the `hydration:success` beacon (internal-first); on the
 *   CSR-fallback path it fires WITHOUT any beacon (a CSR mount is not a hydration — vue parity).
 * - `onHydrationError` — fires once for a bootstrap failure: an UNCAUGHT client render error
 *   (React's async `onUncaughtError` — a throwing component with no error boundary), a synchronous
 *   setup/invalid-container throw, or a missing root element. On the hydrate path it is paired with
 *   the `hydration:error` beacon; on the CSR path it fires WITHOUT a beacon.
 *
 * Single settlement: EXACTLY ONE of `onSuccess` | `onHydrationError` fires per `hydrateApp` call.
 * Whichever event happens first (first commit vs first uncaught error) wins; any later signal is
 * telemetry — logged only, never re-fired. Errors handled by an app error boundary
 * (`onCaughtError`) and auto-recovered mismatches (`onRecoverableError`, e.g. server/client HTML
 * mismatch) are NOT bootstrap failures — they are logged (`error`/`warn`) and never settle.
 */
export type HydrateAppOptions<T> = {
  appComponent: React.ReactElement;
  rootElementId?: string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  dataKey?: string;
  onHydrationError?: (err: unknown) => void;
  onStart?: () => void;
  onSuccess?: () => void;
};

// Internal reporter (design 2): a pass-through WRAPPER around the app (renders `children`, adds no
// DOM) whose mount effect fires once after the first root commit, so a committed root is provable on
// both the hydrate and CSR paths. StrictMode double-invokes effects in dev — the single-settlement
// flag in the parent makes the repeated `onCommit` a no-op after the first.
//
// It MUST wrap the app, not sit beside it (R2-04). React's `useId` is tree-position sensitive: a
// SIBLING of the app shifts every `useId` in the app (verified against react-dom 19.2), so the
// original sibling reporter made the client tree's ids diverge from the SSR markup (which renders the
// app without it) — a hydration mismatch for any app using `useId`. A pass-through wrapper adds tree
// DEPTH only, which `useId` ignores, so the app's ids are identical to the server render.
const CommitReporter = ({ onCommit, children }: React.PropsWithChildren<{ onCommit: () => void }>): React.ReactNode => {
  React.useEffect(() => {
    onCommit();
  }, [onCommit]);

  return children;
};

export function hydrateApp<T>({
  appComponent,
  rootElementId = 'root',
  enableDebug = false,
  logger,
  dataKey = '__INITIAL_DATA__',
  onHydrationError,
  onStart,
  onSuccess,
}: HydrateAppOptions<T>) {
  const { log, warn, error } = createUILogger(logger, { debugCategory: 'ssr', context: { scope: 'react-hydration' }, enableDebug });

  // User lifecycle callbacks are ADVISORY observers — every one is isolated here. This is not mere
  // defensiveness: `onSuccess` runs INSIDE the reporter's React effect and `onHydrationError` runs
  // inside our root `onUncaughtError` handler. An un-isolated throw from either becomes an exception
  // in React's root-error domain — a throwing `onSuccess` would be routed to our OWN `onUncaughtError`,
  // mis-classified as post-settlement telemetry (success already won), WHILE React tears the committed
  // root down. An observability hook must never destroy the root it observes, escape the adapter, or
  // alter settlement. A throw is logged only. (`emitDevHook` is already self-isolating.)
  const runObserver = (label: string, run: () => void) => {
    try {
      run();
    } catch (cbErr) {
      error(`Hydration ${label} callback threw (ignored):`, cbErr);
    }
  };

  // Beacon policy (path-scoped): the hydrate path emits `hydration:*` beacons; the CSR-fallback path
  // emits NONE (a CSR mount is not a hydration — vue parity). Set once when the path is chosen, and
  // read by the SINGLE report pair below — so one adapter object serves both roots.
  let emitBeacons = false;

  // Single-settlement (design 3): exactly one of success | failure, event-driven (first commit vs
  // first uncaught error). Later signals are runtime telemetry — log-only.
  let settled = false;

  const reportSuccess = () => {
    if (settled) return;
    settled = true;
    if (enableDebug) log('Hydration succeeded (first root commit)');
    if (emitBeacons) emitDevHook('hydration:success');
    runObserver('onSuccess', () => onSuccess?.());
  };

  const reportFailure = (err: unknown) => {
    if (settled) {
      // Post-settlement runtime error: telemetry only (stricter than vue's errored-guard — a
      // deliberate choice recorded in decisions.md as a vue backport candidate).
      error('Post-hydration error (telemetry, not a bootstrap failure):', err);

      return;
    }
    settled = true;
    if (emitBeacons) emitDevHook('hydration:error', err);
    runObserver('onHydrationError', () => onHydrationError?.(err));
  };

  // ONE root-error adapter (design 1), the SAME object passed to whichever root is created
  // (hydrateRoot or createRoot). All client render errors route through the single `reportFailure`.
  const rootErrorOptions = {
    onUncaughtError: (err: unknown, info: RootErrorInfo) => {
      // A render error with no error boundary. React surfaces this ASYNCHRONOUSLY (not as a throw
      // from hydrateRoot/createRoot), so a sync try/catch cannot see it; this is the real client
      // error channel.
      error('Uncaught render error:', err, info);
      // Overriding onUncaughtError REPLACES React's default for the root's ENTIRE lifetime — and its
      // default re-surfaces uncaught errors globally. Without restoring that, post-hydration uncaught
      // render/commit/effect errors (no boundary) would be hidden from window.onerror-based monitoring
      // (Sentry/Bugsnag globalHandlers) — a net observability REGRESSION. Re-surface it (mirroring
      // React's reportGlobalError, incl. the ErrorEvent fallback) on top of taujs's routing below.
      surfaceGlobalUncaughtError(err);
      reportFailure(err);
    },
    onCaughtError: (err: unknown, info: RootErrorInfo) => {
      // Handled by an app error boundary — the app chose how to render it; NOT a bootstrap failure.
      error('Error handled by an app error boundary:', err, info);
    },
    onRecoverableError: (err: unknown, info: RootErrorInfo) => {
      // Auto-recovered (e.g. server/client HTML mismatch → client re-render). A warning, never a
      // failure — do NOT classify a mismatch as a hydration failure.
      warn('Recoverable hydration error:', err, info);
    },
  };

  // The tree React renders. The commit reporter WRAPS the app (adds tree depth only, no DOM and no
  // `useId` shift — see CommitReporter); its effect calls the single `reportSuccess`.
  const buildTree = (store: ReturnType<typeof createSSRStore<T>>) => (
    <React.StrictMode>
      <SSRStoreProvider store={store}>
        <CommitReporter onCommit={reportSuccess}>{appComponent}</CommitReporter>
      </SSRStoreProvider>
    </React.StrictMode>
  );

  const mountCSR = (rootEl: HTMLElement, initialData: T) => {
    // emitBeacons stays false: the CSR path reports onSuccess/onHydrationError but no beacons.
    rootEl.innerHTML = '';
    const store = createSSRStore(initialData);

    try {
      const root = createRoot(rootEl, rootErrorOptions);
      root.render(buildTree(store));
    } catch (err) {
      // Sync belt: invalid container / synchronous setup throw.
      error('CSR mount error:', err);
      reportFailure(err);
    }
  };

  const startHydration = (rootEl: HTMLElement, initialData: T) => {
    emitBeacons = true; // hydrate path: emit hydration:start/success/error beacons

    if (enableDebug) log('Hydration started');
    emitDevHook('hydration:start');
    runObserver('onStart', () => onStart?.());

    if (enableDebug) log('Initial data loaded:', initialData);

    const store = createSSRStore(initialData);
    if (enableDebug) log('Store created:', store);

    try {
      hydrateRoot(rootEl, buildTree(store), rootErrorOptions);
    } catch (err) {
      // Sync belt: invalid container / synchronous setup throw (async render errors arrive via
      // onUncaughtError above, not here).
      error('Hydration error:', err);
      reportFailure(err);
    }
  };

  const bootstrap = () => {
    const rootEl = document.getElementById(rootElementId);
    if (!rootEl) {
      // R5 (design 4): a missing root IS a bootstrap failure. Route it through the same single
      // failure path — the beacon emits an error without a preceding `start` (vue precedent).
      emitBeacons = true;
      error(`Root element with id "${rootElementId}" not found.`);
      reportFailure(new Error(`Root element with id "${rootElementId}" not found.`));

      return;
    }

    const data = (window as any)[dataKey] as T | undefined;

    if (data === undefined) {
      const csrData = {} as T;
      if (enableDebug) warn(`No initial SSR data at window["${dataKey}"]. Mounting CSR.`);
      mountCSR(rootEl, csrData);

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
