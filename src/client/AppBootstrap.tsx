import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';

import { App } from '@client/App';
import ErrorBoundary from '@client/utils/ErrorBoundary';

type AppBootstrapProps = {
  location?: string;
};

const AppBootstrap: React.FC<AppBootstrapProps> = ({ location = '/' }) => {
  const isServer = typeof window === 'undefined';

  return (
    <React.StrictMode>
      <ErrorBoundary>
        {isServer ? (
          <StaticRouter location={location}>
            <App />
          </StaticRouter>
        ) : (
          <BrowserRouter>
            <App />
          </BrowserRouter>
        )}
      </ErrorBoundary>
    </React.StrictMode>
  );
};

export default AppBootstrap;
