# taujs | τjs

taujs [ τjs ] template

> τjs is in development. Expect some breaking changes on the road towards a stable v1 release. Some features may or may not be missing!

Example use of @taujs/server Fastify plugin. Simplified CSR, SSR, Streaming SSR, and Hydration, with 'fast' developer experience

## CSR, SSR, Streaming SSR, and Hydration. React 19.

- Production: Fastify, React
- Development: Fastify, React, Vite, tsx
- TypeScript-first
- ESM-only focus

Supports rendering modes:

- Client-side rendering (CSR)
- Server-side rendering (SSR)
- Streaming SSR

Supported application structure and composition:

- Single-page Application (SPA)
- Multi-page Application (MPA)
- Build-time Micro-Frontends, server orchestration and delivery

Assemble independently built frontends at build time incorporating flexible per-route SPA-MPA hybrid with CSR, SSR, and Streaming SSR, rendering options.

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

_client_: React; entry-client + entry-server

_server_: Fastify + τjs plugin; service registry / services

_shared_: routes.ts τjs routing file; any shared files, types, etc.

Beyond this scope each area is open to be built around whatever architectural and or design patterns one would want to employ.

### Routes

Integral to τjs is its internal routing:

1. Fastify serving index.html to client browser for client routing
2. Internal service calls to API prior to 'render' to provide data for render/hydration
3. Fastify API calls via HTTP in the more traditional sense of client/server

In ensuring a particular 'route' receives data for hydration there are two options:

1. An HTTP call elsewhere syntactically not unlike 'fetch' providing params to a 'fetch' call
2. Internally calling a service which in turn will make 'call' to return data as per your architecture

In supporting Option 2. there is a registry of services. More detail in 'Service Registry'.

Each routes 'path' is a simple URL regex as per below examples with choice of render.

https://github.com/aoede3/taujs/blob/main/src/shared/routes/Routes.ts

### Service Registry

τjs' registry of available services and methods provides the linkage between the SSR Streaming routes and your own Fastify architectural setup and developmental patterns

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceRegistry.ts

and

https://github.com/aoede3/taujs/blob/main/src/server/services/ServiceExample.ts

### Micro-Frontends MFE

Build-time micro-frontends enabling development and maintainance of independent frontend modules integrated during the build process and orchestrated and delivered by the server at run-time.

Configuration of each MFE entry point for build process via simple configuration object pointing to independant 'root' folders per micro-frontend.
https://github.com/aoede3/taujs/blob/main/src/server/index.ts

As per the following `buildConfig` file: https://github.com/aoede3/taujs/blob/main/src/buildConfig.ts a blank `entryPoint: ''` will cause the build to be output to the root of the `dist/client` folder
whilst a string value will be considered the isolated directory name from `src/client/directoryName` to be built and generated in dist e.g. `dist/client/directoryName`.

Each isolated micro-frontend should be tagged with an `appId` such that `@taujs/server` will connect with its internal configuration and client/server files.
