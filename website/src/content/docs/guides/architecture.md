---
title: τjs' Architecture
description: How τjs structures rendering, orchestration, and build-time composition.
---

τjs is a **request-oriented orchestration system** for frontend applications.

It is not a framework in the traditional sense.
It does not attempt to optimise for local component ergonomics or hide system-level complexity.

Instead, τjs introduces **explicit authority boundaries** for:

- how data for initial render is loaded
- how rendering strategies are chosen
- how multiple applications are composed
- how systems degrade when orchestration is removed
  (i.e. τjs can be stepped out without collapsing the application)

The following explains those boundaries and why they exist.

---

## Core Problem τjs Solves

In many frontend systems, it becomes unclear **who owns the authority for what happens before first paint**.

Common failure modes include:

- components fetching data during SSR without the route knowing
- regressions appearing long after the change that caused them
- multiple teams contributing UI without a shared orchestration model
- debugging “what this route actually does” requiring reading the component tree
- SSR becoming fragile because orchestration is implicit

The root issue is not rendering - it is **ownership**.

τjs addresses this directly with a clearly defined server-side core layer, responsible for:

- request lifecycle ownership
- route-level orchestration
- data/service coordination
- rendering strategy selection

---

## Core Invariant

> **If data is required for first paint, it is declared at the route boundary.**

Not in components.  
Not in hooks.  
Not implicitly through composition.

Routes either:

- opt into orchestration explicitly
- or opt out explicitly

There is no silent fallback.

This invariant is the foundation for everything else τjs does.

---

## Request-Owned Orchestration

In τjs, the **request** is the unit of authority.

The route declares:

- what data is needed for initial render
- how that data is obtained
- whether hydration occurs
- the output policy: SSR, streaming SSR, or CSR  
  _(a rendering decision, not an orchestration decision)_

Components do not decide what runs before first paint.  
They consume what the request already owns.

### Without request ownership

```ts
function UserProfile({ id }) {
  const { data } = useQuery(["user", id], fetchUser);
  return <div>{data.name}</div>;
}

app.get("/users/:id", (req, res) => {
  res.render(<UserProfile id={req.params.id} />);
});
```

- orchestration emerges from component usage
- the route has no visibility
- SSR behaviour is implicit
- waterfalls are easy to introduce

### With τjs

```ts
// taujs.config.ts
{
  path: "/users/:id",
  attr: {
    data: async (params) => ({
      serviceName: "UserService",
      serviceMethod: "getUser",
      args: { id: params.id },
    }),
    render: "ssr",
  },
}
```

```ts
function UserProfile() {
  const { user } = useSSRStore();
  return <div>{user.name}</div>;
}
```

- orchestration is explicit
- SSR behaviour is declarative
- the route owns responsibility
- components are consumers, not decision-makers

This is not about preventing client-side fetching.
It is about **making initial render orchestration visible and attributable**.

The service descriptor shown above is resolved by the service registry:

- [Services](/guides/services)
- [Request contracts and data ownership](/guides/request-contracts)
- [Data Loading](/guides/data-loading)

---

## Build-Time Microfrontend Composition

Request orchestration is one pillar of τjs.
**Build-time microfrontend composition** is the other.

They solve different problems.

### Coordinated Multi-App Architecture

τjs treats applications as coordinated build units with shared routing, not as runtime fragments or npm packages.

Unlike runtime federation (Module Federation, import maps) or package-based sharing, τjs apps:

- Build together to ensure compatibility
- Deploy as one coordinated artifact
- Route at the HTTP layer

Each app maintains its own bundle, but the build process coordinates their integration.

τjs coordinates route configuration, rendering strategies, and security policies across apps - not just code compilation.

**τjs build-time MFEs (coordinated apps):**

```typescript
// taujs.config.ts
apps: [
  { appId: "customer", entryPoint: "app" }, // Separate app
  { appId: "admin", entryPoint: "admin" }, // Separate app
];
```

Apps are coordinated at build time, routed at request time.

---

### What build-time MFEs are for

Build-time MFEs exist when you need any of:

- multiple frontend applications with independent deployment
- multiple frontend teams owning separate codebases
- independent release cadences
- a shared URL surface
- consistent infrastructure (security, telemetry, rendering)
- variation by tenant, region, or feature flag
- determinism at deploy time, not runtime

This is not about rendering performance.
It is about **organisational boundaries**.

- [Build / Deployment](/guides/build-deployment)

---

### Why not runtime federation?

Runtime federation composes applications **in the browser**, meaning multiple independently deployed apps can end up sharing a single runtime graph (dependencies, globals, and service clients).

A concrete failure mode is **behavioural contract drift under shared composition**:

- Team A deploys App A that upgrades the auth or service client to:

  - refresh credentials on `401` and retry

- Team B deploys App B that still expects:

  - `401` to trigger a logout flow

- Both apps are loaded through runtime composition.
- The effective behaviour can depend on load order, caching, and which bundle initialises first.

Result: users experience intermittent “you’ve been logged out” flows mid-session, even though no token expired - because production behaviour becomes **order-dependent**, not explicitly defined.

Build-time composition moves this failure earlier:
incompatible combinations fail in CI/build, producing deployable artifacts with a known, testable contract surface.

---

### What τjs composes at build time

τjs treats applications as **build units**, not runtime fragments.

At build time, you define:

- which apps exist
- which routes they participate in
- which variants may apply (tenant, flag, region)
- which combinations produce deployable artifacts

The output is a **finite, testable set of artifacts** with known behaviour.

No runtime negotiation.
No dynamic assembly.
No indeterminate graphs.

- [Micro-Frontends](/guides/micro-frontend)

---

## τjs Works at Any Scale

τjs’ model scales down cleanly.

If you:

- SSR a single route
- want visibility into what it loads
- want to control hydration explicitly
- want the option to grow later without rewriting

You still benefit.

Using τjs for one route is still a win.

The system is:

- route-scoped
- opt-in
- incremental

You can stop at any point.

---

## Failure Modes (Explicitly)

τjs does not prevent misuse.

If teams:

- bypass route orchestration
- fetch data in components for first paint
- treat contracts as optional
- hide orchestration behind abstractions

Nothing breaks.

You simply lose:

- observability
- auditability
- coordination clarity

τjs will not stop you.
It will just stop helping you.

---

## Exit Cost Is Minimal

If you decide to remove τjs from your codebase:

- **Routes** become plain Fastify route handlers
- **SSR** is handled by your existing React entry-server (or CSR if preferred)
- **Data** reverts to direct service calls or component-level fetching
- **Orchestration** disappears

Service implementations remain unchanged.
Components remain unchanged.
Business logic remains unchanged.

You lose the orchestration layer, not your application.

There is no runtime lock-in.

---

## When τjs Adds Cost Without Benefit

τjs is not a universal default.

It adds cost if you:

- have a small app with no coordination pressure
- want maximum component autonomy
- do not care about SSR behaviour consistency
- are optimising purely for speed of iteration

In those cases, don’t use it.

---

## What to Read Next

**If this model resonates:**

- [Data Loading](/guides/data-loading)
- [Services](/guides/services)
- [Micro-Frontends](/guides/micro-frontend)
- [Getting Started](/guides/getting-started)

**If it doesn’t, that’s fine too.**

τjs exists to make responsibility explicit.
It is a pattern enforcer, not a runtime dependency.
