---
title: App Shell Architecture in τjs
description: A practical guide to building an app-shell–style system using τjs as it exists today
---

An **app shell** is a single React application that:

- Provides **global chrome**: header, footer, navigation, layout.
- Owns **client-side routing** (React Router, TanStack Router, custom router).
- Controls **global state** (auth, theme, user, feature flags, etc.).
- Loads “feature sections” inside it based on the current path.

**Key point:**
An app shell in τjs is still _one app_ from the server’s point of view. τjs does SSR/Streaming/etc. exactly once at the top level; the shell renders the rest.

---

## Directory Layout

A minimal shell structure looks like:

```
project/
  taujs.config.ts
  client/
    shell/
      entry-server.tsx
      entry-client.tsx
      AppShell.tsx
      router.tsx
      features/
        home/
        admin/
  server/
    index.ts
    templates/
      index.html
```

The shell owns the UI. τjs owns the server orchestration.

---

## τjs Config for an App Shell

A shell is usually served by **a single τjs app** with a wildcard route.

```ts
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";
import { pluginReact } from "@taujs/react/plugin";

export default defineConfig({
  server: {
    host: "localhost",
    port: 5173,
  },

  apps: [
    {
      appId: "shell",
      entryPoint: "", // root folder under client/
      plugins: [pluginReact()],
      routes: [
        {
          path: "/*",
          attr: {
            render: "ssr",
            hydrate: true,
            meta: { title: "My τjs App Shell" },
          },
        },
      ],
    },
  ],
});
```

- one app,
- one wildcard route,
- SSR + hydration.

τjs renders the shell; the shell renders your UI.

---

## Shell Entry Points

### entry-server.tsx

```tsx
// client/shell/entry-server.tsx
import React from "react";
import { createRenderer } from "@taujs/react";
import { AppShell } from "./AppShell";

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <AppShell location={location} />,
  headContent: ({ data }) => `
    <title>${(data as any)?.title ?? "My τjs App"}</title>
  `,
});
```

### entry-client.tsx

```tsx
// client/shell/entry-client.tsx
import React from "react";
import { hydrateApp } from "@taujs/react";
import { AppShell } from "./AppShell";

hydrateApp({
  appComponent: <AppShell location={window.location.href} />,
});
```

Everything inside `AppShell` is yours to structure.

---

## The App Shell Component

```tsx
// client/shell/AppShell.tsx
import React from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

export function AppShell({ location }: { location: string }) {
  return (
    <div className="app-shell">
      <header>
        /* nav, user menu, etc. */
        <p>
          Current location: <strong>{location}</strong>
        </p>
      </header>

      <main>
        <RouterProvider router={router} />
      </main>

      <footer>© {new Date().getFullYear()}</footer>
    </div>
  );
}
```

## Routing Inside the Shell

τjs can deal with whatever router you use - it just SSRs your React tree.

```tsx
// client/shell/router.tsx
import { createBrowserRouter } from "react-router-dom";
import { HomePage } from "./features/home/HomePage";
import { AdminPage } from "./features/admin/AdminPage";

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/admin", element: <AdminPage /> },
]);
```

Because of the wildcard route in τjs config (`/*`), all navigation happens _inside the shell_.

> τjs handle SSR directly with React primitives within the `@taujs/react` package. There is no requirement to call router server API's

---

### A Note on Router “Server APIs”

Some routers (React Router, TanStack Router, others) expose **server-only APIs** such as:

- “static handler” functions,
- data-loader execution on the server,
- route-level data resolution before rendering.

Those patterns assume:

1. the router itself performs routing on the server,
2. the router resolves data,
3. the router decides what to render.

τjs **does not follow that model**.

#### Why router server APIs don’t apply in τjs

τjs already handles route matching and data orchestration at the **server layer**-before your React tree is even created.

Your server entry receives:

- a unified `location`,
- a fully resolved `RouteContext`,
- an SSR store if you’re using one,
- and your renderer simply returns a **React element tree**.

At that point:

- React is the only thing doing SSR,
- τjs streams the result,
- no router server helpers are used or expected.

#### You _can_ use routers - just as components

Routers work perfectly well inside τjs, but only in the **component tree**, the same way they would in any React app:

- On the server: render your router component inside your `<AppShell />`.
- On the client: hydrate the same component tree.

Router choice is entirely yours. τjs stays agnostic.

> **Use routers as UI components, not as part of your server framework.**

---

## What τjs Still Gives You - Even With a Shell

Even in app-shell mode, τjs provides system-level orchestration the client can’t:

### Per-route render control

You can override rendering modes at the server:

```ts
routes: [
  { path: "/admin/*", attr: { render: "stream", hydrate: true } },
  { path: "/marketing/*", attr: { render: "ssr", hydrate: false } },
];
```

The shell stays the same - τjs changes the streaming/SSR/hydration mode.

### CSP & security integration

τjs handles nonce injection and CSP header generation across SSR + streaming.

### Static assets setup without the boilerplate

Your existing `registerStaticAssets` option lets you plug in your own static handler (like `@fastify/static`) without wiring errors.

### Full SSR and Streaming SSR

Shell rendering works identically whether:

- you choose SSR,
- or React streaming (`renderToPipeableStream`).

### Migration path to multi-app

If you grow out of a monolithic shell, you can easily slice routes into separate τjs apps _without rewriting the server_:

```ts
apps: [
  {
    appId: "shell",
    entryPoint: "",
    plugins: [pluginReact()],
    routes: [
      {
        path: "/*",
        attr: {
          render: "ssr",
          hydrate: true,
        },
      },
    ],
  },
  {
    appId: "admin",
    entryPoint: "admin",
    plugins: [pluginReact()],
    routes: [
      {
        path: "/admin/*",
        attr: {
          render: "ssr",
          hydrate: true,
        },
      },
    ],
  },
];
```

View τjs' [Micro-Frontends](/guides/micro-frontend/) on how to create isolated micro-frontends in your τjs system

---

## When You Should _Not_ Use an App Shell

An app shell is **not** ideal when:

- teams want to deploy independently,
- routes need different caching/static/edge semantics,
- you want per-route isolation (errors, state, runtime),
- or you need a migration path to multiple MFEs.

In those cases, τjs’s **app-per-boundary design** is a better fit:

```
apps/
  marketing/
  admin/
  shop/
```

Each independently built, deployed, and orchestrated.

## Migrating from an Existing SPA/App Shell to τjs

Start with your existing setup:

- a single SPA or Vite/CRA/Next app,
- a large router tree,
- one global “shell” handling layout, state, and navigation.

The migration path into τjs is intentionally incremental. You don’t rewrite
your system - you _strangle_ it route by route.

This section outlines a **gradual path** into τjs using your existing
app-shell structure as a stepping stone. It’s effectively the
_strangler fig pattern_ applied at the frontend route level:

- the shell runs unchanged at first,
- τjs takes over server orchestration,
- specific routes can be carved out into their own τjs apps over time,
- the old shell shrinks naturally as new boundaries emerge.

No big bang. Just progressive extraction.

### Step 1 - Wrap your existing app as a τjs shell

If you already have a SPA with an `App` component and client-side routing, the first step is simply:

1. Move your app under `client/shell/`.
2. Add a τjs config with a single app + wildcard route.
3. Introduce `entry-server.tsx` and `entry-client.tsx` as shown above.

At this point:

- Runtime behaviour is basically unchanged (still one shell, still CSR/SSR depending on what you choose).
- You get τjs’s SSR/streaming/CSP/static-asset plumbing.
- There is still **one deployment unit**.

You haven’t “gone micro” yet. You’re just running your existing SPA under τjs.

### Step 2 - Start using route-level rendering control

Once you’re comfortable with τjs doing the SSR, you can start exploiting what it offers **without changing your client code**.

For example:

```ts
// taujs.config.ts
routes: [
  {
    path: "/",
    attr: { render: "ssr", hydrate: true },
  },
  {
    path: "/marketing/*",
    attr: { render: "ssr", hydrate: false }, // cacheable, static-ish
  },
  {
    path: "/admin/*",
    attr: { render: "streaming", hydrate: true }, // fast TTFB, streaming
  },
];
```

The shell still owns routing and layout and τjs enables orchestration in a single app:

- where you stream,
- where you SSR once,
- where you behave similarly to SSG. See [Edge-Cached Static Pages](/guides/static-assets/#static-caching-pattern).

### Step 3 - Identify natural app boundaries

Generally there will be natural seams:

- `/admin` vs `/`
- `/shop` vs `/support`
- partner / tenant / brand-specific areas

These are the places where:

- different teams may work,
- different release cadences exist,
- different uptime/SLO/security requirements apply.

Those are your **τjs app boundaries**.

### Step 4 - Split one area into its own τjs app

Take one area, e.g. `/admin`, and create a new app:

```ts
// Before - single shell app
apps: [
  {
    appId: "shell",
    entryPoint: "",
    plugins: [pluginReact()],
    routes: [{ path: "/*", attr: { render: "ssr", hydrate: true } }],
  },
];
```

```ts
// After - shell + admin apps
apps: [
  {
    appId: "shell",
    entryPoint: "",
    plugins: [pluginReact()],
    routes: [
      { path: "/", attr: { render: "ssr", hydrate: true } },
      { path: "/marketing/*", attr: { render: "ssr", hydrate: false } },
    ],
  },
  {
    appId: "admin",
    entryPoint: "admin",
    plugins: [pluginReact()],
    routes: [{ path: "/admin/*", attr: { render: "ssr", hydrate: true } }],
  },
];
```

You then:

- move the admin-related client code under `client/admin/`,
- add `entry-server.tsx` + `entry-client.tsx` for `admin`,
- keep using the same server, same build command, same deployment.

From the outside:

- `/admin` now comes from a **different app**,
- it can be built, tested, and deployed independently,
- **no rewrite of the shell is required**.

### Step 5 - Continue as the system grows

You can repeat step 4 for other boundaries:

- `/shop/*` → own app
- `/support/*` → own app

Each time you split:

- move a slice of your shell’s responsibilities into an explicit `appId`,
- build it as its own τjs app,
- let τjs orchestrate requests between them.

and move towards:

- a smaller app shell (maybe just public marketing),
- several clearly-bounded apps (admin, shop, support),
- all behind **one τjs server** and τjs configuration.

### What you end up with

By following this path:

- You **start** with your existing SPA/shell (low risk).
- You gain τjs’s **server-side orchestration** immediately.
- You gradually move to a **multi-app, per-boundary model** where needed.
- No need for a “big bang rewrite”.
