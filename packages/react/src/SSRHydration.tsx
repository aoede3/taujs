import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createUILogger } from './utils/Logger';

import type { LoggerLike } from './utils/Logger';

export type HydrateAppOptions<T> = {
  appComponent: React.ReactElement;
  rootElementId?: string;
  debug?: boolean;
  logger?: LoggerLike;
  dataKey?: string;
  onHydrationError?: (err: unknown) => void;
  onStart?: () => void;
  onSuccess?: () => void;
};

export function hydrateApp<T>({
  appComponent,
  rootElementId = 'root',
  debug = false,
  logger,
  dataKey = '__INITIAL_DATA__',
  onHydrationError,
  onStart,
  onSuccess,
}: HydrateAppOptions<T>) {
  const { log, warn, error } = createUILogger(logger, { debugCategory: 'ssr', context: { scope: 'react-hydration' } });

  const mountCSR = (rootEl: HTMLElement) => {
    rootEl.innerHTML = '';
    const root = createRoot(rootEl);
    root.render(<React.StrictMode>{appComponent}</React.StrictMode>);
  };

  const startHydration = (rootEl: HTMLElement, initialData: T) => {
    if (debug) log('Hydration started');
    onStart?.();

    if (debug) log('Initial data loaded:', initialData);

    const store = createSSRStore(initialData);
    if (debug) log('Store created:', store);

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
      if (debug) log('Hydration completed');
      onSuccess?.();
    } catch (err) {
      error('Hydration error:', err);
      onHydrationError?.(err);
      warn('Falling back to SPA rendering.');
      mountCSR(rootEl);
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
      if (debug) warn(`No initial SSR data at window["${dataKey}"]. Mounting CSR.`);
      mountCSR(rootEl);

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
