import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';
import { createLogger } from './utils/Logger';

type HydrateAppOptions = {
  appComponent: React.ReactElement;
  initialDataKey?: keyof Window;
  rootElementId?: string;
  debug?: boolean;
};

export const hydrateApp = ({ appComponent, initialDataKey = '__INITIAL_DATA__', rootElementId = 'root', debug = false }: HydrateAppOptions) => {
  const { log, warn, error } = createLogger(debug);

  const bootstrap = () => {
    log('Hydration started');

    const rootElement = document.getElementById(rootElementId);
    if (!rootElement) {
      error(`Root element with id "${rootElementId}" not found.`);
      return;
    }

    const initialData = window[initialDataKey];

    if (!initialData) {
      warn(`Initial data key "${initialDataKey}" is undefined on window. Defaulting to SPA createRoot`);
      const root = createRoot(rootElement);

      root.render(<React.StrictMode>{appComponent}</React.StrictMode>);
    } else {
      log('Initial data loaded:', initialData);
      const initialDataPromise = Promise.resolve(initialData);
      const store = createSSRStore(initialDataPromise);
      log('Store created:', store);

      hydrateRoot(
        rootElement,
        <React.StrictMode>
          <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>
        </React.StrictMode>,
      );

      log('Hydration completed');
    }
  };

  if (document.readyState !== 'loading') {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap);
  }
};
