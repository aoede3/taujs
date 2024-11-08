# @taujs/server

`npm install @taujs/server`

`yarn add @taujs/server`

`pnpm add @taujs/server`

## CSR; SSR; Streaming SSR; Hydration; Fastify + React 18

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

https://github.com/aoede3/taujs/blob/main/src/server/index.ts

Not utilising taujs [ τjs ] template? Add in your own ts `alias` object for your own particular directory setup e.g. `alias: { object }`

### React 'entry-client.tsx'

https://github.com/aoede3/taujs/blob/main/src/client/entry-client.tsx

### React 'entry-server.tsx'

Extended pipe object with callbacks to @taujs/server enabling additional manipulation of HEAD content from client code

https://github.com/aoede3/taujs/blob/main/src/client/entry-server.tsx

### index.html

https://github.com/aoede3/taujs/blob/main/src/client/index.html

### client.d.ts

https://github.com/aoede3/taujs/blob/main/src/client/client.d.ts

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

https://github.com/aoede3/taujs/blob/main/src/shared/routes/Routes.ts

### Service Registry

In supporting internal calls via τjs a registry of available services and methods provides the linkage to your own architectural setup and developmental patterns

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceRegistry.ts

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceExample.ts
