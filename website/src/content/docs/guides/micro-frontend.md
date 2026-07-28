---
title: Micro-Frontends
description: How τjs composes separately built applications through Fastify routes
---

A τjs system can contain several frontend applications without adding a browser-side shell or a
module-federation runtime. Each application has its own renderer, client build and SSR build.
Fastify selects the application at the HTTP route boundary.

That gives the model a few firm properties:

- one response is rendered by one configured application and one renderer
- each application produces its own client and SSR artefacts
- application routes are ordinary Fastify routes
- applications do not share a browser memory space across document navigations
- shared code is bundled through normal imports, not loaded from another application at runtime

## Declaring applications

Every application declares its renderer, entry point and routes:

```ts
// taujs.config.ts
import { reactRenderer } from "@taujs/react/renderer";
import { defineConfig } from "@taujs/server/config";
import { solidRenderer } from "@taujs/solid/renderer";

export default defineConfig({
  apps: [
    {
      appId: "customer",
      entryPoint: "customer",
      renderer: reactRenderer({ project: "./tsconfig.json" }),
      routes: [
        { path: "/app", attr: { render: "ssr" } },
        { path: "/app/*", attr: { render: "ssr" } },
      ],
    },
    {
      appId: "admin",
      entryPoint: "admin",
      renderer: solidRenderer({ project: "./tsconfig.solid.json" }),
      routes: [
        {
          path: "/admin",
          attr: {
            render: "ssr",
            middleware: { auth: { roles: ["admin"] } },
          },
        },
        {
          path: "/admin/*",
          attr: {
            render: "ssr",
            middleware: { auth: { roles: ["admin"] } },
          },
        },
      ],
    },
  ],
});
```

The exact route owns the bare prefix. The terminal wildcard owns URLs below it. Fastify performs
concrete route dispatch, then τjs applies the selected application's data, policy and renderer
contract.

Authentication metadata is application data for your Fastify `authenticate` decorator to enforce.
See [Authentication](/guides/authentication/) for that boundary.

## Project layout

The default layout keeps applications and framework-neutral shared code separate:

```text
src/
├── client/
│   ├── customer/
│   │   ├── entry-client.tsx
│   │   ├── entry-server.tsx
│   │   └── App.tsx
│   └── admin/
│       ├── entry-client.tsx
│       ├── entry-server.tsx
│       └── App.tsx
├── server/
│   ├── index.ts
│   └── services/
└── shared/
    ├── contracts/
    ├── design-tokens/
    └── utilities/
taujs.config.ts
```

This is a convention, not a workspace requirement. `clientBaseDir`, entry points and aliases can be
configured when a repository needs another layout.

## Build outputs

Your build script calls `taujsBuild()`. A normal project exposes that script through commands such as
`npm run build:client` and `npm run build:ssr`.

Each application is built separately:

```text
dist/
├── client/
│   ├── customer/
│   │   ├── assets/
│   │   └── manifest.json
│   └── admin/
│       ├── assets/
│       └── manifest.json
└── ssr/
    ├── customer/
    │   └── server.js
    └── admin/
        └── server.js
```

Separate builds mean each application has its own import graph. Code imported by two applications
may appear in both outputs. τjs does not create a cross-application shared chunk or a runtime that
coordinates those chunks.

### Selective builds and deployment schedules

A build can target an `appId` or `entryPoint`:

```bash
node scripts/build.mjs --app admin
TAUJS_APPS=customer,admin node scripts/build.mjs
```

This supports per-application CI jobs when applications change at different rates. It is important
to distinguish a selective build from an independently deployable release:

- client builds clean `dist/` before producing their selected outputs
- the running server expects the client and SSR artefacts for every configured application it may
  serve
- independent deployment therefore needs an artefact pipeline that assembles and publishes the
  required per-application outputs together

Without that assembly step, build and deployment remain coordinated. See
[Build & Deployment](/guides/build-deployment/#build-a-single-app-cli) for the complete filter and
output behaviour.

## Navigation boundaries

### Within one application

Client routing is available by omission. A URL omitted from `taujs.config.ts` is not a server-owned
request contract; once the application's shell is served, its client router can own that URL.

The shell still needs an HTTP owner:

- a τjs-created host provides the implicit application-shell fallback
- a caller-owned Fastify host needs a declared terminal wildcard such as `/app/*` for τjs to own
  unmatched client URLs

See [Request Contracts & Data](/guides/request-contracts/#undeclared-urls-and-client-routing) and
[Host Ownership](/guides/host-ownership/#application-shell-and-unmatched-urls).

### Between applications

A link from `/app/orders` to `/admin/users` is a document navigation. The server selects a different
application and the browser starts that application's client runtime. In-memory state, active
component trees, WebSockets and uncommitted UI state do not cross that boundary.

Use ordinary links for cross-application navigation:

```html
<a href="/admin/users">Admin</a>
```

If a seam cuts through state that must remain alive, the seam is in the wrong place. Move the
boundary rather than introducing a client orchestrator solely to preserve that state.

## Making document navigation feel continuous

Full-document navigation does not require a white flash or a browser-side application shell.
Platform features can progressively improve the transition while preserving the request boundary.

### Cross-document view transitions

Enable navigation transitions in shared CSS and give stable chrome the same
`view-transition-name` in each application:

```css
@view-transition {
  navigation: auto;
}

.site-header {
  view-transition-name: site-header;
}
```

Supporting browsers animate the document change. Other browsers perform the same normal navigation
without the animation. Keep names unique within each rendered document.

### Prefetch and speculation

Links between known application boundaries can be prefetched or prerendered with browser speculation
rules. Treat this as progressive enhancement: the server route and streamed response remain the
correct path when speculation is unavailable or cancelled.

Do not use either feature to imply state continuity. They improve delivery and presentation, not the
ownership model.

## Shared code and shared state

These are different concerns:

| Concern | Behaviour |
| --- | --- |
| Shared source module | Imported and built into each consuming application |
| Browser store instance | Private to the current application document |
| Non-sensitive preference | May be restored from browser storage |
| Session or authoritative state | Re-established from the server on the next request |
| Critical or deferred route data | Owned by one response and one selected application |

Read [Dependency Management](/guides/dependency-management/) for import and bundle behaviour, and
[Shared State Management](/guides/shared-state-management/) for safe persistence choices.

## Choosing an application boundary

A separate application is useful when a URL area has a distinct renderer, delivery cadence, policy
boundary or team ownership and can tolerate document navigation at the seam.

Keep routes in one application when they need continuous in-memory state, shared live connections or
frequent transitions where a document boundary would be artificial. τjs supports several
applications, but it does not require every organisational boundary to become one.
