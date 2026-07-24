---
title: Micro-Frontends
description: How τjs uses build-time orchestration for multiple frontend applications
---

τjs enables multiple frontend applications in a single deployment through **build-time composition** and **server-side routing**. Unlike runtime federation systems, τjs builds each application separately and routes requests at the HTTP layer.

**Key characteristics:**

- Each app has its own Vite build
- Each app has its own bundle
- Server routes requests to the correct app
- No runtime coordination between apps
- No shared runtime state

## How It Works

### Build Time

When you run `taujs build`:

1. **Vite builds each app separately**

   - Each `entryPoint` directory is built independently
   - Produces separate bundles with hashed filenames
   - Generates manifests for each app

2. **Assets organised per app**

```
   dist/client/
   ├── app/              # Customer app bundle
   │   ├── assets/
   │   ├── manifest.json
   │   └── index.html
   └── admin/            # Admin app bundle
       ├── assets/
       ├── manifest.json
       └── index.html
```

3. **Tree-shaking per app**
   - Vite analyses each app's imports
   - Only includes code that app uses
   - Shared dependencies optimised automatically

### Runtime

When a request arrives:

1. **Fastify receives request**

```
   GET /admin/users
```

2. **τjs matches route**

```typescript
   // Finds matching route in config
   {
     path: '/admin/:section',
     appId: 'admin'
   }
```

3. **Server loads correct app**

   - Reads `admin` app's manifests
   - Loads SSR bundle for admin app
   - Uses admin app's assets

4. **Response delivered**
   - HTML rendered with admin app code
   - Client receives only admin bundle
   - No customer app code sent

**No runtime coordination** - each request is independent.

## Configuration

Define multiple apps in your τjs config:

```typescript
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";

export default defineConfig({
  apps: [
    {
      appId: "customer",
      entryPoint: "app",
      routes: [
        {
          path: "/app/:feature?/:id?",
          attr: {
            render: "streaming",
            middleware: { auth: { strategy: "jwt" } },
          },
        },
      ],
    },
    {
      appId: "admin",
      entryPoint: "admin",
      routes: [
        {
          path: "/admin/:section?/:id?",
          attr: {
            render: "ssr",
            middleware: {
              auth: {
                strategy: "session",
                roles: ["admin", "superadmin"],
              },
            },
          },
        },
      ],
    },
    {
      appId: "docs",
      entryPoint: "docs",
      routes: [
        {
          path: "/docs/:slug*",
          attr: {
            render: "ssr",
            hydrate: true,
          },
        },
      ],
    },
  ],
});
```

## Project Structure

```
project/
├── client/
│   ├── app/                  # Customer application
│   │   ├── entry-client.tsx
│   │   ├── entry-server.tsx
│   │   ├── index.html
│   │   └── App.tsx
│   ├── admin/                # Admin application
│   │   ├── entry-client.tsx
│   │   ├── entry-server.tsx
│   │   ├── index.html
│   │   └── App.tsx
│   ├── docs/                 # Documentation application
│   │   ├── entry-client.tsx
│   │   ├── entry-server.tsx
│   │   └── index.html
│   └── shared/               # Shared code (optional)
│       ├── components/
│       ├── hooks/
│       └── utils/
├── server/
│   ├── index.ts
│   └── services/
└── taujs.config.ts
```

## Build Process Details

### What Happens During Build

```bash
npm run build
```

**For each app:**

1. **Client build** (`dist/client/{entryPoint}/`)

   - Vite scans `entry-client.tsx`
   - Bundles all imported code
   - Outputs hashed assets
   - Generates `manifest.json`

2. **SSR build** (`dist/ssr/{entryPoint}/`)

   - Vite scans `entry-server.tsx`
   - Bundles SSR-compatible code
   - Outputs `server.js`
   - Generates `ssr-manifest.json`

3. **Dependency resolution**
   - Shared dependencies (React) included in each bundle
   - Vite optimises bundle splitting automatically
   - No manual shared chunk configuration needed

## Bundle Optimisation

### Shared Dependencies

Dependencies appear in each app's bundle based on imports:

```typescript
// Customer app imports
import React from "react";
import { useQuery } from "@tanstack/react-query";

// Admin app imports
import React from "react";
import { create } from "zustand";
```

**Result:**

- Both bundles include React (shared dependency)
- Customer bundle includes react-query
- Admin bundle includes zustand
- No runtime coordination needed

### Tree-Shaking

Vite tree-shakes per app:

```typescript
// shared/utils.ts
export function formatDate(date: Date) {
  /* ... */
}
export function formatCurrency(amount: number) {
  /* ... */
}
export function parseJSON(str: string) {
  /* ... */
}
```

```typescript
// Customer app only imports formatDate
import { formatDate } from "@shared/utils";

// Customer bundle only includes formatDate
// formatCurrency and parseJSON are tree-shaken away
```

## Navigation Between Apps

### Full Page Navigation

Navigating between apps requires a full page load:

```typescript
// Customer app
<a href="/admin/users">Go to Admin</a>
// Full page load when clicked
```

**Why:** Different apps = different bundles. Browser must load new bundle.

### Soften the document boundary

A cross-app navigation remains a real document request, but it does not have to feel like an
abrupt refresh. Same-origin apps can use
[cross-document View Transitions](https://www.w3.org/TR/css-view-transitions-2/) as a progressive
enhancement:

```css
/* Include this in both apps, usually through a shared design-system stylesheet. */
@view-transition {
  navigation: auto;
}

.site-header {
  view-transition-name: site-header;
}

.page-content {
  view-transition-name: page-content;
}
```

The browser visually connects elements with the same `view-transition-name` in the old and new
documents. τjs still receives a new request, matches the destination app and returns its independent
bundle and response. No client shell, runtime federation or foreign-bundle mounting is introduced.

Keep the names stable across apps and unique within each document. Treat the effect as optional:
browsers that do not support cross-document transitions continue with an ordinary navigation. For
direction-aware or conditional effects, the platform also provides `pageswap` and `pagereveal`;
τjs does not need to coordinate them.

This improves visual continuity only. It does not preserve in-memory stores, active WebSockets,
media playback, unfinished forms or other client state. If a transition must retain that state,
the routes probably belong inside one application shell rather than on opposite MFE boundaries.

### Optional speculative loading

[Speculation Rules](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API) can
prefetch or prerender a likely next document in supporting browsers. Combined with a View
Transition, this can make a cross-app navigation feel very fast while preserving the full request
boundary.

Start conservatively and select links explicitly:

```html
<a href="/admin/users" data-prefetch>Go to Admin</a>

<script type="speculationrules">
  {
    "prefetch": [
      {
        "where": { "selector_matches": "a[data-prefetch]" },
        "eagerness": "moderate"
      }
    ]
  }
</script>
```

Speculation is a hint, not a guarantee. A browser may decline it. Prerendering is more expensive
than prefetching: it can execute the destination document, load its JavaScript and repeat route or
service work before the user navigates.

Do not apply blanket prerender rules to logout, checkout, mutations, expensive personalised
responses or anything with activation-sensitive side effects. Inline speculation rules must also
be allowed by the site CSP using an appropriate nonce, hash or the dedicated
`'inline-speculation-rules'` source.

τjs does not infer speculation from its route table. A declared route says that a URL exists; it
does not establish that loading it speculatively is safe, cheap or likely. This remains an
application or delivery-policy decision.

### Client-Side Routing Within Apps

Within an app, use client-side routing:

```typescript
// Customer app - same bundle
import { BrowserRouter, Route, Link } from "react-router-dom";

function CustomerApp() {
  return (
    <BrowserRouter>
      <Link to="/app/dashboard">Dashboard</Link> {/* No page reload */}
      <Link to="/app/settings">Settings</Link> {/* No page reload */}
      <Routes>
        <Route path="/app/dashboard" element={<Dashboard />} />
        <Route path="/app/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}
```

## Common Patterns

### Marketing Site + Web App

```typescript
apps: [
  {
    appId: "marketing",
    entryPoint: "marketing",
    routes: [
      { path: "/", attr: { render: "ssr", hydrate: false } },
      { path: "/pricing", attr: { render: "ssr", hydrate: true } },
      { path: "/about", attr: { render: "ssr", hydrate: false } },
    ],
  },
  {
    appId: "app",
    entryPoint: "app",
    routes: [
      {
        path: "/app/:page*",
        attr: {
          render: "streaming",
          middleware: { auth: {} },
        },
      },
    ],
  },
];
```

### Admin + Customer Apps

```typescript
apps: [
  {
    appId: "customer",
    entryPoint: "app",
    routes: [
      {
        path: "/app/:page*",
        attr: {
          render: "streaming",
          middleware: { auth: { strategy: "jwt" } },
        },
      },
    ],
  },
  {
    appId: "admin",
    entryPoint: "admin",
    routes: [
      {
        path: "/admin/:section*",
        attr: {
          render: "ssr",
          middleware: {
            auth: {
              strategy: "session",
              roles: ["admin"],
            },
          },
        },
      },
    ],
  },
];
```

## When to Use Multiple Apps

**Use multiple apps when:**

- Clear domain boundaries (customer vs admin vs marketing)
- Different teams own different parts
- Different deployment schedules needed
- Security isolation required (admin code never sent to customers)
- Different performance characteristics

**Use single app when:**

- Application is cohesive with no clear boundaries
- Small team maintaining everything
- Shared navigation and state throughout
- Similar performance needs across all pages

<!--

## What's Next?
- [Dependency Management](/guides/dependency-management) - How dependencies work across apps
- [Shared State](/guides/shared-state-management) - Share code between apps
- [Build & Deployment](/reference/build-deployment) - Full build process details -->
