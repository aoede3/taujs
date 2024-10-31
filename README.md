# taujs | τjs

taujs [ τjs ] template

> τjs is in development. Expect some breaking changes on the road towards a stable v1 release. Some features may or may not be missing!

## Streaming React SSR & Hydration

- Production: Fastify, React
- Development: Fastify, React, Vite, tsx

TypeScript / ESM-only focus

## τjs - Developer eXperience

See `@taujs/server` Fastify Plugin https://github.com/aoede3/taujs-server

Integrated ViteDevServer HMR + Vite Runtime API run alongside tsx (TS eXecute) providing fast responsive dev reload times for both backend / frontend

- Fastify https://fastify.dev/
- Vite https://vitejs.dev/guide/ssr#building-for-production
- React https://reactjs.org/

- tsx https://tsx.is/

- ViteDevServer HMR https://vitejs.dev/guide/ssr#setting-up-the-dev-server
- Vite Runtime API https://vitejs.dev/guide/api-vite-runtime
- ESBuild https://esbuild.github.io/
- Rollup https://rollupjs.org/
- ESM https://nodejs.org/api/esm.html

## Development

`yarn` to install

`yarn dev` to start universal development server

`yarn build` to build for production

`yarn start` to start production

Example developmental URL as per `routes.ts`:

```
http://[::1]:5173
http://[::1]:5173/first
http://[::1]:5173/first/second
```

## Usage

### Structure

Opinionated folder structure seperating each facet:

```
src
  client
  server
  shared
```

_client_: React; Streaming SSR entry-client + entry-server

_server_: Fastify + τjs plugin; service registry / services

_shared_: routes.ts τjs routing file; any shared files, types, etc.

Beyond this scope each area is open to be built around whatever architectural and or design patterns one would want to employ.

### Routes

Integral to τjs is its internal routing:

1. Fastify serving index.html to client browser for client routing
2. Internal service calls to API prior to Streaming SSR to provide data for streaming/hydration
3. Fastify API calls via HTTP in the more traditional sense of client/server

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
    attr: {
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
    attr: {
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
    attr: {
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

τjs' registry of available services and methods provides the linkage between the SSR Streaming routes and your own Fastify architectural setup and developmental patterns

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
        resolve({ hello: `world internal service response with id: ${params.id} and another: ${params.another}` });
      }, 5500);
    });
  },
};
```
