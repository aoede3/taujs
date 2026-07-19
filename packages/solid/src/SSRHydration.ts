import { hydrate, render } from 'solid-js/web';

import { createSSRStore, provideSSRStore } from './SSRDataStore.js';

import type { JSX } from 'solid-js';

/**
 * Client-side bootstrap for a τjs Solid app.
 *
 * The option surface is EXACTLY the four members the design freezes (1.5) and nothing more.
 * @taujs/react's `hydrateApp` carries `logger`, `enableDebug`, `dataKey`, `onStart` and `onSuccess`;
 * every one of those is a compatibility obligation, and Solid v1 deliberately does not inherit them
 * by analogy. Adding any of them is a public-API change, not an implementation detail.
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

export function hydrateApp({ app, renderId, rootElementId = 'root', onHydrationError }: HydrateAppOptions): void {
  // Isolated: an observability callback must never destroy the root it observes.
  const reportError = (error: unknown) => {
    try {
      onHydrationError?.(error);
    } catch {
      // a throwing handler is swallowed - it cannot be allowed to escape the bootstrap
    }
  };

  const bootstrap = () => {
    const rootElement = document.getElementById(rootElementId);

    if (!rootElement) {
      const error = new Error(`taujs: root element with id "${rootElementId}" not found`);
      emitBeacon('hydration:error', error);
      reportError(error);

      return;
    }

    const initialData = (window as { __INITIAL_DATA__?: Record<string, unknown> }).__INITIAL_DATA__;
    const location = window.location.pathname + window.location.search;

    // Missing initial data falls back to CSR (design 4). A CSR mount is NOT a hydration, so it
    // emits NO beacon - the beacon fires only when application hydration actually ran, which is
    // also what keeps it absent under `shouldHydrate: false` (no client entry is emitted at all in
    // that cell, so this module never runs).
    if (initialData === undefined) {
      try {
        rootElement.innerHTML = '';
        const store = createSSRStore<Record<string, unknown>>({});
        render(() => provideSSRStore(store, () => app({ location })), rootElement);
      } catch (error) {
        reportError(error);
      }

      return;
    }

    emitBeacon('hydration:start');

    try {
      const store = createSSRStore(initialData);
      hydrate(() => provideSSRStore(store, () => app({ location })), rootElement, renderId ? { renderId } : undefined);
      emitBeacon('hydration:success');
    } catch (error) {
      // A hydration failure reports and STOPS. It deliberately does NOT silently remount as CSR
      // (design 4): a silent remount hides a real server/client divergence behind a page that
      // looks fine, and destroys the server-rendered markup that would have shown the mismatch.
      emitBeacon('hydration:error', error);
      reportError(error);
    }
  };

  if (document.readyState !== 'loading') bootstrap();
  else document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
}
