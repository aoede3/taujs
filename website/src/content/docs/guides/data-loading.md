---
title: Data Loading
description: Critical and deferred route data for SSR and streaming responses
---

τjs declares initial-response data at the route boundary. The server can therefore see which work is
critical, which work is deferred, which service edges are involved and which response owns the work.

There are three separate inputs:

| Input | Purpose | Timing |
| --- | --- | --- |
| `attr.data` | Critical page data | Must settle before its renderer can complete the required pre-shell work |
| `attr.head` | Dynamic head data | Settles before rendering and reaches `headContent` as `headData` |
| `attr.deferred` | Named non-status-bearing data | Starts with the response and may settle after streaming begins |

Component-started fetching remains useful after hydration, but it is outside this response contract.

## Critical route data

A critical loader runs on the server and must resolve to a plain object:

```ts
// taujs.config.ts
{
  path: "/products/:id",
  attr: {
    render: "ssr",
    data: async ({ id }, ctx) => {
      ctx.logger.info({ productId: id }, "Loading product");

      const response = await fetch(
        `https://catalogue.example.test/products/${encodeURIComponent(String(id))}`,
        { signal: ctx.signal },
      );

      if (!response.ok) {
        throw new Error(`Catalogue returned ${response.status}`);
      }

      return { product: await response.json() };
    },
  },
}
```

Critical data is appropriate when the result is needed to render the initial response. Any
condition that must prevent, redirect or choose the status of the response belongs in middleware or
critical resolution rather than deferred data. As with every streamed response, an error after bytes
have committed cannot rewrite the status already sent.

Do not return a primitive, array or class instance as the root value. Route data crosses the SSR
serialisation boundary and must be a plain JSON-compatible record.

## Loader context

A route loader receives route parameters and a request-scoped context. The useful public fields are:

```ts
type LoaderContext = {
  requestId: string;
  logger: Logs;
  headers: Record<string, string>;
  signal?: AbortSignal;
  call: RegistryCaller;
};
```

- `requestId` and `logger` use the τjs request identity and selected logger lineage.
- `headers` contains normalised request-header values. Treat credentials as sensitive.
- `signal` aborts with the response lifecycle.
- `call` invokes a registered service with the same request context.

The Fastify authentication decorator may attach `req.user`, but τjs does not copy it into this
context automatically. Resolve identity explicitly in trusted server code when a loader needs it.
See [Authentication](/guides/authentication/#identity-in-route-data-and-services).

## Declared service data

For a direct route-to-service edge, create a typed `serviceData` helper from the registry:

```ts
// src/server/services/registry.ts
import {
  createServiceData,
  defineServiceRegistry,
} from "@taujs/server/config";

export const serviceRegistry = defineServiceRegistry({
  catalogue: CatalogueService,
  reviews: ReviewsService,
});

export const serviceData = createServiceData<typeof serviceRegistry>();
```

```ts
{
  path: "/products/:id",
  attr: {
    render: "ssr",
    data: serviceData("catalogue", "product", ({ id }) => ({
      id: String(id),
    })),
  },
}
```

The helper checks service and method names, validates mapped parameter types and records the declared
route-to-service edge without executing the loader. This is more useful to the request graph than a
promise discovered inside a component.

Use `ctx.call` when a route must coordinate several service calls or transform their results:

```ts
data: async ({ id }, ctx) => {
  const product = await ctx.call("catalogue", "product", {
    id: String(id),
  });
  const stock = await ctx.call("catalogue", "stock", {
    id: String(id),
  });

  return { product, stock };
};
```

See [Services](/guides/services/) for registry, composition and error semantics.

## SSR and streaming

### SSR

An SSR route resolves its critical data before rendering the document:

```ts
{
  path: "/products",
  attr: {
    render: "ssr",
    data: serviceData("catalogue", "listProducts", () => ({})),
  },
}
```

The renderer receives the settled value, emits the HTML and serialises the same snapshot for
hydration when hydration is enabled.

### Streaming

A streaming route can begin sending renderer output before every streamed boundary settles:

```ts
{
  path: "/dashboard",
  attr: {
    render: "streaming",
    meta: { title: "Dashboard" },
    data: async (_params, ctx) => ({
      metrics: await loadMetrics({ signal: ctx.signal }),
    }),
  },
}
```

Static `meta` is required for streaming. React and Vue may construct the head before critical
`attr.data` settles; Solid waits for critical data. Use `attr.head` for portable dynamic head values
rather than relying on critical page data. See [Head Management](/guides/head-management/).

Renderer-native ordering governs the body stream. Deferred work must not delay independent initial
shell content, but later byte ordering differs between React, Vue and Solid.

## Deferred route data

`attr.deferred` is a flat record available only on streaming routes:

```ts
{
  path: "/products/:id",
  attr: {
    render: "streaming",
    meta: { title: "Product" },

    data: serviceData("catalogue", "product", ({ id }) => ({
      id: String(id),
    })),

    deferred: {
      reviews: serviceData("reviews", "forProduct", ({ id }) => ({
        id: String(id),
      })),
    },
  },
}
```

Each entry uses the same loader shape as `attr.data`. τjs:

- starts each declared entry once per response
- exposes the named promise to the selected renderer
- aborts response-owned work on disconnect or response termination
- records `complete`, `failed` or `aborted` once per key
- includes the declared edge in the request graph
- seeds hydration from the terminal server result without a client refetch

Deferred means later, not optional. There is one response-level deadline, not a retry or timeout per
entry. A deferred result cannot redirect, prevent the response or choose its HTTP status. Put any
status-bearing condition in middleware or critical data.

A component cannot promote its own async work into the registry. Work started in the component tree
remains UI-local and does not receive τjs cancellation, episode or hydration guarantees.

See [Deferred Route Data](/reference/taujs-config/#deferred-route-data) for validation and lifecycle
rules. The renderer guides document their native accessors:
[React](/renderers/react/#deferred-route-data),
[Vue](/renderers/vue/#deferred-route-data) and
[Solid](/renderers/solid/#deferred-route-data).

## Reading initial data

The renderer packages intentionally follow their framework idioms:

| Renderer | Initial-data read |
| --- | --- |
| React | `useSSRStore<T>()` returns the resolved value |
| Vue | `await useSSRDataAsync<T>()`, or `useSSRData<T>()` for a guarded computed value |
| Solid | `useSSRStore<T>().data()` returns the reactive value |

Use the matching renderer guide for complete provider, Suspense and hydration examples. Do not build a
cross-framework store wrapper solely to make these spellings identical.

## Client updates after hydration

Route data owns the initial response. It does not replace the application's client data layer.
Continue to use explicit API routes and the framework's normal client-fetching tools for:

- mutations and user-triggered actions
- polling and live updates
- reads that depend on browser-only state
- refreshes after the initial snapshot

A common arrangement is:

```text
initial critical/deferred data  -> τjs route contract
subsequent reads                -> client query library + explicit API
mutations                       -> application endpoints
```

Reuse underlying domain or service functions where helpful, but do not expose a route loader as an
automatic replayable data endpoint.

## Choosing critical or deferred

Use critical data when a failure must stop the response, when the value determines status or redirect,
or when the initial shell cannot render meaningfully without it.

Use deferred data when the shell can render independently and the value belongs to this response but
may arrive later. Keep component-owned fetching for work that truly begins from post-hydration UI
interaction.

Related guides:

- [Request Contracts & Data](/guides/request-contracts/) for ownership by declaration
- [Services](/guides/services/) for mediated server work
- [Head Management](/guides/head-management/) for head timing
- [Logging & Telemetry](/guides/logging-telemetry/) for request identity and episode outcomes
