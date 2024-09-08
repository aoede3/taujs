# @taujs/server

`npm install @taujs/server`

`yarn add @taujs/server`

`pnpm add @taujs/server`

## Streaming React SSR & Hydration

Fastify Plugin for integration with taujs [ τjs ] template https://github.com/aoede3/taujs

- Production: Fastify, React
- Development: Fastify, React, tsx, Vite

TypeScript / ESM-only focus

## τjs - Developer eXperience

Integrated ViteDevServer HMR + Vite Runtime API run alongside tsx (TS eXecute) providing fast responsive dev reload times for both backend / frontend

- Fastify https://fastify.dev/
- React https://reactjs.org/
- tsx https://tsx.is/
- Vite https://vitejs.dev/guide/ssr#building-for-production

- ViteDevServer HMR https://vitejs.dev/guide/ssr#setting-up-the-dev-server
- Vite Runtime API https://vitejs.dev/guide/api-vite-runtime
- ESBuild https://esbuild.github.io/
- Rollup https://rollupjs.org/
- ESM https://nodejs.org/api/esm.html

## Development / CI

`npm install --legacy-peer-deps`

## Usage

### Fastify

```
import { SSRServer } from '@taujs/server;

void (await fastify.register(SSRServer, {
    clientEntryClient: 'entry-client',
    clientEntryServer: 'entry-server',
    clientHtmlTemplate: 'index.html',
    clientRoot: path.resolve(__dirname, '../client'),
    routes,
    serviceRegistry,
}));
```

Not utilising taujs [ τjs ] template? Add in your own `alias` object for your own particular setup e.g. `alias: { object }`

### React 'entry-client.tsx'

```
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { createSSRStore, SSRStoreProvider } from '@taujs/server/data-store';

import AppBootstrap from './AppBootstrap';

const bootstrap = () => {
  const initialDataPromise = Promise.resolve(window.__INITIAL_DATA__);
  const store = createSSRStore(initialDataPromise);

  hydrateRoot(
    document.getElementById('root') as HTMLElement,
    <SSRStoreProvider store={store}>
      <AppBootstrap />
    </SSRStoreProvider>,
  );
};

if (document.readyState !== 'loading') {
  bootstrap();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    bootstrap();
  });
}

```

### React 'entry-server.tsx'

Extended pipe object with callbacks to @taujs/server enabling additional manipulation of HEAD content from client code

```
import { ServerResponse } from 'node:http';

import React from 'react';
import { createSSRStore, SSRStoreProvider } from '@taujs/server/data-store';
import { createStreamRenderer } from '@taujs/server/render';

import AppBootstrap from '@client/AppBootstrap';

import type { RenderCallbacks } from '@taujs/server';

export const streamRender = (
  serverResponse: ServerResponse,
  { onHead, onFinish, onError }: RenderCallbacks,
  initialDataPromise: Promise<Record<string, unknown>>,
  bootstrapModules: string,
) => {
  const store = createSSRStore(initialDataPromise);

  const headContent = `
    <meta name="description" content="taujs [ τjs ]">
    <link rel="icon" type="image/svg+xml" href="/taujs.svg" />
    <title>taujs [ τjs ]</title>
  `;

  createStreamRenderer(
    serverResponse,
    { onHead, onFinish, onError },
    {
      appElement: (
        <SSRStoreProvider store={store}>
          <AppBootstrap />
        </SSRStoreProvider>
      ),
      bootstrapModules,
      getStoreSnapshot: store.getSnapshot,
      headContent,
    },
  );
};

```

### index.html

```
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--ssr-head-->
  </head>
  <body>
    <main id="root"><!--ssr-html--></main>
  </body>
</html>
```

### client.d.ts

```
interface Window {
  __INITIAL_DATA__: Record<string, unknown>;
}
```

### Routes

Integral to τjs is its internal routing:

1. Fastify serving index.html to client browser for client routing
2. Internal service calls to API to provide data for streaming/hydration
3. Fastify serving API calls via HTTP in the more traditional sense of client/server

In ensuring a particular 'route' receives data for hydration there are two options:

1. An HTTP call elsewhere syntactically not unlike 'fetch' providing params to a 'fetch' call
2. Internally calling a service which in turn will make 'call' to return data as per your architecture

In supporting Option 2. there is a registry of services. More detail in 'Service Registry'.

Each routes 'path' is a simple URL regex as per below examples.

```
import type { Route, RouteParams } from '@taujs/server';

export const routes: Route<RouteParams>[] = [
  {
    path: '/',
    attributes: {
      fetch: async () => {
        return {
          url: 'http://localhost:5173/api/initial',
          options: {
            method: 'GET',
          },
        };
      },
    },
  },
  {
    path: '/:id',
    attributes: {
      fetch: async (params: RouteParams) => {
        return {
          url: `http://localhost:5173/api/initial/${params.id}`,
          options: {
            method: 'GET',
          },
        };
      },
    },
  },
  {
    path: '/:id/:another',
    attributes: {
      fetch: async (params: RouteParams) => {
        return {
          options: { params },
          serviceMethod: 'exampleMethod',
          serviceName: 'ServiceExample',
        };
      },
    },
  },
];
```

### Service Registry

In supporting internal calls via τjs a registry of available services and methods provides the linkage to your own architectural setup and developmental patterns

```
import { ServiceExample } from './ServiceExample';

import type { ServiceRegistry } from '@taujs/server';

export const serviceRegistry: ServiceRegistry = {
  ServiceExample,
};
```

```
export const ServiceExample = {
  async exampleMethod(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ hello: `world internal service call response with id: ${params.id} and another: ${params.another}` });
      }, 5500);
    });
  },
};
```
