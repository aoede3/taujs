---
title: Platformatic Watt Integration
description: Using Platformatic Watt as a backend runtime and gateway for τjs applications
---

τjs can be used alongside Platformatic Watt with a clear separation of responsibility:

- **τjs** owns _request-time orchestration for pages_
- **Watt** owns _backend services, APIs, and database access_
- \*_HTTP is the integration boundary_

This page describes the **τjs-supported and recommended integration shape**: τjs remains the page orchestrator, and Watt is consumed as a backend API surface over HTTP.

τjs does **not** embed Watt, mirror its service topology, or participate in backend service discovery. Watt is treated as a backend runtime and gateway that exposes stable, documented endpoints.

---

## Responsibility Split

### τjs (Frontend / Page Orchestrator)

τjs is responsible for:

- Route matching and request handling
- Declaring page-level data dependencies
- Choosing rendering strategy (CSR / SSR / streaming)
- Cancelling work when the client disconnects
- Coordinating initial render data deterministically

τjs **does not**:

- Discover backend services
- Perform backend service composition
- Know about database structure
- Know about internal backend topology

### Platformatic Watt (Backend Runtime / Gateway)

Watt is responsible for:

- Running backend applications (DB apps, HTTP apps, and gateway-style aggregation)
- Exposing APIs (typically OpenAPI-described)
- Backend routing and composition behind a stable API surface
- Database access and migrations
- Backend operational concerns (logging, deployment, scaling)

Watt **does not**:

- Decide page rendering strategy
- Control SSR or streaming
- Participate in frontend orchestration
- Know about τjs routes or MFEs

---

## The Integration Shape

τjs integrates with Watt through a **single HTTP boundary**:

```

Browser
↓
τjs (page-level orchestration)
↓ HTTP
Watt (backend runtime / gateway)
↓
Backend services + databases

```

τjs calls **one or more stable HTTP endpoints** exposed by Watt.
This may be a single Watt application (for example, a DB app), or a Watt gateway that composes multiple backend applications.

τjs never calls internal backend services directly.

---

## Co-location and Process Supervision

Watt may also be used as the **process supervisor** that starts τjs for operational simplicity (single command, single deployment unit).

Co-location does **not** change the integration model:

- τjs still treats Watt as a backend API
- Communication remains HTTP-based
- No in-process calls or shared service internals are introduced

This preserves clear boundaries, consistent failure behaviour, and the ability to split τjs and Watt into separate deployments later without refactoring.

Performance concerns should be addressed by **reducing call count** (for example, one backend call per route), not by bypassing the HTTP boundary.

---

## τjs Services Calling Watt

τjs services treat Watt as a backend API, nothing more.

```ts
// services/user.service.ts
export const UserService = defineService({
  getUser: async (params: { id: string }, ctx) => {
    const res = await fetch(`${process.env.BACKEND_URL}/users/${params.id}`, {
      signal: ctx.signal,
      headers: {
        "x-request-id": ctx.requestId,
        "x-trace-id": ctx.traceId,
        authorization: ctx.headers.authorization,
      },
    });

    if (!res.ok) {
      throw new Error(`Backend error: ${res.status}`);
    }

    return res.json();
  },
});
```

Important properties of this approach:

- τjs does not know whether it is calling a single Watt app or a Watt gateway composing multiple backend apps
- τjs does not know how data is stored or retrieved
- τjs depends only on a documented HTTP contract

---

## Contract-First Integration

When using Watt, **OpenAPI should be treated as the backend contract**.

Recommended workflow:

```
Watt OpenAPI
  ↓
Generate TypeScript types
  ↓
τjs services
  ↓
τjs routes & components
```

Example:

```bash
npx openapi-typescript \
  http://backend-gateway/openapi.json \
  -o src/types/backend.ts
```

```ts
import type { paths } from "../types/backend";

type GetUserResponse =
  paths["/users/{id}"]["get"]["responses"][200]["content"]["application/json"];
```

This avoids schema drift and keeps frontend/backend coordination explicit.

---

## Aggregation: Pick One Layer

For any given route, aggregation happens in **exactly one place**.

### Option A: Aggregation in Watt (Recommended for SSR)

- Watt aggregates backend services internally
- τjs makes a single call per route
- Best for performance and simpler SSR

```ts
// τjs route (conceptual)
{
  path: '/dashboard/:userId',
  attr: {
    data: (params, ctx) =>
      ctx.call('DashboardService', 'getDashboard', params),
    render: 'streaming',
  },
}
```

### Option B: Aggregation in τjs

- τjs explicitly declares all backend calls
- Useful when orchestration itself is part of the page contract

```ts
// τjs route data handler (conceptual)
data: async (params, ctx) => {
  const [user, stats] = await Promise.all([
    ctx.call("UserService", "getUser", params),
    ctx.call("StatsService", "getStats", params),
  ]);

  return { user, stats };
};
```

**Rule:** Never aggregate in both layers for the same route.

---

## Request Context Propagation

τjs propagates a minimal request context to Watt:

- request / trace identifiers
- authentication headers
- locale or tenant headers (if applicable)

Watt may forward or derive additional context internally, but τjs is not aware of it.

Authentication and authorization decisions should terminate in the backend (Watt or downstream services). τjs treats authentication state as opaque request context.

Cancellation is handled via `AbortSignal`. When a client disconnects during SSR or streaming, τjs aborts in-flight backend calls.

---

## What Not to Do

### ❌ Don’t Mirror Backend Topology

```ts
// BAD: τjs knows internal backend services
fetch("http://user-service/internal/users");
fetch("http://profile-service/internal/profiles");
```

τjs should call **public Watt endpoints**, not internal service URLs.

### ❌ Don’t Duplicate Composition

- τjs fans out
- Watt also fans out
- The same aggregation happens twice

Pick one aggregation layer per route and be explicit.

### ❌ Don’t Share Orchestration Responsibility

If both layers try to decide what data is needed for a page, responsibility boundaries blur and the architecture will rot.

---

## When This Integration Makes Sense

Use τjs + Watt together when:

- You have multiple backend services
- You want OpenAPI-first backend development
- You want a backend gateway / BFF layer
- Frontend and backend are owned by different teams
- You want τjs focused on rendering and request authority

Don’t add Watt when:

- The backend is a small, stable monolith
- τjs is used purely for SSG - See [Edge-Cached Static Pages](/guides/static-assets/#static-caching-pattern)
- You already have a mature API gateway doing the same job

---

## Summary

τjs and Platformatic Watt can coexist cleanly

They must not share orchestration responsibility

HTTP is the boundary

OpenAPI is the backend contract

Aggregation happens in one layer per route

τjs orchestrates pages.
Watt runs backend services.
Anything else collapses responsibility boundaries and leads to fragile systems.

```

```
