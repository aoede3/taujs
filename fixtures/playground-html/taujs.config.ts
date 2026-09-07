import { defineConfig } from '@taujs/server/config';
import { htmlRenderer } from '@taujs/html/renderer';

import { deferredNoHydrateRoute, deferredRoute } from './src/server/routes/deferred.ts';
import { serviceData } from './src/server/services/registry.ts';

// The framework-free twin of fixtures/playground-vue: one bootable app that exercises @taujs/html end
// to end against the workspace package (no publish needed). `htmlRenderer()` is the load-bearing
// difference - it declares the neutral HTML render module the host validates the entry-server's
// createRenderer(...) output against; there is no compiler and no Vite plugin to supply.
export default defineConfig({
  server: {
    // The test suite allocates FREE ports and binds 127.0.0.1 (lesson recorded in
    // packages/create-taujs/src/test/lifecycle.test.ts's header), so these are fallbacks only for a
    // manual `npm run dev`/`npm run start`.
    port: Number(process.env.TAUJS_PORT ?? 5275),
    host: '127.0.0.1',
    hmrPort: Number(process.env.TAUJS_HMR_PORT ?? 5276),
  },
  apps: [
    {
      appId: 'playground-html',
      entryPoint: '',
      renderer: htmlRenderer(),
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            data: serviceData('content', 'home'),
          },
        },
        {
          path: '/streaming',
          attr: {
            render: 'streaming',
            meta: {
              title: 'τjs HTML playground - streaming',
              description: 'Streaming SSR route with no component framework.',
            },
            data: serviceData('content', 'greet', () => ({ name: 'HTML' })),
          },
        },
        deferredRoute,
        deferredNoHydrateRoute,
      ],
    },
  ],
});
