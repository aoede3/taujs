import { defineConfig } from '@taujs/server/config';
import { vueRenderer } from '@taujs/vue/renderer';

import { serviceData } from './src/server/services/registry.ts';

// The Vue twin of fixtures/playground-react: one bootable app that exercises @taujs/vue end to end
// against the workspace package (no publish needed). `/` is ssr, `/streaming` is streaming SSR;
// both hydrate. vueRenderer is the load-bearing difference — it supplies pluginVue, which Vue
// SFCs need in dev and build.
export default defineConfig({
  server: {
    port: 5273,
    host: 'localhost',
    hmrPort: 5274,
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
      ],
    },
  ],
});
