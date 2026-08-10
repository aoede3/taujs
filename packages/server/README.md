# @taujs/server

https://www.taujs.dev

This package is part of the τjs [ taujs ] orchestration system, authored by John Smith | Aoede, 2024-present. Attribution is appreciated.

`npm install @taujs/server`

`yarn add @taujs/server`

`pnpm add @taujs/server`

## SSR; Streaming SSR; CSR; Hydration; Fastify

Fastify plugin and render orchestration for React, Vue and Solid applications. The renderer ships separately - pair this package with one of:

- `@taujs/react`
- `@taujs/vue`
- `@taujs/solid`

Rendering:

- Server-side rendering (SSR) and Streaming SSR, chosen per declared route
- Client-side rendering (CSR) by omission: when no declared τjs route matches a URL, it remains outside server orchestration; what answers it depends on host ownership

Supported application structure and composition:

- Single-page Application (SPA)
- Multi-page Application (MPA)
- Build-time Micro-Frontends (MFE), with server orchestration and delivery

Assemble independent frontends at build time in a flexible SPA-MPA hybrid: SSR or Streaming SSR per declared route, CSR by omission.

- Production: Fastify
- Development: Fastify, tsx, Vite
- TypeScript-first
- ESM-only

## τjs - DX Developer Experience

Integrated Vite HMR run alongside tsx (TS eXecute) providing fast responsive dev reload times for universal backend / frontend changes

- Fastify https://fastify.dev/
- tsx https://tsx.is/
- Vite https://vitejs.dev/

## Usage

Scaffold a complete project with `npm create @taujs/taujs`, or start from the documentation:

- Getting started: https://taujs.dev/guides/getting-started/
- Application contract and configuration: https://taujs.dev/reference/taujs-config/
- Host ownership (bring your own Fastify): https://taujs.dev/guides/host-ownership/
- Renderers: https://taujs.dev/renderers/react/ | https://taujs.dev/renderers/vue/ | https://taujs.dev/renderers/solid/

### Routes

Each route path uses Fastify route syntax. Configure router behaviour on the Fastify instance passed to createServer; τjs does not maintain a parallel matcher or duplicate Fastify router options.

Known stale path-to-regexp forms fail at startup rather than registering with different semantics.
Auth and route CSP apply only to the Fastify-selected τjs route. Dotted values are valid page-route
parameters; asset-like URLs 404 only when no static or declared page route owns them.

### Service Registry

Internal service calls resolve route data through a registry of services and methods, linking the render pipeline to your own architecture. See https://taujs.dev/guides/services/
