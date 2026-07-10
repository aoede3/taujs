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

  const mountCSR = (rootEl: HTMLElement, initialData: T) => {
    rootEl.innerHTML = '';
    const store = createSSRStore(initialData);
    const root = createRoot(rootEl);

    root.render(
      <React.StrictMode>
        <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>
      </React.StrictMode>,
    );
  };

  const startHydration = (rootEl: HTMLElement, initialData: T) => {
    if (enableDebug) log('Hydration started');
    emitDevHook('hydration:start');
    onStart?.();

    if (enableDebug) log('Initial data loaded:', initialData);

    const store = createSSRStore(initialData);
    if (enableDebug) log('Store created:', store);

    try {
      hydrateRoot(
        rootEl,
        <React.StrictMode>
          <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>
        </React.StrictMode>,
        {
          onRecoverableError: (err, info) => {
            warn('Recoverable hydration error:', err, info);
          },
        },
      );
      if (enableDebug) log('Hydration completed');
      emitDevHook('hydration:success');
      onSuccess?.();
    } catch (err) {
      error('Hydration error:', err);
      emitDevHook('hydration:error', err);
      onHydrationError?.(err);
    }
  };

  const bootstrap = () => {
    const rootEl = document.getElementById(rootElementId);
    if (!rootEl) {
      error(`Root element with id "${rootElementId}" not found.`);

      return;
    }

    const data = (window as any)[dataKey] as T | undefined;

    if (data === undefined) {
      const data = {} as T;
      if (enableDebug) warn(`No initial SSR data at window["${dataKey}"]. Mounting CSR.`);
      mountCSR(rootEl, data);

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
