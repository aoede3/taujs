---
title: τjs Architecture
description: How Fastify dispatch, application contracts, renderers and build-time composition fit together.
---

τjs is an application-response orchestration layer built on Fastify and Vite. It coordinates the
work needed to turn a declared application route into HTML, then hands framework-specific rendering
to React, Vue or Solid.

Its central boundary is straightforward:

> Fastify owns HTTP dispatch and the host lifecycle. τjs owns the declared application response
> after Fastify selects a τjs route.

That boundary is what lets τjs add data orchestration, policy, rendering and introspection without
becoming a replacement HTTP server or a client-side application framework.

## The ownership layers

| Layer | Owns | Does not own |
| --- | --- | --- |
| Fastify host | HTTP route dispatch and lifecycle mechanics, listening, shutdown and host routes | Application rendering decisions |
| τjs application scope | Declared page routes, policy, response-owned data, rendering strategy and response episodes | Caller routes or component-local work |
| Renderer package | Framework SSR, streaming, hydration and framework-native Suspense integration | Route discovery, service selection or host policy |
| Application UI | Components, client routing, interaction, mutations and UI-local async work | Host routing or τjs response-owned work |

When τjs creates Fastify, its application scope is the root and its defaults can cover the whole
server. When a caller supplies Fastify, τjs installs into an encapsulated application scope and
leaves the caller's routes and lifecycle alone. Development adds one root Vite delegation hook so
unrouted module requests can reach the τjs-owned dev server; production does not.

See [Host Ownership](/guides/host-ownership) for the complete installation boundary.

## Request flow

Every configured page path is registered as a real Fastify route. Fastify selects the route and
decodes its parameters; there is no second τjs matcher inside a catch-all handler.

```text
      HTTP request
           │
           ▼
 Fastify route selection
           │
           ▼
┌───────────────────────┐
│          τjs          │
├───────────────────────┤
│ Route                 │
│ Policy                │
│ Head & Critical Data  │
│ Deferred Data         │
│ Services              │
│ Render & Hydration    │
├───────────────────────┤
│ Episode                 │
└───────────────────────┘
           │
           ▼
   React • Vue • Solid
           │
           ▼
      HTML response
           │
           ▼
   Optional hydration
```

Once the route is selected, τjs resolves the application contract from `taujs.config.ts`. The
contract can state:

- which application and renderer own the route;
- whether rendering is `ssr` or `streaming`;
- whether the result hydrates;
- static metadata and dynamic head data;
- authentication and CSP policy;
- critical initial data and named deferred data;
- declared service relationships.

The renderer consumes the result of that orchestration. It does not discover the contract by
walking the component tree.

## Governed data and application-local data

τjs does not require every data read to move out of components. It distinguishes work the server is
asked to govern from work the application owns locally.

| Data work | Timing | τjs responsibility |
| --- | --- | --- |
| `attr.head` | Resolves before rendering | Makes dynamic head values available before the shell |
| `attr.data` | Declared initial snapshot | Supplies SSR or the renderer's streaming data channel |
| `attr.deferred` | Starts before rendering and is not awaited first | Owns named streaming work through completion, failure or abort |
| Component or client fetch | Starts from the UI or after hydration | Outside the τjs request contract |

Deferred data preserves the declaration boundary while allowing progressive delivery. The loader is
known before rendering, starts once per request and reaches the selected framework through its
native Suspense mechanism. The frameworks differ in their rendering primitives, but the host
contract remains the same.

Deferred outcomes are not HTTP statuses. A deferred value may settle after headers have committed,
so work that must prevent or redirect the response belongs in a pre-commit request phase. See
[Request Contracts and Data Ownership](/guides/request-contracts) and
[Data Loading](/guides/data-loading) for the detailed lifecycle.

Async work started by a component remains valid. It is simply not presented as a declared service
edge, cancelled as τjs deferred work or recorded as a deferred outcome. The distinction is about
ownership and evidence, not permission.

## Contracts become artefacts

The application configuration is a declarative, statically enumerable record, although its handler
functions still execute at request time. τjs uses that distinction to produce two complementary
forms of evidence.

### Request graph

The request graph describes what the configured system can do without executing a renderer. It can
include applications, Fastify paths, render and hydration choices, policy, declared data edges,
deferred keys and configuration warnings.

A branded `serviceData()` declaration gives the graph a static service edge. An arbitrary handler
or dynamic `ctx.call()` remains supported, but the concrete call is runtime evidence rather than a
statically declared relationship.

Development emits the live graph under `node_modules/.taujs/`; builds emit a structure-only graph
under `dist/.taujs/`.

### Request episode

Development request episodes describe what one response actually did: the selected route, service
calls, stream phases, deferred outcomes, hydration evidence and terminal result. Production does
not load the development recorder.

The [MCP server](/reference/mcp) reads the graph and live episodes as artefacts. It does not infer route
ownership or request behaviour by guessing from component source.

## Renderer boundary

A renderer belongs to an application, not an individual route. One document response selects one
application, one renderer root and one request-owned data scope.

Within that boundary:

- routes choose SSR or streaming and whether to hydrate;
- the renderer package owns framework compilation and server rendering;
- the application owns its component tree and client router;
- services and policy can remain renderer-neutral.

Moving a URL area from React to Vue or Solid means moving it to an application that declares that
renderer. It does not mean switching frameworks halfway through one response. See
[Incremental Migration](/guides/incremental-migration) for the practical boundary.

## Build-time multi-app composition

A τjs configuration can declare several applications under one server contract. Each application
gets its own client build, SSR build, assets and renderer root. Fastify routes each request to the
owning application, and the browser receives only that application's bundle.

```text
τjs server
├── storefront-react  -> /, /products/*
├── account-solid     -> /account/*
└── admin-vue         -> /admin/*
```

The applications are separate build units inside one coordinated build and deployment. τjs does
not load several application bundles into one browser runtime, negotiate shared dependencies at
runtime or preserve in-memory state across application boundaries.

Navigation between applications is a full document navigation. Navigation within one application
shell can remain client-side. This makes the URL boundary the composition seam and avoids a runtime
federation layer. See [Micro-Frontends](/guides/micro-frontend) for build, routing and transition
patterns.

## Application shells and undeclared screens

A client-routed screen does not need its own τjs data contract. It needs a server route or fallback
that delivers the application shell:

- a τjs-created host provides an implicit shell for unmatched document-like URLs;
- a caller-owned host requires an explicit terminal `/*` page when the application should own
  those URLs.

The shell loads the client bundle and the client router can take over. This is how τjs supports
incremental adoption without pretending every client screen has declared request orchestration. See
[App Shell Architecture](/reference/app-shell-pattern) for the complete pattern.

## Failure and cancellation boundaries

Ownership continues through failure handling:

- Fastify owns malformed requests and host-route failures;
- τjs owns errors raised while producing a τjs response;
- renderers own framework rendering and hydration failures;
- deferred work is classified once as `complete`, `failed` or `aborted`;
- response-owned work is released when the response finishes or the client disconnects.

Once a streaming response has committed, no framework can rewrite its status line or replace bytes
already sent. τjs records and terminates according to the current response state instead of
pretending every failure can become a fresh 500 document.

## Adoption and removal

τjs can be adopted incrementally:

- begin with one application and ordinary client-side fetching;
- declare initial data only where server coordination provides value;
- introduce the service registry when named edges and shared request context are useful;
- move a coherent URL area to another renderer without changing its service contract.

Removing τjs is possible, but not free. A replacement must take over the Fastify page routes,
renderer bootstraps, SSR and streaming integration, initial-data transport, security policy and any
introspection the application uses. Components, domain services and explicit API endpoints can
remain, but the orchestration layer must be replaced rather than simply deleted.

That is the intended trade-off: τjs owns a visible architectural layer, not hidden component
behaviour.

## What τjs is not

τjs is not:

- a client-side router;
- a runtime module-federation system;
- a replacement for Fastify;
- a cross-framework component runtime;
- a provider-specific hosting integration;
- a substitute for application APIs or post-hydration data libraries.

It provides a server-owned contract for composing application responses. The browser framework and
the Fastify host remain first-class parts of the system.

## Read next

- [Request Contracts and Data Ownership](/guides/request-contracts)
- [Host Ownership](/guides/host-ownership)
- [Data Loading](/guides/data-loading)
- [Micro-Frontends](/guides/micro-frontend)
- [Incremental Migration](/guides/incremental-migration)
