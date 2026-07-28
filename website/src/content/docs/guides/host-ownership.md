---
title: Host Ownership
description: What τjs owns when you supply your own Fastify instance, and what it owns when it creates one for you.
---

Whether τjs creates Fastify or receives an existing instance determines the installation boundary.
When `fastify` is omitted, τjs creates the instance and installs its whole-server defaults. When
`fastify` is supplied, τjs registers its application routes and supporting facilities inside an
encapsulated scope. There is no separate ownership option or flag.

```ts
// τjs creates Fastify: whole-server shell, CSP and trace
const { app, net } = await createServer({ config });

// You own Fastify: τjs installs into an encapsulated application scope
await createServer({ config, fastify: app });
```

The boot summary reports which installation shape is active.

:::caution[Passing an instance is an ownership decision, whatever your reason for passing it]
Supplying `fastify` means you own the host, including when you created the instance solely to set
Fastify options such as `routerOptions` or `genReqId`. The caller-owned column below applies in
that case: your instance owns not-found handling, host-wide policy and request identity.

τjs does not infer intent from how the instance was configured. Choose the installation boundary
that matches the application:

- Omit `fastify` to use the τjs-created server and its whole-server defaults. Note that
  `config.server` covers only `host`, `port` and `hmrPort`; it does not configure
  `routerOptions`, `genReqId` or other Fastify construction options.
- Supply `fastify` when those native options or an existing host are required, then configure
  host-owned concerns on that instance.
:::

## What each side owns

| Concern | τjs-created Fastify | Your Fastify |
| --- | --- | --- |
| Page routes, data, rendering | τjs | τjs, in one encapsulated scope |
| CSP and trace | Whole server | τjs responses only |
| Auth | τjs routes | τjs routes |
| Page errors | τjs root handler | τjs scoped handler |
| Host route errors | τjs | You |
| Not-found and shell | Implicit τjs shell | You, unless you declare `/*` |
| Static facilities, decorators | τjs root | τjs scope |
| Logging | Resolved τjs logger | Your `fastify.log` lineage |
| Listening and shutdown | You | You |

On a supplied instance, production registration stays inside the τjs scope. It registers under its
own name, so it appears in the Fastify plugin tree as a mounted subsystem.

In development, Vite must serve URLs that match no route, such as `/@vite/client` and transformed
sources. Only a root-level hook can observe those requests, so τjs registers one delegating
`onRequest` hook. It hands the request to the τjs-owned Vite server and otherwise returns control
unchanged. The hook is not registered in production.

## Using a caller-owned Fastify instance

### Application shell and unmatched URLs

On a caller-owned host, URLs that match no Fastify route reach the host's not-found handler. τjs does
not install an implicit application shell in the caller's root scope.

To send client-routed URLs to a τjs application shell, declare a terminal wildcard page. It is an
ordinary Fastify route compiled from the τjs application contract:

```ts
routes: [
  { path: '/', attr: { render: 'ssr' } },
  { path: '/*', attr: { render: 'ssr' } },
];
```

The wildcard is the server route. Child URLs can remain client-routed inside the shell. See
[App Shell Architecture](/reference/app-shell-pattern) for the complete pattern.

The two shell forms have different asset behaviour. The implicit shell on a τjs-created host
delegates asset-like misses such as `/logo.png` to a 404. An explicit `/*` owns and renders every
URL it matches. Use narrower page patterns or a separate asset prefix when missing asset-like URLs
must remain 404 responses.

A caller's `@fastify/static` mount also needs a compatible route shape. Its default
`wildcard: true` claims `GET /*`, so declaring a τjs `/*` page would be a genuine duplicate route
and Fastify would stop boot with `FST_ERR_DUPLICATED_ROUTE`. Registration order does not change
that. Configure the static mount with `wildcard: false`, or keep the patterns non-overlapping:

```ts
await app.register(fastifyStatic, { root: assets, prefix: '/', wildcard: false });
```

τjs's own static facility uses `wildcard: false`, so it does not compete for the terminal page
route.

### CSP scope

`security.csp` applies to τjs responses. Route-level `merge`, `replace` and `false`, and nonce
plumbing, work the same in either installation shape.

If CSP should cover host routes as well, register the host-wide policy on the supplied Fastify
instance. τjs continues to manage policy for the pages it renders.

### Request identity and trace scope

τjs opens a trace episode only for responses it owns. Host routes do not receive a τjs
`x-trace-id` response header and do not start a τjs recorder episode.

τjs records can be correlated with host logs. A valid inbound `x-trace-id` becomes the τjs
`traceId`; otherwise τjs uses the Fastify `req.id`, including numeric IDs. τjs log bindings retain
the Fastify value as `reqId` in either case. Exact equality between `reqId` and `traceId` therefore
depends on the host's request-ID configuration; τjs does not rewrite `req.id`.

## Running τjs inside another runtime

Because a supplied instance keeps its own lifecycle, τjs can run as a subsystem of a larger Fastify
application without special support. It never calls `listen()`, never touches process lifecycle,
and releases what it owns, including the development Vite server, through ordinary `app.close()`.

This follows Fastify's plugin lifecycle and requires no provider-specific integration.
