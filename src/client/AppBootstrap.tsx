import React from 'react';

import { App } from '@client/App';
import ErrorBoundary from '@client/utils/ErrorBoundary';

const AppBootstrap = () => (
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

export default AppBootstrap;
