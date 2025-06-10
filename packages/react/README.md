# @taujs/react

`npm install @taujs/server`

`yarn add @taujs/server`

`pnpm add @taujs/server`

## CSR; SSR; Streaming SSR; Hydration; Fastify + React 19

Supports rendering modes:

- Client-side rendering (CSR)
- Server-side rendering (SSR)
- Streaming SSR

Supported application structure and composition:

- Single-page Application (SPA)
- Multi-page Application (MPA)
- Build-time Micro-Frontends (MFE), with server orchestration and delivery

Assemble independent frontends at build time incorporating flexible per-route SPA-MPA hybrid with CSR, SSR, and Streaming SSR, rendering options.

Fastify Plugin for integration with taujs [ τjs ] template https://github.com/aoede3/taujs

- Production: Fastify, React
- Development: Fastify, React, tsx, Vite

- TypeScript-first
- ESM-only focus

## τjs - DX Developer Experience

Integrated Vite HMR run alongside tsx (TS eXecute) providing fast responsive dev reload times for universal backend / frontend changes

- Fastify https://fastify.dev/
- React https://reactjs.org/
- tsx https://tsx.is/
- Vite https://vitejs.dev/guide/ssr#building-for-production

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

1. An HTTP call syntactically not unlike 'fetch' providing params to a 'fetch' call
2. Internal service call returning data as per your architecture

In supporting Option 2. there is a registry of services. More detail in 'Service Registry'.

Each routes 'path' is a simple URL regex as per below examples.

https://github.com/aoede3/taujs/blob/main/src/shared/routes/Routes.ts

### Service Registry

In supporting internal calls via τjs a registry of available services and methods can provide linkage to your own architectural setup and developmental patterns

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceRegistry.ts

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceExample.ts
