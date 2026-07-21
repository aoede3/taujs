import { hydrateApp } from '@taujs/solid';

import { App } from './App';
import { RENDER_ID } from './renderId';

hydrateApp({
  app: ({ location }) => <App location={location} />,
  renderId: RENDER_ID,
  rootElementId: 'root',
  onHydrationError: (error) => {
    console.error('[playground-solid] hydration failed:', error);
  },
});
