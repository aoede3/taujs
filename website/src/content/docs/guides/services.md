---
title: Services
description: How τjs's service registry works for organising data access and business logic
---

How τjs's service registry works for organising data access and business logic.

## Overview

τjs provides an optional service registry pattern for separating route handlers from business logic and data access. You can use τjs without it but, it becomes valuable when you need consistent cross-cutting behaviour (logging, auth, tracing, retries) across all data access, or when you expect service boundaries to evolve over time.

**Key components:**

- `defineService` - Create typed service definitions from a collection of async methods
- `defineServiceRegistry` - Register services for runtime dispatch and type inference
- `ServiceContext` - Base context passed to service methods
- `TypedServiceContext<R>` - `ServiceContext` plus typed `ctx.call`
- `RegistryCaller<R>` - Typed caller derived from a service registry
- `ServiceDescriptor` - Declarative service call specification
- `ctx.call` - Imperative service composition from routes or other services

## Basic Service Definition

A service is a plain object of async methods. Each method receives `params` and a `ctx`:

```typescript
// services/user.service.ts
import { defineService } from "@taujs/server/config";

export const UserService = defineService({
  getUser: async (params: { id: string }, ctx) => {
    ctx.logger?.info({ userId: params.id }, "Fetching user");

    const user = await db.users.findById(params.id);

    if (!user) {
      throw new Error(`User ${params.id} not found`);
    }

    return { user };
  },

  listUsers: async (params: { limit?: number }, ctx) => {
    const users = await db.users.findMany({
      limit: params.limit ?? 10,
    });

    return { users };
  },
});
```

**Service methods receive:**

1. `params` - Parameters passed by the caller
2. `ctx` - Context with logging, tracing, auth, cancellation, and optional composition

**Service methods must return:**

- Plain JSON-serialisable objects
- Never primitives
- Never class instances

τjs serialises results for SSR hydration; primitives and class instances don't round-trip cleanly across the server/client boundary.

## Service Registry

Register all services in one place. The registry shape drives all type inference downstream - no separate type declarations needed:

```typescript
// services/index.ts
import { defineServiceRegistry } from "@taujs/server/config";
import { UserService } from "./user.service";
import { ProductService } from "./product.service";
import { OrderService } from "./order.service";

export const serviceRegistry = defineServiceRegistry({
  UserService,
  ProductService,
  OrderService,
});
```

Pass the registry when creating your server:

```typescript
// server/index.ts
import { createServer } from "@taujs/server";
import { serviceRegistry } from "./services";
import config from "./taujs.config";

await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "./client",
});
```

## Using Services from Routes

Two ways to call services from route handlers:

### 1. ServiceDescriptor (Declarative)

Return a descriptor object and τjs will call the service for you:

```typescript
// taujs.config.ts
{
  path: "/users/:id",
  attr: {
    render: "ssr",
    data: async (params) => ({
      serviceName: "UserService",
      serviceMethod: "getUser",
      args: { id: params.id },
    }),
  },
}
```

**What happens:**

1. The route handler returns the descriptor
2. τjs looks up `UserService` in the registry
3. τjs calls `UserService.getUser({ id: params.id }, serviceContext)`
4. The result flows to the renderer

Use this when a route maps directly to a single service call with no coordination logic.

### 2. ctx.call (Imperative)

Call services directly inside the route handler when you need to coordinate multiple calls or apply logic between them:

```typescript
// taujs.config.ts
{
  path: "/users/:id",
  attr: {
    render: "ssr",
    data: async (params, ctx) => {
      const user = await ctx.call("UserService", "getUser", { id: params.id });
      const posts = await ctx.call("PostService", "getUserPosts", {
        userId: params.id,
      });

      return { user, posts };
    },
  },
}
```

Prefer `ServiceDescriptor` for simple mappings. Prefer `ctx.call` when the route needs to coordinate, transform, or conditionally fetch data.

## ServiceContext

Every service method receives a base `ServiceContext`:

```typescript
import type { ServiceContext } from "@taujs/server/config";

type ServiceContext = {
  signal?: AbortSignal;
  deadlineMs?: number;
  traceId?: string;
  logger?: Logs;
  user?: {
    id: string;
    roles: string[];
  } | null;
};
```

`ServiceContext` is intentionally the base context only.

If you want typed service-to-service composition, use `TypedServiceContext<R>`:

```typescript
import type { TypedServiceContext } from "@taujs/server/config";
import type { serviceRegistry } from "./services";

type AppServiceContext = TypedServiceContext<typeof serviceRegistry>;
```

## Augmenting ServiceContext

Augment `ServiceContext` with your own app-specific fields:

```typescript
// src/taujs-types.d.ts
declare module "@taujs/server/config" {
  interface ServiceContext {
    tenantId?: string;
    requestStartMs?: number;
  }
}
```

Use this for shared context fields your application adds at runtime.

> Do not augment `ServiceContext.call` directly.
>
> If you want a typed `ctx.call`, use `TypedServiceContext<R>`.
> Augmenting `call` with `RegistryCaller<typeof serviceRegistry>` creates circular type relationships in real applications.

## Using Context

```typescript
export const UserService = defineService({
  updateUser: async (params: { id: string; name: string }, ctx) => {
    ctx.logger?.info({ userId: params.id }, "Updating user");

    if (!ctx.user) {
      throw new Error("Authentication required");
    }

    if (ctx.user.id !== params.id && !ctx.user.roles.includes("admin")) {
      throw new Error("Unauthorised");
    }

    if (ctx.signal?.aborted) {
      throw new Error("Request cancelled");
    }

    const user = await db.users.update({
      where: { id: params.id },
      data: { name: params.name },
    });

    return { user };
  },
});
```

## Working with Deadlines

Use `withDeadline` to combine a parent signal with a timeout:

```typescript
import { withDeadline } from "@taujs/server/config";

export const UserService = defineService({
  slowOperation: async (params: { id: string }, ctx) => {
    const timeoutSignal = withDeadline(ctx.signal, 5000);

    const response = await fetch(`https://api.example.com/slow/${params.id}`, {
      signal: timeoutSignal,
    });

    return await response.json();
  },
});
```

> **Abort reasons**
>
> `withDeadline` sets a structured reason on the abort signal:
>
> - If the parent aborts without a reason, τjs uses `Error("Aborted")`
> - If the deadline fires, τjs uses `Error("DeadlineExceeded")`
>
> Some APIs do not preserve `AbortSignal.reason` and will still throw a generic `AbortError` or `DOMException`. That does not change the timeout semantics.

## Service Composition

Services can call other services using `ctx.call`.

For service-to-service composition, prefer typing each service against the services it depends on rather than the full app registry. That avoids circular type inference while still giving full autocomplete and type checking.

```typescript
// services/order.service.ts
import { defineService } from "@taujs/server/config";
import type { TypedServiceContext } from "@taujs/server/config";
import { UserService } from "./user.service";
import { ProductService } from "./product.service";

type OrderServiceDeps = {
  UserService: typeof UserService;
  ProductService: typeof ProductService;
};

export const OrderService = defineService({
  getOrderDetails: async (
    params: { orderId: string },
    ctx: TypedServiceContext<OrderServiceDeps>,
  ) => {
    const user = await ctx.call("UserService", "getUser", { id: "user_123" });
    const products = await ctx.call("ProductService", "getProducts", {
      ids: ["p1", "p2"],
    });

    return { user, products };
  },

  getOrder: async (params: { id: string }, ctx) => {
    const order = await db.orders.findById(params.id);

    if (!order) {
      throw new Error(`Order ${params.id} not found`);
    }

    return { order };
  },
});
```

## Type-Safe Composition

`RegistryCaller<R>` is fully typed from a registry:

- Service names are checked
- Method names are checked per service
- Args are checked per method
- Return types are inferred

### App-Wide Typed Context

Once your registry exists, you can bind a context type to the full registry:

```typescript
// services/index.ts
import { defineServiceRegistry } from "@taujs/server/config";
import { UserService } from "./user.service";
import { ProductService } from "./product.service";
import { OrderService } from "./order.service";

export const serviceRegistry = defineServiceRegistry({
  UserService,
  ProductService,
  OrderService,
});
```

```typescript
// services/types.ts
import type { TypedServiceContext } from "@taujs/server/config";
import type { serviceRegistry } from "./index";

export type AppServiceContext = TypedServiceContext<typeof serviceRegistry>;
```

Now `ctx.call` is fully typed anywhere you use `AppServiceContext`:

```typescript
import type { AppServiceContext } from "./types";

declare const ctx: AppServiceContext;

const user = await ctx.call("UserService", "getUser", { id: "123" });
// service name  ^
// method name                  ^
// args type                                      ^
// result type is inferred from UserService.getUser
```

### Important

Use:

```typescript
declare module "@taujs/server/config" {
  interface ServiceContext {
    tenantId?: string;
  }
}
```

Do not use:

```typescript
declare module "@taujs/server/config" {
  interface ServiceContext {
    call: RegistryCaller<typeof serviceRegistry>;
  }
}
```

The second pattern creates circular type relationships and is not recommended.

## Validation with Parsers

Services support optional runtime validation using parser functions.

### Using Zod

```typescript
import { z } from "zod";
import { defineService } from "@taujs/server/config";

const UserCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  age: z.number().int().positive().optional(),
});

const UserCreateResultSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
});

export const UserService = defineService({
  createUser: {
    params: (input) => UserCreateSchema.parse(input),
    result: (output) => UserCreateResultSchema.parse(output),
    handler: async (params, ctx) => {
      const user = await db.users.create({
        email: params.email,
        name: params.name,
        age: params.age,
      });

      return { user };
    },
  },
});
```

> Parsers can be Zod schemas with `.parse(...)` or any synchronous function of shape `(u: unknown) => T`.
>
> Both `params` and `result` are optional.

## Error Handling

### Service Method Errors

Errors thrown in service methods are caught by τjs:

```typescript
export const UserService = defineService({
  getUser: async (params: { id: string }, ctx) => {
    const user = await db.users.findById(params.id);

    if (!user) {
      throw new Error(`User ${params.id} not found`);
    }

    return { user };
  },
});
```

### Structured Errors

Use `AppError` for structured framework-aware errors:

```typescript
import { AppError } from "@taujs/server/config";

export const UserService = defineService({
  getUser: async (params: { id: string }, ctx) => {
    const user = await db.users.findById(params.id);

    if (!user) {
      throw AppError.notFound(`User ${params.id} not found`);
    }

    return { user };
  },
});
```

## Testing Services

Services are plain async functions, so you can test them without HTTP or route setup.

### Testing a simple service

```typescript
import { describe, it, expect, vi } from "vitest";
import { UserService } from "./user.service";
import type { ServiceContext } from "@taujs/server/config";

describe("UserService", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function () {
      return this;
    }),
  };

  const ctx: ServiceContext = {
    traceId: "test-trace-id",
    logger: mockLogger,
  };

  it("returns user when found", async () => {
    const result = await UserService.getUser({ id: "123" }, ctx);

    expect(result.user).toBeDefined();
    expect(result.user.id).toBe("123");
    expect(mockLogger.info).toHaveBeenCalledWith(
      { userId: "123" },
      "Fetching user",
    );
  });
});
```

### Testing a composed service

```typescript
import { describe, it, expect, vi } from "vitest";
import { OrderService } from "./order.service";
import { UserService } from "./user.service";
import { ProductService } from "./product.service";
import type { TypedServiceContext } from "@taujs/server/config";

type OrderServiceDeps = {
  UserService: typeof UserService;
  ProductService: typeof ProductService;
};

describe("OrderService", () => {
  it("calls dependent services", async () => {
    const ctx: TypedServiceContext<OrderServiceDeps> = {
      call: vi.fn(async (service, method, args) => {
        if (service === "UserService" && method === "getUser") {
          return { user: { id: "user_123", name: "Alice" } };
        }

        if (service === "ProductService" && method === "getProducts") {
          return { products: [{ id: "p1" }, { id: "p2" }] };
        }

        throw new Error(`Unexpected call: ${service}.${method}`);
      }),
    };

    const result = await OrderService.getOrderDetails(
      { orderId: "order_123" },
      ctx,
    );

    expect(result.user.user.id).toBe("user_123");
    expect(result.products.products).toHaveLength(2);
  });
});
```

## Best Practices

### 1. Return serialisable objects only

```typescript
getUser: async (params, ctx) => {
  return {
    user: { id: "123", name: "Alice" },
    created: new Date().toISOString(),
  };
};
```

τjs serialises service results across the SSR boundary. Primitives and class instances don't round-trip cleanly - always wrap in an object.

### 2. Keep route handlers thin

Routes handle request/response concerns. Services handle business logic and data access. The boundary should be clear.

### 3. Type service dependencies locally

Inside a service, prefer:

```typescript
type OrderServiceDeps = {
  UserService: typeof UserService;
  ProductService: typeof ProductService;
};
```

over typing against the full registry while the registry is still being declared.

Inside a service, type `ctx` against only the services it directly depends on (`OrderServiceDeps`) rather than the full app registry. Use `AppServiceContext` only in app-level code written after the registry is fully defined.


### 4. Use TypedServiceContext<typeof serviceRegistry> after registry creation

Don't augment `ServiceContext.call.` It creates circular type relationships. Use `TypedServiceContext<R>` for typed composition.

For app-wide helpers, tests, or post-registry code, bind `TypedServiceContext` to the full registry.

<!--
## What's Next?

- [Authentication](/guides/authentication) - Access authenticated user in services
- [Logging & Telemetry](/guides/logging-telemetry) - Use structured logging effectively
- [Multi-App Architecture](/guides/micro-frontends) - Organise services in larger applications
-->
