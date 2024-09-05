import React, { Suspense } from 'react';

import { App } from '@client/App';
import ErrorBoundary from '@client/utils/ErrorBoundary';

const AppBootstrap = () => {
  return (
    <React.StrictMode>
      <ErrorBoundary>
        <Suspense fallback={<p>Loading...</p>}>
          <App />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
};

export default AppBootstrap;
