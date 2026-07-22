import { hydrateApp } from '@taujs/react';
import { App } from './App';

hydrateApp({
  appComponent: <App />,
  rootElementId: 'root',
  enableDebug: import.meta.env.DEV,
});
