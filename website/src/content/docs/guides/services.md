---
title: Services
description: Typed server-side service mediation for route data and composition
---

The service registry is an optional server-side layer between route contracts and business or data
access. It becomes useful when named service edges, shared cancellation, structured records, runtime
validation or service-to-service composition justify the boundary.

You can use τjs route data without a registry. Services are not controllers and are not exposed as
HTTP endpoints automatically.

## Define a service

A service is a named collection of async methods:

```ts
// src/server/services/catalogue.ts
import { AppError, defineService } from "@taujs/server/config";

export const CatalogueService = defineService({
  product: async (params: { id: string }, ctx) => {
    ctx.logger?.info({ productId: params.id }, "Loading product");

    const product = await catalogueRepository.findById(params.id, {
      signal: ctx.signal,
    });

    if (!product) {
      throw AppError.notFound(`Product ${params.id} not found`);
    }

    return { product };
  },
});
```

A method receives:

1. a plain parameter object
2. a service context

It must resolve to a plain JSON-compatible object. Do not return a primitive, array, class instance,
`Date`, stream or response object as the root result.

Params must also be a JSON object type: use a type alias or an inline object type. An `interface`
without an index signature is not accepted (TypeScript does not give an `interface` an implicit
index signature), and `defineService()` reports it on the offending method with a
`__taujsServiceTypeError` message. `interface X extends JsonObject { ... }` compiles and keeps the
method typed, but by inheriting the index signature it also admits unknown keys at call sites -
prefer the alias:

```ts
type ProductParams = { id: string };

export const CatalogueService = defineService({
  product: async (params: ProductParams, ctx) => {
    // ...
    return { product };
  },
});
```

## Create the registry

The registry is the runtime dispatch table and the source of its TypeScript inference:

```ts
// src/server/services/registry.ts
import {
  createServiceData,
  defineServiceRegistry,
} from "@taujs/server/config";
import { CatalogueService } from "./catalogue";
import { ReviewsService } from "./reviews";

export const serviceRegistry = defineServiceRegistry({
  catalogue: CatalogueService,
  reviews: ReviewsService,
});

export const serviceData = createServiceData<typeof serviceRegistry>();
```

Pass the same registry to the server:

```ts
await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "./src/client",
});
```

`defineServiceRegistry()` freezes the registry and its service objects. It does not start services or
create a network boundary.

## Use services from route data

### Declared service edge

Use `serviceData()` when one route loader maps directly to one service method:

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

This checks the service name, method and mapper result at compile time. It also stamps
non-enumerable metadata on the loader so the request graph can show the route-to-service edge without
executing application code.

A hand-written service descriptor remains valid, but loses some inference and static discoverability:

```ts
data: async ({ id }) => ({
  serviceName: "catalogue",
  serviceMethod: "product",
  args: { id: String(id) },
});
```

### Coordinate calls with `ctx.call`

Use the route context's typed caller when the route coordinates several methods:

```ts
data: async ({ id }, ctx) => {
  const product = await ctx.call("catalogue", "product", {
    id: String(id),
  });
  const reviews = await ctx.call("reviews", "forProduct", {
    id: String(id),
  });

  return { product, reviews };
};
```

The returned values are the service result objects. In this example `product.product` and
`reviews.reviews` reflect the records returned by the two methods, so name service result fields with
composition in mind.

The same `serviceData()` helper can be used under `attr.head.data` and each named `attr.deferred`
entry. Their lifecycle and failure semantics still belong to the route slot that invoked the service.

## Service context

The base public context is:

```ts
type ServiceContext = {
  signal?: AbortSignal;
  deadlineMs?: number;
  requestId?: string;
  logger?: Logs;
  user?: { id: string; roles: string[] } | null;
};
```

The route pipeline supplies the request signal, request identity and request-scoped logger. It installs
a registry caller on the runtime context for route and service composition.

The optional `user` field is not populated automatically. A Fastify `authenticate` decorator may set
`req.user`, but τjs does not copy that value into route or service context. Resolve identity in trusted
server code and pass the validated identifier or capability as an ordinary service parameter. See
[Authentication](/guides/authentication/#identity-in-route-data-and-services).

### Application context fields

`ServiceContext` is augmentable for contexts your application constructs or enriches:

```ts
// src/taujs-types.d.ts
declare module "@taujs/server/config" {
  interface ServiceContext {
    tenantId?: string;
    requestStartMs?: number;
  }
}
```

Type augmentation does not populate a value at runtime. Do not declare a field and then assume the
route pipeline supplies it.

## Service-to-service composition

Inside a service, type `ctx.call` against only the services that method depends on:

```ts
import type { TypedServiceContext } from "@taujs/server/config";

import { CatalogueService } from "./catalogue";
import { UserService } from "./users";

type OrderDependencies = {
  catalogue: typeof CatalogueService;
  users: typeof UserService;
};

export const OrderService = defineService({
  details: async (
    params: { orderId: string; userId: string; productId: string },
    ctx: TypedServiceContext<OrderDependencies>,
  ) => {
    const user = await ctx.call("users", "user", { id: params.userId });
    const product = await ctx.call("catalogue", "product", {
      id: params.productId,
    });

    return { orderId: params.orderId, user, product };
  },
});
```

Local dependency types avoid circular inference while retaining checked service names, methods,
parameters and results.

After the full registry exists, an app-level helper or test can use:

```ts
import type { TypedServiceContext } from "@taujs/server/config";
import type { serviceRegistry } from "./registry";

type AppServiceContext = TypedServiceContext<typeof serviceRegistry>;
```

Do not augment `ServiceContext.call` with the full registry. That creates circular type relationships;
use `TypedServiceContext<R>` instead.

## Cancellation and deadlines

Service dispatch checks the request signal before invoking a method and passes that signal into the
method. The service must pass it to cancellable downstream work:

```ts
const response = await fetch(url, { signal: ctx.signal });
```

Use `withDeadline()` to combine the parent signal with a service-specific timeout:

```ts
import { withDeadline } from "@taujs/server/config";

export const SearchService = defineService({
  search: async (params: { query: string }, ctx) => {
    const signal = withDeadline(ctx.signal, 2_000);
    const response = await fetch(
      `https://search.example.test/?q=${encodeURIComponent(params.query)}`,
      { signal },
    );

    return { results: await response.json() };
  },
});
```

`withDeadline()` uses `Error("DeadlineExceeded")` when its timer fires. Some downstream APIs replace
the signal reason with a generic abort error, but cancellation still occurs.

A deferred route entry also has the renderer's response-level deferred deadline. That outer deadline
and a service-specific deadline solve different problems: response completion versus one downstream
operation.

## Runtime validation

`defineService()` accepts synchronous parsers for parameters and results. A parser may be a schema
with `.parse()` or a function `(input: unknown) => value`:

```ts
import { z } from "zod";
import { defineService } from "@taujs/server/config";

export const UserService = defineService({
  create: {
    params: z.object({
      email: z.string().email(),
      name: z.string().min(1),
    }),
    result: z.object({
      user: z.object({
        id: z.string(),
        email: z.string(),
        name: z.string(),
      }),
    }),
    handler: async (params) => ({
      user: await users.create(params),
    }),
  },
});
```

Both parsers are optional. They run inside service dispatch, so validation failures follow the same
error and episode path as method failures.

## Errors, records and episodes

Service dispatch creates a child logger with `component`, `service` and `method` bindings; the
canonical `reqId` arrives through the request logger's lineage in its native type and is never
rebound.
It records duration and success or failure in the development request episode.

- an existing `AppError` keeps its status and safe-message policy
- another thrown error is wrapped as an internal `AppError`
- a non-object result becomes an internal error
- a critical service failure follows the route renderer's error path; before commit it can produce an
  HTTP error, while a post-commit stream cannot rewrite its status
- a deferred service failure becomes that entry's detail-free `failed` outcome after the shell may
  have committed

Failure records carry the service, method, duration and error details - never the parameter object.
Configure redaction on the selected Fastify, Pino or custom logger for sensitive application fields.
See [Logging & Telemetry](/guides/logging-telemetry/#sensitive-data).

## Testing

Services are plain async functions after `defineService()` normalises them. Test a method with the
smallest context it needs:

```ts
import { describe, expect, it, vi } from "vitest";

it("loads a product", async () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const result = await CatalogueService.product(
    { id: "p1" },
    { requestId: "test-request-id", logger },
  );

  expect(result.product.id).toBe("p1");
});
```

For composition, provide a typed `call` spy and assert service, method and parameters. Add an HTTP
regression when status, headers, auth, cancellation or deferred response behaviour matters; a direct
method test cannot prove those host-level outcomes.

## Practical rules

- Keep request and response concerns in route configuration or Fastify.
- Keep business and data access in services.
- Use `serviceData()` for a direct declared edge and `ctx.call` for orchestration.
- Return plain serialisable records.
- Pass `ctx.signal` to downstream work.
- Pass validated identity explicitly rather than relying on ambient `ctx.user`.
- Type service dependencies locally.
- Configure logger redaction for sensitive parameter fields.
- Remember that services are not browser endpoints.

Related guides:

- [Data Loading](/guides/data-loading/) for critical, head and deferred slots
- [Authentication](/guides/authentication/) for the Fastify auth boundary
- [Logging & Telemetry](/guides/logging-telemetry/) for service records and episodes
- [Request Contracts & Data](/guides/request-contracts/) for route ownership
