---
title: Static Assets
description: How τjs handles static file serving
---

How τjs handles static file serving in development and production.

## Overview

τjs includes `@fastify/static` as a dependency and **automatically registers it in production** unless you explicitly opt out. This means static assets "just work" for standard setups.

You can:

- Use the default auto-registration (zero config)
- customise `@fastify/static` options via `staticAssets`
- Use a different plugin entirely
- Disable Fastify static serving (for CDN/Nginx setups)

τjs focuses on orchestration and SSR. Auto-registration covers the common case, but how you ultimately serve static files is up to you.

## Default Behaviour

If you don’t configure static assets:

```ts
import { createServer } from "@taujs/server";

await createServer({
  fastify,
  config,
  serviceRegistry,
  // staticAssets not specified
});
```

**What happens:**

1. τjs initialises its SSR server
2. **DEV**: `clientRoot` auto-resolves to `<cwd>/client` (source files) and Vite dev server handles all assets via HMR middleware (no static plugin needed)
3. **PROD**: τjs automatically registers `@fastify/static`. `clientRoot` auto-resolves to `<cwd>/dist/client` (built files). Assets load from `/assets/...` paths in your HTML
4. τjs loads manifests and templates from `clientRoot`

### Disabling Auto-Registration

To explicitly disable static serving (e.g., using CDN/Nginx):

```ts
await createServer({
  fastify,
  config,
  serviceRegistry,
  staticAssets: false, // No static plugin registered
});
```

τjs still loads manifests for SSR, but Fastify won't serve the files.

## Customising Static Assets

### Using `@fastify/static` with Options

Override the default auto-registration with custom options:

```ts
import fastifyStatic from "@fastify/static";
import { createServer } from "@taujs/server";
import path from "node:path";

// Use process.cwd() for predictable paths (see Troubleshooting)
const isDev = process.env.NODE_ENV === "development";
const clientRoot = isDev
  ? path.join(process.cwd(), "client")
  : path.join(process.cwd(), "dist", "client");

await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot,
  staticAssets: {
    plugin: fastifyStatic,
    options: {
      root: clientRoot,
      prefix: "/",
      index: false,
      wildcard: false,
      decorateReply: false,
      setHeaders: (res, filePath) => {
        // Custom cache headers
        if (/[.-][a-f0-9]{8,}\./.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    },
  },
});
```

### Multiple Static Mounts

You can mount multiple static plugins or prefixes:

```ts
await createServer({
  fastify,
  config,
  clientRoot,

  staticAssets: [
    {
      // App assets
      plugin: fastifyStatic,
      options: {
        root: path.join(clientRoot, "app"),
        prefix: "/app/",
      },
    },
    {
      // Admin assets
      plugin: fastifyStatic,
      options: {
        root: path.join(clientRoot, "admin"),
        prefix: "/admin/",
      },
    },
  ],
});
```

τjs sorts entries by prefix depth, so more specific prefixes are registered first.

## Public Directory

τjs expects a project-level `public/` directory for non-bundled assets:

```txt
project/
├── public/
│   ├── favicon.ico
│   ├── robots.txt
│   └── app/
│       └── logo.svg
└── client/
    ├── app/
    └── admin/
```

**During build:**

- **Client build:** copies `public/` contents into `dist/client/`
- **SSR build:** uses `publicDir: false` (no extra copying)

**Result after build:**

```txt
dist/client/
├── favicon.ico
├── robots.txt
├── app/
│   ├── logo.svg
│   └── assets/
└── admin/
    └── assets/
```

These files are then served by whatever static setup you’ve chosen (Fastify, CDN, proxy).

## App-Specific Assets

You can namespace assets per app:

```txt
public/
├── app/
│   ├── logo.svg
│   └── favicon.ico
└── admin/
    ├── logo.svg
    └── favicon.ico
```

References in HTML:

```html
<!-- Customer app -->
<img src="/app/logo.svg" />

<!-- Admin app -->
<img src="/admin/logo.svg" />
```

As long as your static middleware (or CDN/proxy) serves `dist/client/` at `/`, these URLs resolve correctly.

## Static Caching Pattern

τjs does **not** implement full static site generation (SSG). There is no build-time HTML export or separate "static" data API. Instead, you can get **SSG-like** behaviour for suitable routes by combining:

- SSR
- `hydrate: false` (no client-side JS)
- Proper static asset caching
- HTML caching at the CDN / proxy level

This is a runtime caching problem, not a build pipeline problem.

### 1. Mark routes that are safe to treat as static

Typical candidates:

- Marketing pages (`/`, `/about`, `/pricing`)
- Documentation
- Blog posts that don't depend on the logged-in user

In `taujs.config.ts`:

```ts
export default defineConfig({
  apps: [
    {
      appId: "web",
      entryPoint: "",
      routes: [
        {
          path: "/",
          attr: {
            render: "ssr",
            hydrate: false, // no client JS needed
            data: async () => ({
              hero: {
                title: "τjs – Orchestrated SSR",
                subtitle: "Build-time composition, server-side rendering.",
              },
            }),
          },
        },
      ],
    },
  ],
});
```

**Constraints for "SSG-like" pages:**

- Do **not** rely on `ctx.user` or per-request auth
- Treat data as global / shared, not user-specific
- Be comfortable with caching the response at the edge

### 2. Cache static assets aggressively

You can set cache headers using `setHeaders` in your `staticAssets` configuration. A simple hashed vs non-hashed strategy is usually enough:

```ts
import fastifyStatic from "@fastify/static";

await createServer({
  fastify,
  config,
  serviceRegistry,
  staticAssets: {
    plugin: fastifyStatic,
    options: {
      root: clientRoot,
      prefix: "/",
      setHeaders: (res, filePath) => {
        // Crude check: filenames that contain a hash
        const isHashed = /[.-][a-f0-9]{8,}\./.test(filePath);

        if (isHashed) {
          // JS/CSS bundles, images, etc. with content hashes
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".html")) {
          // HTML entry points – keep reasonably fresh
          res.setHeader(
            "Cache-Control",
            "public, max-age=60, stale-while-revalidate=300"
          );
        } else {
          // Fallback for other assets
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    },
  },
});
```

This gives you:

- Long-lived caching for hashed assets (`immutable`)
- Short-lived but cacheable HTML
- Reasonable defaults for everything else

### 3. Cache HTML at the edge

Please see [CDN for Static Assets in deployment section](/guides/build-deployment/#option-b-cdn-for-static-assets)

τjs returns HTML like any other SSR server. To make it feel like SSG:

- Put a CDN / proxy (Cloudflare, CloudFront, Fastly, Nginx, etc.) in front
- Cache responses for "safe" routes (`/`, `/about`, `/pricing`, etc.)
- Use a shorter TTL for HTML than assets

For example (CloudFront / generic CDN strategy):

- Assets under `/assets/`: `max-age=31536000, immutable`
- HTML (entry routes): `max-age=60, stale-while-revalidate=300`

To the end user:

- First request hits τjs and renders SSR
- Next requests hit the CDN and serve cached HTML + cached assets
- The experience is effectively "static" without a separate SSG pipeline

### What τjs does _not_ do

- No "static props" / "server side props" split
- No HTML export or "build-time routes" concept
- No implicit caching or magic headers

You keep a single data model (`attr.data`) and control caching via:

- Static asset configuration (`staticAssets` / Fastify)
- CDN / proxy configuration for HTML

### Per-route cache headers (optional pattern)

If you want to drive cache policy from your own routing rules, do it at the Fastify layer rather than inside τjs:

```ts
fastify.addHook("onSend", (req, reply, payload, done) => {
  const path = req.raw.url?.split("?")[0] ?? "";

  if (path === "/" || path === "/about" || path === "/pricing") {
    reply.header(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=300"
    );
  }

  done();
});
```

## Troubleshooting

### Using `__dirname` with Relative Paths

A common mistake when explicitly setting `clientRoot`

```ts
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const clientRoot = isDev
  ? path.resolve(__dirname, "../client")
  : path.resolve(__dirname, "../dist/client"); // Breaks after build!
```

You will end up with something not unlike in production:

```ts
ENOENT: no such file or directory, open '.../dist/dist/client/index.html'
```

Use `process.cwd()` as directory where you **run** your server. Or alternatively use τjs auto-resolvers to client directory

### Assets Not Loading

Check one of the following is true:

- You configured `staticAssets` with a valid plugin (e.g. `@fastify/static`), **or**
- You have a CDN / proxy correctly pointing at your built `dist/client/` directory.

Verify the files actually exist:

```bash
ls dist/client/app/assets/
# Should show built JS/CSS chunks
```

### Wrong MIME Types

If your static plugin needs MIME overrides, configure them in the plugin options:

```ts
import fastifyStatic from "@fastify/static";

await createServer({
  fastify,
  config,
  clientRoot,
  staticAssets: {
    plugin: fastifyStatic,
    options: {
      root: "./dist/client",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js")) {
          res.setHeader("Content-Type", "application/javascript");
        }
      },
    },
  },
});
```

### HTML doesn't feel static

If pages still feel "dynamic":

- Confirm the route doesn't depend on per-user data
- Ensure `hydrate: false` is set where appropriate
- Check CDN / proxy cache rules for HTML
- Check that `staticAssets.setHeaders` isn't forcing `no-cache` on HTML files

```

```
