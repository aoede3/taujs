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
