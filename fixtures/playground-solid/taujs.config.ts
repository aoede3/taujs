import { defineConfig } from '@taujs/server/config';
import { solidRenderer } from '@taujs/solid/renderer';

import { serviceData } from './src/server/services/registry.ts';

// The Solid twin of fixtures/playground: one bootable app exercising @taujs/solid end to end
// against the workspace package (no publish needed). `/` is ssr, `/streaming` is streaming SSR;
// both hydrate.
//
// `solidRenderer` supplies the managed vite-plugin-solid internally with `ssr: true` FORCED - the
// app never lists the plugin itself. `project` points at a DISJOINT tsconfig that claims only the
// client TSX, so the compiler never claims the server tree.
export default defineConfig({
  server: {
    port: 5373,
    host: 'localhost',
    hmrPort: 5374,
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
      appId: 'playground-solid',
      entryPoint: '',
      renderer: solidRenderer({ project: './tsconfig.solid.json' }),
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            hydrate: true,
            // Standard SSR: data is resolved before the first byte, so the store is already
            // committed when the component reads it - no Suspense needed for ROUTE data.
            data: serviceData('content', 'home'),
          },
        },
        {
          path: '/streaming',
          attr: {
            render: 'streaming',
            meta: {
              title: 'τjs Solid playground - streaming',
              description: 'Streaming SSR: the shell flushes, then deferred patches complete.',
            },
            hydrate: true,
            data: serviceData('content', 'streaming'),
          },
        },
        {
          path: '/streaming-no-hydrate',
          attr: {
            render: 'streaming',
            meta: { title: 'τjs Solid playground - streaming, no hydrate' },
            // Design 4, cell 4: no host client entry, so application hydration never runs - but
            // the Solid bootstrap and patch machinery are RETAINED, because the deferred `$df`
            // patches require `_$HY` to exist.
            hydrate: false,
            data: serviceData('content', 'streaming'),
          },
        },
        {
          // Browser leg: an app-owned resource REJECTS post-shell. The client must receive the
          // SANITISED error - fixed identity, no server detail - through real execution.
          path: '/reject',
          attr: {
            render: 'streaming',
            meta: { title: 'τjs Solid playground - rejected resource' },
            hydrate: true,
            data: serviceData('content', 'home'),
          },
        },
        {
          // Browser leg: route data carrying a `__proto__` key, to prove ESC-3 end to end - it must
          // arrive as an OWN property with `Object.prototype` untouched.
          path: '/proto',
          attr: {
            render: 'ssr',
            hydrate: true,
            data: serviceData('content', 'protoPayload'),
          },
        },
        {
          path: '/no-hydrate',
          attr: {
            render: 'ssr',
            // Design 4, cell 2: static markup only. No host client entry, and `noScripts` means no
            // `$R`, `_$HY` or `$df` in the renderer output either.
            hydrate: false,
            data: serviceData('content', 'home'),
          },
        },
      ],
    },
  ],
});
