---
title: Request Contracts and Data Ownership
description: How Fastify dispatch, route declarations, data timing and renderer choice form an inspectable response contract.
---

A request contract is the route record in `taujs.config.ts` that describes how τjs should produce
an application response. Fastify owns HTTP dispatch. Once Fastify selects a τjs page route, τjs
applies that route's policy, data and rendering declarations before invoking the selected renderer.

The contract moves initial-response coordination out of the component tree without banning
component-owned fetching:

```text
Fastify route
    -> τjs request contract
    -> policy and response-owned data
    -> React, Vue or Solid renderer
    -> HTML response and optional hydration
```

You can introduce this boundary one route at a time.

## A current request contract

The route record can describe rendering, hydration, policy, head data, critical data and deferred
data together. This example assumes `serviceData` was created for the application's typed service
registry:

```ts
export const productRoute = {
  path: "/products/:id",
  attr: {
    render: "streaming",
    hydrate: true,
    meta: { title: "Product" },
    middleware: { auth: {} },
    head: {
      data: serviceData("catalogue", "getProductHead", ({ id }) => ({ id })),
      optional: true,
    },
    data: serviceData("catalogue", "getProduct", ({ id }) => ({ id })),
    deferred: {
      reviews: serviceData("reviews", "forProduct", ({ id }) => ({ id })),
    },
  },
} as const;
```

For a request to `/products/42`:

1. Fastify selects the concrete route and decodes `id`.
2. τjs applies the declared auth and CSP policy.
3. Head and route-data work starts at the request boundary.
4. The renderer receives the critical initial-data channel and the already-started named deferred
   registry.
5. In development, the response trace records what actually happened.

There is no second τjs route matcher and the renderer does not rediscover the route contract from
the component tree.

## Four data ownership choices

The route fields describe different timing and ownership, not four spellings for the same work.

| Work | Owner | Timing and purpose |
| --- | --- | --- |
| `attr.head` | Request | Resolves before rendering so dynamic head values are available before the shell. |
| `attr.data` | Request | Supplies the required initial snapshot. SSR resolves it before rendering; streaming can project it through the renderer's native streaming path. |
| `attr.deferred` | Request | Starts named work before rendering without awaiting it first. Available on streaming routes only. |
| Component or client fetch | Application | Starts from the UI or after hydration and remains outside the τjs response contract. |

`attr.deferred` is declarative response-owned work. Each entry starts once, shares the request
cancellation lifecycle, appears in the request graph, records a `complete`, `failed` or `aborted`
outcome on the development request trace, and reaches the renderer through its native Suspense
primitive. A value consumed during rendering reaches hydration through a private seed without
re-running the loader or issuing a client refetch.

Deferred entries are not HTTP-status-bearing. Their result may arrive after the status and headers
have committed. Work that must prevent the response, redirect it or determine its status belongs in
a pre-commit request phase, not in `attr.deferred`.

Deferral is a property of the declaration, never of the tree. A component cannot promote async work
it starts into the deferred registry. That work is still valid, but it remains UI-local and τjs does
not present it as a declared dependency, cancel it as deferred work or record a deferred outcome for
it.

See [Data Loading](/guides/data-loading) for the complete lifecycle and the renderer guides for the
React, Vue and Solid accessors.

## Declared shape and runtime evidence

A request contract is a declarative, statically enumerable configuration record. Its handlers are
functions that execute at request time, so not every fact is knowable statically.

The distinction is intentional:

- Fastify page paths, rendering, hydration, policy, head declarations and deferred keys are visible
  from configuration.
- `serviceData()` carries branded service identity, allowing the request graph to record a service
  edge without executing the loader.
- An arbitrary handler or dynamic `ctx.call()` remains valid, but the concrete call is runtime
  evidence rather than a statically declared edge.
- Development request traces record the route selected, service calls made, deferred outcomes and
  response terminal that occurred for one real request.

The generated request graph and live development traces therefore answer different questions. The graph says
what the system declares and can do. A trace says what one request did. The
[MCP server](/reference/mcp) reads both forms of evidence rather than inferring them from component
source.

## Undeclared URLs and client routing

Not every client-routed screen needs its own τjs route declaration. A document-like URL that has no
matching page contract can still receive the application shell, load the client bundle and let the
client router take over. The shell owner depends on who created Fastify:

- **τjs-created Fastify:** the implicit application-shell fallback serves unmatched document-like
  URLs with status 200. The child URL can remain client-routed without a separate τjs contract.
- **Caller-owned Fastify:** unmatched URLs belong to the caller. To preserve the same shell
  behaviour, declare an explicit terminal `/*` page route for the application. Without it, the
  caller's not-found response wins.

```ts
routes: [
  { path: "/", attr: { render: "ssr", hydrate: true } },
  { path: "/*", attr: { render: "ssr", hydrate: true } },
];
```

The wildcard is the server route; individual child URLs can still be owned by the client router
inside that shell. A wildcard-enabled caller `@fastify/static` mount also claims `GET /*` and will
collide at boot, so configure that mount with `wildcard: false` or use non-overlapping patterns.

See [Host Ownership](/guides/host-ownership) for the owner split and
[App Shell Architecture](/reference/app-shell-pattern) for the full routing pattern.

## Client fetching remains part of the model

Request contracts govern the initial application response. They do not replace the client data
layer. Components can still:

- fetch from explicit API endpoints;
- refresh or poll after hydration;
- issue mutations in response to user interaction;
- subscribe to real-time updates;
- keep screen-local async work inside the UI.

A common migration moves only the initial read into `attr.data`, while the existing query library
continues to own refreshes and mutations. The same domain or service implementation can sit behind
both paths.

The distinction is where authority starts, not what application code is allowed to do.

## Scope across applications and MFEs

One document response selects one τjs application and one renderer root. Its critical snapshot,
deferred registry, ordering and hydration seed belong to that response and that root. They do not
coordinate with a second application.

Navigation across τjs micro-frontend boundaries remains a full document navigation. The destination
application creates its own request contract and data scope. Within an application shell, the
client router can own subsequent navigation and UI-local fetching. See
[Micro-Frontends](/guides/micro-frontend) for where to place those boundaries.

## When the structure pays for itself

Request contracts are most useful when initial rendering depends on several services, policy must
be applied before rendering, rendering strategy varies by route, or teams need a graph and trace of
how a response was assembled.

For a small interactive screen whose data is entirely post-hydration, component-owned fetching may
remain the clearer choice. τjs does not require every URL or every data read to become a request
contract.

The useful boundary is the initial response: declare the work that the server must coordinate and
leave application-local work in the application.

## Read next

- [Data Loading](/guides/data-loading) for critical and deferred data behaviour
- [Services](/guides/services) for mediated backend access
- [Head Management](/guides/head-management) for pre-render head data
- [τjs Configuration](/reference/taujs-config) for the complete route schema
- [Incremental Migration](/guides/incremental-migration) for adopting the model route by route
