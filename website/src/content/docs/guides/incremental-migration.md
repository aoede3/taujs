---
title: Incremental Migration
description: Adopt τjs and change UI renderers without rewriting every architectural layer at once.
---

τjs lets you evolve an application along two separate axes:

- **Architecture** - move initial-response data, services, policy and rendering decisions to the request boundary.
- **UI renderer** - keep React, or move an application boundary to Vue or Solid.

Those changes do not have to happen together. You can put τjs around an existing application while retaining its component tree and client-side data fetching, then introduce request contracts only where they provide value. You can also move a route or URL area to another renderer without rebuilding the service and policy layer that supplies it.

This guide explains the boundaries that make that migration incremental rather than magical.

## The important boundary: one renderer per app

In τjs, `renderer:` belongs to an **app**, not directly to a route.

```text
τjs server
├── storefront-react  → React renderer → /, /products/*
└── account-solid     → Solid renderer → /account/*
```

A route moves from React to Solid or Vue by moving into an app that declares that renderer. It does not acquire a `renderer` property of its own, and one app does not switch component frameworks during a request.

This has concrete consequences:

- each app has its own client and server entry points;
- each app has its own Vite build and browser bundle;
- React and Solid compiler projects must claim disjoint source trees;
- navigation between apps is a full document navigation;
- client-side routing and in-memory state remain local to each app.

The server, service registry, request policy and route-data model can remain shared. The UI implementation and bundle boundary are the parts that change.

## Choose one migration axis at a time

| Change | What can stay as it is |
| --- | --- |
| Put τjs around an existing app | Components, client router, query library, API endpoints and ordinary Vite plugins |
| Add a request contract | Renderer, component structure and post-hydration client fetching |
| Introduce mediated services | Route URL, renderer and component consumption |
| Change SSR to streaming | Renderer framework, service contract and route ownership |
| Move a URL area to another renderer | Services, auth/CSP policy, route-data shape and surrounding server |

Avoid changing all five in one slice. A smaller change gives you a meaningful parity check and a straightforward rollback.

## A practical migration sequence

The sequence below is deliberately optional. Stop when the architecture is providing enough value.

### 1. Establish a behavioural baseline

Before changing wiring, record the behaviour that must survive:

- URLs, status codes and redirects;
- authentication and CSP behaviour;
- rendered HTML and metadata;
- hydration and client navigation;
- API calls and error states;
- production assets and caching rules.

Use tests where the behaviour matters. A migration should not rely on two pages looking similar during a manual check.

### 2. Put τjs around the existing renderer

Keep the existing React, Vue or Solid component tree. Add the matching τjs renderer declaration and adapt the application's client/server entries using that renderer package's `hydrateApp()` and `createRenderer()` APIs.

For React:

```ts
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";
import { reactRenderer } from "@taujs/react/renderer";

export default defineConfig({
  apps: [
    {
      appId: "storefront-react",
      entryPoint: "storefront-react",
      renderer: reactRenderer({
        project: "./src/client/storefront-react/tsconfig.json",
      }),
      routes: [
        { path: "/", attr: { render: "ssr" } },
        { path: "/products/:id", attr: { render: "ssr" } },
      ],
    },
  ],
});
```

At this stage, route components may continue calling their existing APIs after hydration. You do not need to introduce `serviceData()`, a service registry or streaming merely to adopt the host.

The renderer contribution owns its framework compiler. Do not also add `pluginReact()`, `pluginVue()` or `pluginSolid()` to the app's `plugins` array. Ordinary, unrelated Vite plugins remain supported there.

See the [React](/renderers/react), [Vue](/renderers/vue) or [Solid](/renderers/solid) guide for the framework-specific entry files.

This is still a real integration boundary, not a wrapper around arbitrary browser code. Every declared app needs a valid server render module. Before declaring `ssr` or `streaming`, make browser-only component code safe to evaluate on the server, and keep any data work not yet migrated explicitly client-side so it does not silently begin during SSR.

### 3. Introduce a request contract on one route

Choose a route whose initial state is important for SEO, first paint, policy or operational visibility. Move only that initial read to `attr.data`:

```ts
{
  path: "/products/:id",
  attr: {
    render: "ssr",
    data: serviceData("catalogue", "getProduct", ({ id }) => ({
      id: String(id),
    })),
  },
}
```

The renderer consumes the resolved initial state through its SSR store. Polling, mutations, user-triggered refreshes and other post-hydration work can continue through the existing client query library and explicit API endpoints.

You are moving ownership of the **initial response**, not replacing the application's client data layer.

### 4. Mediate service access when it pays off

`attr.data` may remain an ordinary function. Introduce the service registry later when named service edges, shared request context, tracing or consistent failure handling justify it.

```ts
data: async ({ id }, ctx) => {
  return ctx.call("catalogue", "getProduct", { id: String(id) });
};
```

This is an architectural migration independent of the renderer. The same service can supply React today and Solid later.

See [Services](/guides/services) and [Request contracts and data ownership](/guides/request-contracts).

### 5. Change rendering strategy independently

Once a route's critical initial state is explicit, you can evaluate rendering separately from framework migration:

```ts
{
  path: "/products/:id",
  attr: {
    render: "streaming",
    meta: { title: "Product" },
    data: serviceData("catalogue", "getProduct", ({ id }) => ({
      id: String(id),
    })),
  },
}
```

Changing `ssr` to `streaming` changes response delivery. It does not require a new service contract or a different component framework.

Likewise, `hydrate: false` is a route-level delivery decision. Verify that the route genuinely needs no client application before disabling hydration.

### 6. Move a route boundary to another renderer

When a route or coherent URL area is ready for a UI rewrite, create a second app and move route ownership to it:

```ts
import { defineConfig } from "@taujs/server/config";
import { reactRenderer } from "@taujs/react/renderer";
import { solidRenderer } from "@taujs/solid/renderer";

import { serviceData } from "./src/server/services/registry.ts";

export default defineConfig({
  apps: [
    {
      appId: "storefront-react",
      entryPoint: "storefront-react",
      renderer: reactRenderer({
        project: "./src/client/storefront-react/tsconfig.json",
      }),
      routes: [
        { path: "/", attr: { render: "ssr" } },
        {
          path: "/products/:id",
          attr: {
            render: "ssr",
            data: serviceData("catalogue", "getProduct", ({ id }) => ({
              id: String(id),
            })),
          },
        },
      ],
    },
    {
      appId: "account-solid",
      entryPoint: "account-solid",
      renderer: solidRenderer({
        project: "./src/client/account-solid/tsconfig.json",
      }),
      routes: [
        {
          path: "/account/:section?",
          attr: {
            render: "ssr",
            middleware: { auth: { roles: ["customer"] } },
            data: serviceData("accounts", "getAccount"),
          },
        },
      ],
    },
  ],
});
```

The new Solid app rewrites the view and its framework-specific entry points. The account service, auth policy and route-data contract stay at the request boundary.

Move the route; do not temporarily declare the same URL in both apps. Route ownership should remain unambiguous throughout the migration.

## Navigation across the migration seam

Applications are separate browser bundles. Navigate between them with a normal document link:

```html
<a href="/account/profile">Account</a>
```

That request returns the new app's HTML and assets. Cookies, server-side sessions and URL state continue normally; in-memory component state does not cross the boundary.

Within each app, keep using its normal client-side router. Do not use a React router link to pretend that a Solid-owned URL belongs to the React bundle, or vice versa.

If a route requires uninterrupted client state, shared in-shell navigation or components from both frameworks in one root, it is probably not a good migration seam yet. Prefer a larger URL boundary or keep it in the existing app until that coupling is removed.

## Keep existing client-side fetching

Migrating to τjs does not require every data dependency to become route-owned.

Keep client fetching for:

- user-triggered mutations;
- polling and live updates;
- data that depends on client-only state;
- interactions occurring after the initial response;
- routes where an explicit request contract would add more structure than value.

A useful intermediate state is:

```text
initial document data  → τjs route contract
subsequent reads       → existing query library + explicit API
mutations              → existing application endpoints
```

The important distinction is visible ownership, not purity.

## React and Solid compiler boundaries

React and Solid both use `.tsx` and `.jsx`, so a shared τjs project needs unambiguous source ownership.

- Give each React or Solid app a project file with a disjoint positive `include`.
- Do not make one compiler project broadly include another app's source directory.
- Point each `reactRenderer({ project })` or `solidRenderer({ project })` at its own project.
- Let the renderer contribution install the compiler plugin.

Vue remains a first-class renderer but does not participate in JSX ownership algebra; `vueRenderer()` supplies its own Vue plugin pack.

τjs runs these apps through one coordinated development server and build pipeline. A framework migration does not require starting one τjs server per app.

## Verify each migration slice

For every step, check the smallest relevant matrix:

| Area | Evidence |
| --- | --- |
| Route ownership | Each migrated URL resolves to exactly one app |
| Development | HMR and a newly created source file work in the owning app |
| Production | Client and SSR builds succeed and production boot serves the route |
| Rendering | HTML, status, metadata and render strategy match the intended change |
| Hydration | Interactive routes hydrate once; `hydrate: false` routes ship no app entry |
| Policy | Auth, CSP and redirects behave as before |
| Assets | The response references the owning app's bundle, not the previous renderer's |
| Data | Initial data is present once and post-hydration fetching does not duplicate it accidentally |
| Evidence | The request graph and live trace identify the expected app, route and service call |

The [MCP server](/reference/mcp) can inspect route ownership and live development traces, but it does not replace browser and production-build tests.

## What τjs does not migrate for you

τjs does not:

- translate React components into Vue or Solid components;
- preserve browser memory across an app boundary;
- make framework-specific UI libraries portable;
- switch renderers inside one component root;
- turn `renderer` into a per-route option;
- require every route to adopt request data or mediated services;
- replace application-specific client navigation, caching or mutation logic.

The promise is narrower and more useful: **τjs lets you evolve your UI boundary independently of your application architecture wherever those concerns are already separated - or separate them incrementally over time.**

## Choosing a good first seam

Good candidates include:

- an account or admin area with its own URL prefix;
- a marketing or documentation surface;
- a route with little shared in-memory client state;
- a domain already backed by a clear service contract;
- a page whose SSR or hydration behaviour is already covered by tests.

Avoid starting with:

- a modal or widget buried inside the existing root;
- a route that depends heavily on the old app's client store;
- a cross-app transition that must be seamless without a document navigation;
- the most operationally critical page before the new renderer path is proven.

The best first migration is a real boundary, not the smallest component you can extract.

## Related guides

- [Architecture](/guides/architecture)
- [Request contracts and data ownership](/guides/request-contracts)
- [Micro-frontends](/guides/micro-frontend)
- [Data Loading](/guides/data-loading)
- [Services](/guides/services)
- [Build and Deployment](/guides/build-deployment)
