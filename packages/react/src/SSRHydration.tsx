import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createLogger } from './utils/Logger';

import type { Logger } from './utils/Logger';

export type HydrateAppOptions<T> = {
  appComponent: React.ReactElement;
  rootElementId?: string;
  debug?: boolean;
  logger?: Partial<Logger>;
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
  const { log, warn, error } = createLogger(debug, logger);

  const startHydration = (initialData: T) => {
    log('Hydration started with initial data');

    const rootElement = document.getElementById(rootElementId);
    if (!rootElement) {
      error(`Root element with id "${rootElementId}" not found.`);
      return;
    }

    try {
      onStart?.();

      const store = createSSRStore(initialData);
      const hydratedApp = (
        <React.StrictMode>
          <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>
        </React.StrictMode>
      );

      hydrateRoot(rootElement, hydratedApp, {
        onRecoverableError: (err, info) => {
          warn('Recoverable hydration error:', err, info);
        },
        identifierPrefix: undefined,
      });

      log('Hydration completed');
      onSuccess?.();
    } catch (err) {
      error('Hydration error:', err);
      onHydrationError?.(err);
      warn('Falling back to SPA rendering.');

      rootElement.innerHTML = '';
      const root = createRoot(rootElement);
      root.render(<React.StrictMode>{appComponent}</React.StrictMode>);
    }
  };

  const bootstrap = () => {
    const maybe = (window as any)[dataKey] as T | undefined;

    if (maybe === undefined) {
      warn(`No initial SSR data found under key "${dataKey}". Waiting for server data.`);
      const onReady = () => {
        const data = (window as any)[dataKey] as T | undefined;
        if (data !== undefined) {
          window.removeEventListener('taujs:data-ready', onReady);
          startHydration(data);
        }
      };
      window.addEventListener('taujs:data-ready', onReady, { once: true });
      return;
    }

    startHydration(maybe);
  };

  if (document.readyState !== 'loading') {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
}
