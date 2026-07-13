---
title: Data Loading
description: How to load data for routes in τjs
---

τjs provides a route-first, declarative way to load data for SSR and streaming. This page builds on the request contract model / data ownership described earlier, but can be read independently.

## Overview

Data loading happens at the route level through the `attr.data` function. This function:

- Runs on the server
- Receives route parameters and request context
- Returns data that's injected into your page

## Basic Data Loading

```typescript
// taujs.config.ts
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params, ctx) => {
      const res = await fetch(`https://api.example.com/users/${params.id}`);
      return await res.json();
    }
  }
}
```

## Request Context

Your data handler receives a context object:

```typescript
type RequestContext = {
  traceId: string; // Request trace ID
  logger: Logger; // Scoped logger
  headers: Record<string, string>; // Request headers
};
```

**Example:**

```typescript
data: async (params, ctx) => {
  ctx.logger.info({ userId: params.id }, "Loading user");

  const res = await fetch(`/api/users/${params.id}`, {
    headers: {
      "x-trace-id": ctx.traceId,
      authorization: ctx.headers.authorization || "",
    },
  });

  return await res.json();
};
```

## Service Descriptors

Delegate to registered services for better separation:

```typescript
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params) => ({
      serviceName: 'UserService',
      serviceMethod: 'getUser',
      args: { id: params.id }
    })
  }
}
```

τjs calls the service automatically and returns the result. [See the Services section for further information](/guides/services).

## Rendering Modes

### SSR (Server-Side Rendering)

Data loads completely before rendering:

```typescript
{
  path: '/products',
  attr: {
    render: 'ssr',
    data: async () => {
      const products = await db.products.findAll();
      return { products };
    }
  }
}
```

**Characteristics:**

- Data fully available in `headContent`
- Complete HTML in single response
- Best for SEO-critical pages

**Performance tip:** For content that doesn't change per-user (marketing pages, documentation), you can combine SSR with edge caching to serve essentially static pages. See [Edge-Cached Static Pages](/guides/static-assets/#static-caching-pattern).

### Streaming SSR

Shell sent immediately, data may load progressively:

```typescript
{
  path: '/dashboard',
  attr: {
    render: 'streaming',
    meta: {  // Required for streaming
      title: 'Dashboard',
      description: 'User dashboard'
    },
    data: async () => {
      const metrics = await fetchMetrics();
      return { metrics };
    }
  }
}
```

**Characteristics:**

- Faster Time to First Byte
- Route `data` may not be ready when `headContent` runs - never depend on it for streamed heads
- Static `meta` is required (the fallback layer that survives degradation)
- For DYNAMIC head values, declare `attr.head` - its loader resolves before the shell and reaches
  `headContent` as `headData`

See [Head Management](/guides/head-management) for the full model (`meta` static, `attr.head`
dynamic) and the degradation taxonomy.

## Using Data on the Client

### SSR Store

Access server data in your components:

```typescript
// client/App.tsx
import { useSSRStore } from "@taujs/react";

export function App() {
  const data = useSSRStore<{ products: Product[] }>();

  return (
    <div>
      {data.products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
```

## Client-side updates after SSR

τjs only defines how data is loaded for the initial render (`attr.data`) and how that data is made available to your renderer (for example via `useSSRStore()`).

For updates after hydration (refreshing a dashboard, polling, user-triggered reloads), use standard client-side data fetching patterns (TanStack Query, SWR, custom hooks) against **explicit API or service endpoints**.

A common pattern is to reuse the same underlying “use case” or service logic in both places:

- `attr.data` calls into domain/service code for the initial render
- an `/api/*` endpoint calls the same domain/service code for client refresh
- the client fetches from `/api/*` using your preferred data library

This keeps SSR orchestration separate from client API concerns and avoids implicitly exposing server route logic to the browser.

## Advanced: RouteContext

- `attr.data(params, ctx)` enable you to fetch data.
- Components read that data via `useSSRStore<YourType>()`.

`RouteContext` exists for a narrower job: **making your renderer and `<head>` logic route-aware without the need of a client-side router**.

### What RouteContext gives you

Each request gets a `routeContext` object built from your `taujs.config.ts`, including things like:

- `appId`
- matched route definition (`path`, `attr`, etc.)
- `params`
- resolved data key (for debugging / telemetry)

You can thread that into `@taujs/react` so your renderer can do things like:

- tweak `<title>` / meta based on the matched route
- change logging / telemetry behaviour per route
- handle “families” of routes (e.g. all `/admin/*`) without bolting that logic into your components
- Zero client-side routing but still wanting route-aware rendering

### Wiring RouteContext into the renderer

```ts
// client/entry-server.tsx
import { createRenderer } from "@taujs/react";

import { AppBootstrap } from "./AppBootstrap";
import config from "../taujs.config";

import type { RouteContext } from "@taujs/server";

export const { renderSSR, renderStream } = createRenderer<
  Record<string, unknown>,
  RouteContext<typeof config>
>({
  appComponent: ({ location, routeContext }) => (
    <AppBootstrap location={location} routeContext={routeContext} />
  ),
  headContent: ({ data, meta, routeContext }) => {
    // `data` is resolved on ssr routes; for STREAMED heads read `headData`/`meta` instead
    // (see the head-management guide).
    const anyData = data as { title?: string; description?: string };

    const baseTitle =
      anyData.title ?? (meta.title as string | undefined) ?? "My App";

    const section = routeContext?.path.startsWith("/admin")
      ? " · Admin"
      : routeContext?.path.startsWith("/docs")
      ? " · Docs"
      : "";

    return `<title>${baseTitle}${section}</title>`;
  },
});
```

<!--
## What's Next?

- [Services](/guides/services) - Organise data access
- [Head Management](/guides/head-management) - Use data in `<head>` -->
