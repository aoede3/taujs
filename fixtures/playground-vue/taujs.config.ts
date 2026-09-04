import { defineConfig } from '@taujs/server/config';
import { vueRenderer } from '@taujs/vue/renderer';

import { deferredRoute } from './src/server/routes/deferred.ts';
import { serviceData } from './src/server/services/registry.ts';

// The Vue twin of fixtures/playground-react: one bootable app that exercises @taujs/vue end to end
// against the workspace package (no publish needed). `/` is ssr, `/streaming` is streaming SSR;
// both hydrate. vueRenderer is the load-bearing difference — it supplies pluginVue, which Vue
// SFCs need in dev and build.
export default defineConfig({
  server: {
    // The real-browser suite boots this fixture on its own port (5302) so it never collides with a
    // developer's dev server; everything else keeps the fixture's stable default.
    port: Number(process.env.TAUJS_PORT ?? 5273),
    host: 'localhost',
    hmrPort: 5274,
  },
  // An ENFORCED CSP (not report-only), so the browser acceptance runs against a real policy rather
  // than merely observing nonce attributes. `script-src` carries no 'unsafe-inline', so any inline
  // script the renderer emits WITHOUT the request nonce is blocked by the browser and raises a
  // securitypolicyviolation - which is exactly what the browser suite asserts never happens.
  security: {
    csp: {
      directives: {
        'default-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
      },
    },
  },
  apps: [
    {
      appId: 'playground-vue',
      entryPoint: '',
      renderer: vueRenderer(),
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            // Standard SSR: data resolved on the server before first byte; the fallback
            // idiom (useSSRData + v-if) reads it synchronously once present.
            data: serviceData('content', 'home'),
          },
        },
        {
          path: '/streaming',
          attr: {
            render: 'streaming',
            meta: {
              title: 'τjs Vue playground — streaming',
              description: 'Streaming SSR route: async setup blocks under <Suspense> until the data resolves.',
            },
            // Streaming: the blocking idiom (await useSSRDataAsync) delivers the resolved
            // data into the payload (V1-07 R1).
            data: serviceData('content', 'greet', () => ({ name: 'Vue' })),
            // RFC 0004: dynamic head data, resolved BEFORE the head is built (streamed pages get
            // real <head> data; attr.meta stays the static fallback layer).
            head: { data: serviceData('content', 'greetHead', () => ({ name: 'Vue' })) },
          },
        },
        // RFC 0007: the deferred example route, declared in `src/server/routes/deferred.ts` so the
        // client can name its inferred payload type (`DeferredDataOf<typeof deferredRoute>`).
        deferredRoute,
      ],
    },
  ],
});
