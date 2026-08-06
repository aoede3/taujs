---
title: Static Assets
description: Development, production and host-owned static file serving
---

τjs uses Vite for development assets and `@fastify/static` for its default production assets. The
static facility belongs to the same Fastify scope as the τjs applications, so it follows the
created-host versus caller-owned-host boundary.

## Default behaviour

When `clientRoot` is omitted, τjs resolves:

| Environment | Root | Asset owner |
| --- | --- | --- |
| Development | `<cwd>/src/client` | τjs-owned Vite server |
| Production | `<cwd>/dist/client` | τjs-owned `@fastify/static` registration |

```ts
await createServer({
  fastify,
  config,
  serviceRegistry,
});
```

In production the default registration uses:

```ts
{
  root: clientRoot,
  prefix: "/",
  index: false,
  wildcard: false,
}
```

`wildcard: false` matters. Static files receive concrete Fastify routes instead of a catch-all
`GET /*`, so τjs can also register an explicit terminal application-shell route.

On a τjs-created host the facility is installed at the created root. On a supplied Fastify instance
it is encapsulated with the τjs applications. A caller's own static routes remain the caller's
responsibility.

Explicit `staticAssets: false` opts out entirely: no static plugin is installed in production or
development. Omission and `false` are distinct requests - omit the option to receive the default
registration, pass `false` when another system owns the files.

## Custom static registration

Pass a plugin and options when the defaults do not fit:

```ts
import fastifyStatic from "@fastify/static";
import path from "node:path";

// Ask the same question τjs asks: development is explicit, everything else is production.
// Testing for `!== "production"` would send `NODE_ENV=test`, `staging` or an unset variable
// down the development branch while τjs itself loads production assets.
const clientRoot = path.resolve(
  process.cwd(),
  process.env.NODE_ENV === "development" ? "src/client" : "dist/client",
);

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
      setHeaders: (response, filePath) => {
        if (/[.-][a-f0-9]{8,}\./.test(filePath)) {
          response.setHeader(
            "Cache-Control",
            "public, max-age=31536000, immutable",
          );
        }
      },
    },
  },
});
```

τjs supplies `root`, `prefix`, `index` and `wildcard` defaults before applying your options. An
explicit option wins.

`decorateReply: false` is useful when the host already has an `@fastify/static` instance and the τjs
scope only needs routes, not another `reply.sendFile` decoration.

### Multiple mounts

`staticAssets` may be an array:

```ts
staticAssets: [
  {
    plugin: fastifyStatic,
    options: {
      root: path.join(clientRoot, "customer"),
      prefix: "/customer/",
      wildcard: false,
      decorateReply: false,
    },
  },
  {
    plugin: fastifyStatic,
    options: {
      root: path.join(clientRoot, "admin"),
      prefix: "/admin/",
      wildcard: false,
      decorateReply: false,
    },
  },
];
```

τjs sorts mounts by prefix depth before registration so a more specific prefix is registered first.
Fastify still rejects exact route collisions at boot.

### Composition with a mounted installation

When the installation declares a `server.mountPrefix`, custom static registrations compose
with it exactly as Fastify composes any nested plugin route: a registration with
`prefix: "/cdn/"` inside an installation mounted at `/app` serves at `/app/cdn/`. Existing
option semantics are unchanged; τjs does not rewrite the configured static prefix to
account for the installation mount - Fastify composes it with the enclosing scope.

A host-root mount is still available when you want it: pass `staticAssets: false` so τjs
registers nothing, and register your static plugin on the Fastify instance you own - a
caller-root `/cdn/` then serves at `/cdn/` regardless of where τjs is mounted.

## Caller-owned Fastify and terminal wildcards

A supplied host may register its own `@fastify/static` before τjs. That works when the route shapes do
not collide.

The caller plugin's own default is `wildcard: true`, which claims `GET /*`. If a τjs application also
declares `/*` as its shell route, Fastify correctly fails with `FST_ERR_DUPLICATED_ROUTE`. Registration
order cannot resolve two owners of the same method and path.

Use one of these arrangements:

```ts
// Concrete file routes can coexist with a τjs terminal shell route.
await fastify.register(fastifyStatic, {
  root: path.resolve("dist/client"),
  prefix: "/",
  wildcard: false,
});
```

```ts
// Or keep host assets on a non-overlapping prefix.
await fastify.register(fastifyStatic, {
  root: path.resolve("public-assets"),
  prefix: "/host-assets/",
});
```

See [Host Ownership](/guides/host-ownership/#application-shell-and-unmatched-urls) for shell and
not-found behaviour.

## Public directories

Vite resolves `public/` against each application's root, not once from the repository root.

For `entryPoint: "customer"` and the default `clientBaseDir`, use:

```text
src/client/customer/
├── entry-client.tsx
├── entry-server.tsx
└── public/
    ├── favicon.svg
    └── images/
        └── logo.svg
```

The client build copies those files to the root of that application's output:

```text
dist/client/customer/
├── favicon.svg
├── images/
│   └── logo.svg
└── assets/
```

When `entryPoint` is empty, the application root is `src/client` and its public directory is
`src/client/public`.

SSR builds set `publicDir: false`; they do not copy public files a second time. See
[Build & Deployment](/guides/build-deployment/#publicdir-behavior).

## Asset URLs in rendered HTML

Each build uses the application entry point as its base. Prefer manifest-derived asset references
from the renderer and root-relative URLs for known public files:

```html
<img src="/customer/images/logo.svg" alt="Customer" />
```

Confirm the production URL against the built output and chosen static prefix. A public file is copied,
not imported, so Vite does not hash or transform it.

Imported images, fonts, CSS and JavaScript belong to the Vite module graph and normally receive
hashed output names. Do not hard-code those generated names.

## Caching

Static files and rendered HTML have different owners.

### Hashed assets

Hashed client assets are suitable for long immutable caching:

```text
Cache-Control: public, max-age=31536000, immutable
```

Set that header in `staticAssets.options.setHeaders`, the CDN or the reverse proxy. Keep unhashed
public files on a shorter policy unless their URLs are versioned.

### Rendered HTML

`@fastify/static` does not serve τjs-rendered HTML. Configure HTML caching on the Fastify response,
reverse proxy or CDN instead.

Only cache a route publicly when its entire response is safe to share. Authenticated content,
session-dependent output, personalised CSP, cookies and per-request data normally rule out a public
cache.

A simple host-level Fastify policy can target known public pages:

```ts
fastify.addHook("preHandler", async (request, reply) => {
  const pathname = request.raw.url?.split("?")[0] ?? "";

  if (pathname === "/" || pathname === "/pricing") {
    reply.header(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=300",
    );
  }
});
```

Use `preHandler`. `onRequest` reaches every strategy but runs before authentication and validation,
so a rejected protected request could still carry a public cache header. `onSend` reaches streamed
responses too, but a streamed page that fails before its first byte gives you a second send pass, so
cache policy expressed there has to be safe across response attempts. `preHandler` reaches both
strategies and runs only once authentication and validation have succeeded. See
[Response policy and lifecycle hooks](/guides/host-ownership/#response-policy-and-lifecycle-hooks).

Streaming cache policy is necessarily decided before rendering. A streamed document is cold:
nothing renders until Fastify begins consuming it. By then all header-mutating lifecycle hooks have
completed; the response becomes irreversible only when the document yields its first byte. If
caching must depend on successful completion or on the final status, enforce it at a proxy or CDN
that can observe the complete response, rather than through an early hook.

τjs does not provide static-site generation, build-time HTML export or automatic cache headers.
`hydrate: false` removes the client application from a rendered route; it does not make the HTML
cache-safe by itself.

## CDN-owned assets

A CDN or reverse proxy may serve `dist/client` before requests reach Fastify. The HTML server still
needs the manifests and SSR modules required to generate correct asset references.

Set `staticAssets: false` for a CDN-only deployment: τjs installs no static plugin, so Fastify
serves documents while the CDN owns the files under `dist/client`.

## Troubleshooting

### Wrong root after bundling the server

Paths derived from source-file `__dirname` often gain an extra `dist` segment after the server is
bundled. Prefer an explicit path from the process working directory:

```ts
const clientRoot = path.resolve(process.cwd(), "dist/client");
```

Or omit `clientRoot` when the process starts from the project root and use the environment defaults.

### Asset returns the application shell

Check whether a terminal wildcard page owns the asset URL. An explicit `/*` page renders every URL it
matches, including asset-like misses. Use a narrower page prefix and a separate asset prefix when
missing files must remain 404 responses.

### Boot fails with `FST_ERR_DUPLICATED_ROUTE`

List the method and path claimed by each static and page registration. The common collision is a
caller-owned wildcard static mount and a τjs `/*` page. Set the caller mount to `wildcard: false` or
separate the prefixes.

### Wrong MIME type

First confirm the response came from the static route rather than a shell or not-found handler. If a
real file needs an override, set the header in that mount's `setHeaders` callback.

### Files are missing

Verify both the source location and built output:

```bash
ls src/client/customer/public
ls dist/client/customer
```

A selective client build cleans `dist/`, so an artefact assembly pipeline must restore the outputs for
other configured applications before deployment.

Related guides:

- [Host Ownership](/guides/host-ownership/) for Fastify scope and shell ownership
- [Build & Deployment](/guides/build-deployment/) for output and selective builds
- [Micro-Frontends](/guides/micro-frontend/) for per-application artefacts
