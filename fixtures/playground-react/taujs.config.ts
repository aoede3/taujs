import { defineConfig } from '@taujs/server/config';
import { reactRenderer } from '@taujs/react/renderer';

import { deferredRoute } from './src/server/routes/deferred.ts';
import { serviceData } from './src/server/services/registry.ts';

// Every route exists to exercise a specific part of the introspection substrate — see
// README.md. Deliberately NO wildcard route: fallthrough must stay reachable
// (/spa/anything is the SPA-path example).
export default defineConfig({
  server: {
    // The real-browser suite boots this fixture on its own port (5301) so it never collides with a
    // developer's dev server; everything else keeps the fixture's stable default.
    port: Number(process.env.TAUJS_PORT ?? 5173),
    host: 'localhost',
    hmrPort: 5174,
  },
  // An ENFORCED CSP (not report-only), so the browser acceptance runs against a real policy rather
  // than merely observing nonce attributes. `script-src` carries no 'unsafe-inline', so any inline
  // script the renderer emits WITHOUT the request nonce is blocked by the browser and raises a
  // securitypolicyviolation - which is exactly what the browser suite asserts never happens.
  security: {
    csp: {
      defaultMode: 'merge',
      directives: {
        'default-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
      },
    },
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
        // RFC 0007: the deferred example route, declared in `src/server/routes/deferred.ts` so the
        // client can name its inferred payload type (`DeferredDataOf<typeof deferredRoute>`).
        deferredRoute,
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
