import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { createSSRStore, SSRStoreProvider } from '@taujs/server/data-store';

import AppBootstrap from './AppBootstrap';

const bootstrap = () => {
  const initialDataPromise = Promise.resolve(window.__INITIAL_DATA__);
  const store = createSSRStore(initialDataPromise);

  hydrateRoot(
    document.getElementById('root') as HTMLElement,
    <SSRStoreProvider store={store}>
      <AppBootstrap />
    </SSRStoreProvider>,
  );
};

if (document.readyState !== 'loading') {
  bootstrap();
} else {
  document.addEventListener('DOMContentLoaded', () => bootstrap());
}
