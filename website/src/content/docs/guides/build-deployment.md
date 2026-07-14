---
title: Build & Deployment
description: How τjs builds applications and deployment strategies
---

How τjs builds applications and deployment strategies.

τjs produces a standard Node.js server. There are no framework-specific hosting requirements, no adapter layer, no platform lock-in. If a platform runs Node, it runs τjs - whether that's a bare VPS, Railway, Fly.io, Platform.sh, or a container on your own infrastructure.

The deployment strategies below cover the most common patterns, but the underlying principle is simple: build, copy the output, start the server.



## Overview

τjs uses Vite to build frontend applications and produces:

- **Client assets** - Browser JavaScript and CSS
- **SSR bundles** - Server-side rendering modules
- **Manifests** - Mapping of source files to built assets

The build process is designed for multi-app architectures with separate bundles per application.

## Build Process

### Build Steps

A complete production build involves:

1. **Client assets** (Vite)
2. **SSR bundles** (Vite)
3. **Server bundle** (esbuild/rollup)

These steps are intentionally separate for flexibility.

### Client Build

```bash
npm run build:client
```

**What happens:**

1. Cleans `dist/` directory
2. Runs Vite for each app in config
3. Outputs browser assets to `dist/client/{entryPoint}/`
4. Generates `manifest.json` per app
5. Copies `index.html` if present

**Output structure:**

```
dist/client/
├── app/
│   ├── assets/
│   │   ├── entry-client-abc123.js
│   │   ├── App-def456.js
│   │   └── index-ghi789.css
│   ├── manifest.json
│   └── index.html
└── admin/
    ├── assets/
    ├── manifest.json
    └── index.html
```

### SSR Build

```bash
npm run build:ssr
# or
BUILD_MODE=ssr npm run build
```

**What happens:**

1. Does **not** clean `dist/` (preserves client assets)
2. Runs Vite in SSR mode for each app
3. Outputs SSR bundles to `dist/ssr/{entryPoint}/`
4. Generates `ssr-manifest.json` per app

**Output structure:**

```
dist/ssr/
├── app/
│   ├── ssr-manifest.json
│   └── server.js
└── admin/
    ├── ssr-manifest.json
    └── server.js
```

### Server Build

```bash
npm run build:server
```

Bundles your Fastify server code (not part of τjs):

```
dist/server/
└── index.js
```

This is your own server code bundled for production.

## Build Configuration

### Vite Plugins per App

Register standard Vite plugins per app in `taujs.config.ts`:

```typescript
// taujs.config.ts
export default defineConfig({
  apps: [
    {
      appId: "web",
      entryPoint: "client",
      plugins: [
        react(),
        visualizer(), // Bundle analyser
      ],
    },
  ],
});
```

Plugins apply in both development and build, with one difference in scope:

- **Build**: each app is built with exactly its own plugin list.
- **Development**: τjs runs a single shared Vite dev server for all apps, so every app's
  plugins are merged into one list. Duplicate plugin names are dropped - the first
  occurrence wins.

Declare a plugin in every app that needs it and keep its options consistent across apps: in
development the first app's instance serves them all.

A `vite.config.ts` is not a τjs configuration surface - `taujs.config.ts` and the
`taujsBuild` override below are the two supported Vite configuration channels. Configuration
placed in a `vite.config.ts` is not part of the contract and must not be relied upon.

### Build-time Vite Override

`taujsBuild` accepts a guardrailed `vite` override for build tuning. It applies to builds
only - it does not affect the dev server.

```typescript
// build.ts
await taujsBuild({
  clientBaseDir: path.resolve(process.cwd(), "src/client"),
  config,
  projectRoot: process.cwd(),
  vite: {
    plugins: [visualizer()],
    build: { sourcemap: "inline" },
  },
});
```

A function form receives `{ appId, entryPoint, isSSRBuild, clientRoot }` per app:

```typescript
vite: ({ isSSRBuild, entryPoint }) => ({
  plugins: isSSRBuild ? [] : [visualizer()],
  logLevel: entryPoint === "admin" ? "info" : "warn",
});
```

Allowed customisations: `plugins` (appended after app plugins), `define` (shallow-merged),
`css.preprocessorOptions` (merged per preprocessor engine), `build.sourcemap` / `minify` /
`terserOptions`, `build.rollupOptions.external`, `build.rollupOptions.output.manualChunks`,
`resolve.*` except `alias`, `esbuild`, `logLevel`, `optimizeDeps`.

Protected fields (framework-controlled, silently ignored if supplied): `root`, `base`,
`publicDir`, `build.outDir`, `build.ssr` / `ssrManifest`, `build.rollupOptions.input`,
`resolve.alias` (use the `alias` option instead), `server.*`.

### Alias Configuration

τjs provides default aliases:

```typescript
'@client'  → app root (e.g., client/app/)
'@server'  → project/src/server
'@shared'  → project/src/shared
```

Override or extend with the `alias` option. It is an option of `taujsBuild` (build) and
`createServer` (dev), not a `taujs.config.ts` field - pass the same map to both so
development and build resolve identically. User values win over the framework defaults on
conflict.

```typescript
// build.ts
await taujsBuild({
  clientBaseDir,
  config,
  projectRoot,
  alias: {
    "@components": path.resolve(__dirname, "src/client/shared/components"),
    "@utils": path.resolve(__dirname, "src/client/shared/utils"),
  },
});
```

```typescript
// src/server/index.ts
await createServer({
  config,
  serviceRegistry,
  alias: {
    "@components": path.resolve(__dirname, "../client/shared/components"),
    "@utils": path.resolve(__dirname, "../client/shared/utils"),
  },
});
```

## Public Assets

### publicDir Behavior

**Client build:**

- Uses `public/` resolved against each app's root: `src/client/{entryPoint}/public/`, or
  `src/client/public/` when `entryPoint` is empty
- Each app has its own public directory - apps do not share one
- Assets copied into that app's output under `dist/client/`

**SSR build:**

- Sets `publicDir: false`
- No public assets processed during SSR build

## Output Structure

After a complete build:

```
dist/
├── client/
│   ├── app/
│   │   ├── assets/
│   │   ├── manifest.json
│   │   └── index.html
│   └── admin/
│       ├── assets/
│       ├── manifest.json
│       └── index.html
│
├── ssr/
│   ├── app/
│   │   ├── ssr-manifest.json
│   │   └── server.js
│   └── admin/
│       ├── ssr-manifest.json
│       └── server.js
│
└── server/
    └── index.js
```

---

# Targeted Builds

τjs supports **selective per-app builds**, allowing you to build only the apps you care about instead of running a full multi-app build every time. This is useful for:

- Monorepos with many apps
- CI pipelines that detect changed apps
- Local workflows where you only want to build a single surface

There is no cross-app bundling or shared-chunk inference. Each app remains an isolated build unit, which keeps MFE boundaries clean.

---

## Build all apps (default)

If you run your build script without any flags or env variables, τjs builds every app defined in your `taujs.config.ts`.

```bash
node scripts/build.mjs
```

Example build script:

```ts
// scripts/build.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taujsBuild } from "@taujs/server";
import config from "../taujs.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await taujsBuild({
  clientBaseDir: path.resolve(__dirname, "src/client"),
  projectRoot: __dirname,
  config,
});
```

---

## Build a single app (CLI)

To build only one app, pass `--app`, `--apps`, or `-a`:

```bash
node scripts/build.mjs --app admin
```

Multiple apps:

```bash
node scripts/build.mjs --apps admin,marketing
```

The filter matches **both**:

- `appId` from `taujs.config.ts`
- `entryPoint` (usually the client subfolder name)

So any of these work:

```bash
node scripts/build.mjs --app admin
node scripts/build.mjs --app @acme/admin
```

---

## Build specific apps using environment variables (CI-friendly)

CI pipelines often prefer environment variables instead of CLI args:

```bash
TAUJS_APP=admin node scripts/build.mjs
```

Multiple:

```bash
TAUJS_APP=admin,marketing node scripts/build.mjs
```

**Precedence:**
CLI flags override environment variables if both are present.

---

## Combining with SSR / Client build modes

τjs uses `BUILD_MODE` to determine which bundle to produce:

| BUILD_MODE | Result                                           |
| ---------- | ------------------------------------------------ |
| `client`   | Client bundle(s)                                 |
| `ssr`      | SSR bundle(s)                                    |
| (unset)    | Falls back to default logic in your build script |

Examples:

```bash
BUILD_MODE=client node scripts/build.mjs --app admin
BUILD_MODE=ssr TAUJS_APP=admin node scripts/build.mjs
```

Typical `package.json` setup:

```json
{
  "scripts": {
    "build:client": "BUILD_MODE=client node scripts/build.mjs",
    "build:ssr": "BUILD_MODE=ssr node scripts/build.mjs",
    "build:client:admin": "BUILD_MODE=client TAUJS_APP=admin node scripts/build.mjs",
    "build:ssr:admin": "BUILD_MODE=ssr TAUJS_APP=admin node scripts/build.mjs"
  }
}
```

---

## What “incremental” means in τjs

Selective builds are **per-app**, not **cached** or **partial** builds.

- Client builds always wipe `dist/` before building.
- SSR builds do not delete `dist/` by default.
- Only the targeted apps are passed through Vite.

This avoids stale assets and keeps each app isolated.

---

## Deployment Strategies

### Option A: Single Server

Fastify serves both static assets and SSR:

```typescript
// server/index.ts
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createServer } from "@taujs/server";
import path from "node:path";

const fastify = Fastify({ logger: false });

// Serve static assets
await fastify.register(fastifyStatic, {
  root: path.join(process.cwd(), "dist", "client"),
  prefix: "/",
  wildcard: false,
});

// τjs handles SSR
await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "dist/client",
});

await fastify.listen({ port: 3000, host: "0.0.0.0" });
```

**Deployment:**

```bash
npm run build
npm start
```

### Option B: CDN for Static Assets

Upload client assets to CDN:

**Build and upload:**

```bash
npm run build:client
# Upload dist/client/ to CDN
aws s3 sync dist/client/ s3://my-bucket/assets/

npm run build:ssr
npm run build:server
# Deploy server with SSR bundles
```

**CDN cache rules:**

````
/assets/*        → max-age=31536000, immutable
/*.html          → no-cache
Other files      → no-cache unless hashed
```#

For pages that don't need per-user data:

- Set `hydrate: false` to skip client JS
- Configure cache headers on static assets
- Use CDN/edge caching for HTML

See [Edge-Cached Static Pages](/guides/static-assets/#static-caching-pattern) for the full pattern.

**Server configuration:**

```typescript
// Don't serve static assets - CDN handles them
await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "dist/client", // Still needed for manifests
  registerStaticAssets: false, // Disable static middleware
});
````

### Option C: Reverse Proxy (Nginx)

Nginx serves static assets, proxies SSR to Node:

```nginx
# Nginx configuration
upstream nodejs {
  server localhost:3000;
}

server {
  listen 80;
  server_name example.com;

  # Static assets - long cache
  location ~ ^/.+/assets/ {
    root /app/dist/client;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Try static files first, then proxy to Node
  location / {
    root /app/dist/client;
    try_files $uri @nodejs;
  }

  # Proxy to Node.js for SSR
  location @nodejs {
    proxy_pass http://nodejs;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
  }
}
```

### Option D: Container Deployment

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
CMD ["node", "dist/server/index.js"]
```

## Cache Strategy

### Hashed Assets (Long Cache)

```
/assets/entry-client-abc123.js    → max-age=31536000, immutable
/assets/index-def456.css          → max-age=31536000, immutable
```

**Why:** Filenames include content hash. New content = new filename.

### Entry Points (No Cache)

```
/app/index.html    → no-cache
/admin/index.html  → no-cache
```

**Why:** Entry points reference hashed assets. Must always be fresh.

### Invalidation Strategy

**Never invalidate:**

- Hashed assets in `/assets/`

**Always invalidate:**

- HTML entry points
- Unhashed files (if any)

**CDN purge example:**

```bash
# Only purge HTML files
aws cloudfront create-invalidation \
  --distribution-id DISTID \
  --paths "/*.html"
```

## Troubleshooting

### Missing CSS/JS

**Problem:** Assets not loading in production

**Check:**

1. Did client build run first?
2. Are assets in `dist/client/{app}/assets/`?
3. Is static middleware configured?

### SSR Failing to Import

**Problem:** Server can't find SSR bundle

**Check:**

1. SSR bundles in `dist/ssr/{app}/`?
2. `ssr-manifest.json` present?
3. `clientRoot` points to `dist/client/`?

### Stale Frontend

**Problem:** Users seeing old code

**Solution:** Invalidate HTML on deployment:

```bash
# After deploy
aws cloudfront create-invalidation \
  --distribution-id DISTID \
  --paths "/*.html"
```

## Performance Optimisation

### Code Splitting

Vite automatically code splits:

```typescript
// Lazy load heavy components
const Dashboard = lazy(() => import("./Dashboard"));

function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Dashboard />
    </Suspense>
  );
}
```

### Compression

Enable compression in production:

```typescript
// server/index.ts
import fastifyCompress from "@fastify/compress";

await fastify.register(fastifyCompress, {
  global: true,
  encodings: ["gzip", "deflate"],
});
```

<!--
## What's Next?
- [Static Assets](/guides/static-assets) - Serving static files
- [τjs Configuration](/reference/taujs-config) - Full configuration reference -->
