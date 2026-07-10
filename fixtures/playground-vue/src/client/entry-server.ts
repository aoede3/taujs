import { createRenderer } from '@taujs/vue';

import App from './App.vue';
import { setupApp } from './setup-app';

export const { renderSSR, renderStream } = createRenderer({
  appComponent: App,
  headContent: ({ meta }) => `
    <title>${(meta as { title?: string } | undefined)?.title ?? 'τjs Vue playground'}</title>
  `,
  setupApp,
  enableDebug: process.env.NODE_ENV === 'development',
});
