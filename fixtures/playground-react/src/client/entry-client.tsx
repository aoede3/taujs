import { hydrateApp } from '@taujs/react';
import { App } from './App';

hydrateApp({
  // The server rendered with the request path; hydrate with the SAME location so the deferred
  // boundary is in the tree on both sides.
  appComponent: <App location={window.location.pathname} />,
  rootElementId: 'root',
  enableDebug: import.meta.env.DEV,
});
