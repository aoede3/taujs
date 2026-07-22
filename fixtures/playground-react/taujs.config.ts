import { defineConfig } from '@taujs/server/config';
import { reactRenderer } from '@taujs/react/renderer';

import { serviceData } from './src/server/services/registry.ts';

// Every route exists to exercise a specific part of the introspection substrate — see
// README.md. Deliberately NO wildcard route: fallthrough must stay reachable
// (/spa/anything is the SPA-path example).
export default defineConfig({
  server: {
    port: 5173,
    host: 'localhost',
    hmrPort: 5174,
  },
  apps: [
    {
      appId: 'playground-react',
      entryPoint: '',
      // React app: the client (src/client/**) compiles under the root tsconfig.json (jsx: react-jsx).
      renderer: reactRenderer({ project: './tsconfig.json' }),
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            // Declared edge, mapper omitted: content.home accepts the broad params shape.
            data: serviceData('content', 'home'),
          },
        },
        {
          path: '/product/:id',
          attr: {
            render: 'streaming',
            meta: {
              title: 'τjs playground — product',
              description: 'Streaming route with a declared service edge; /product/999 fails deterministically.',
            },
            // The killer-demo route: declared edge with a narrowing mapper.
            data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })),
            // RFC 0004: dynamic head data, resolved BEFORE the shell (streamed pages get real
            // <head> data; attr.meta stays the static fallback layer).
            head: { data: serviceData('catalog', 'getProductHead', (p) => ({ id: String(p.id) })) },
          },
        },
        {
          path: '/legacy',
          attr: {
            render: 'ssr',
            // Closure-style handler: target unknowable statically → data.kind 'dynamic'.
            data: async () => ({ legacy: true, note: 'hand-written data handler' }),
          },
        },
        {
          path: '/terms',
          attr: {
            render: 'ssr',
            hydrate: false,
          },
        },
        {
          path: '/admin',
          attr: {
            render: 'ssr',
            middleware: {
              auth: { roles: ['admin'] },
            },
          },
        },
      ],
    },
  ],
});
