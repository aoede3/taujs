import { hydrateApp } from '@taujs/vue';

import App from './App.vue';
import { setupApp } from './setup-app';

hydrateApp({
  appComponent: App,
  rootElementId: 'root',
  setupApp,
  enableDebug: import.meta.env.DEV,
});
