---
title: Host Ownership
description: What τjs owns when you supply your own Fastify instance, and what it owns when it creates one for you.
---

τjs has one rule about the server it runs on:

> Bring your own Fastify and τjs respects it. Let τjs create Fastify and it provides the complete experience.

You choose between them by whether you pass `fastify` to `createServer`. There is no ownership option, mode or flag, and nothing extra to configure.

```ts
// τjs creates Fastify: whole-server shell, CSP and trace
const { app, net } = await createServer({ config });

// You own Fastify: τjs owns only its declared routes
await createServer({ config, fastify: app });
```

The boot summary states which mode is in effect, so you never have to infer it.

:::caution[Passing an instance is an ownership decision, whatever your reason for passing it]
Supplying `fastify` always means you own the host, including when you created the instance solely to
set Fastify options such as `routerOptions` or `genReqId`. In that case you still lose the implicit
shell, whole-server τjs CSP and `x-trace-id` on your own routes.

τjs deliberately does not try to infer intent from how the instance was configured, because that
guess would be unreliable. If you want τjs options *and* the complete experience, let τjs create the
instance and configure what you need through `config.server`, or accept host ownership and declare a
terminal wildcard page as described below.
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

On a supplied instance τjs installs no root error handler, no root not-found handler, no root CSP or trace hook, claims no root decorator names, and writes no banner or presentation output. It does register under its own name, so it appears in your plugin tree where you would expect a mounted subsystem to be.

Development has one deliberate exception: Vite must serve URLs that match no route, such as `/@vite/client` and transformed sources, and only a root-level hook observes those. τjs registers exactly one delegating `onRequest` hook for that purpose. It hands the request to the τjs-owned Vite server and otherwise returns control unchanged. It starts no trace, applies no policy and selects no route, and it does not exist in production.

## Migrating an embedded application

If you already call `createServer({ fastify })`, three behaviours that used to apply to your whole server now apply only to τjs responses.

### Unmatched URLs are yours again

Previously any URL that matched no route received a τjs HTML shell with status 200. Your own not-found policy now handles them.

If you want τjs to render unmatched URLs, declare a terminal wildcard page. It is an ordinary τjs route with no special casing:

```ts
routes: [
  { path: '/', attr: { render: 'ssr' } },
  { path: '/*', attr: { render: 'ssr' } },
];
```

Two differences are worth knowing.

The old implicit shell delegated asset-like misses such as `/logo.png` to a 404, whereas an explicit `/*` owns and renders everything it matches. To keep assets 404ing, declare narrower page patterns instead of `/*`, or serve assets under a prefix the wildcard does not cover.

If you also serve static files from your own instance, check how that mount is configured. `@fastify/static` defaults `wildcard` to `true`, which claims `GET /*` on your root, and Fastify's router is global, so a declared τjs `/*` page is then a genuine duplicate route and boot fails with `FST_ERR_DUPLICATED_ROUTE`. Registration order does not change this. Either register your static mount with `wildcard: false`, or keep the two patterns non-overlapping:

```ts
await app.register(fastifyStatic, { root: assets, prefix: '/', wildcard: false });
```

τjs's own static facility already uses `wildcard: false` for exactly this reason, so it never competes for that route.

### Configured CSP no longer covers your routes

`security.csp` now applies to τjs responses. Route-level `merge`, `replace` and `false`, and nonce plumbing, are unchanged.

Host-wide policy belongs to Fastify. Register your preferred CSP plugin on your instance and it will cover your routes, while τjs continues to manage policy for the pages it renders.

### `x-trace-id` no longer appears on your routes

τjs opens a trace episode only for responses it owns, so your routes carry no `x-trace-id` and start no recorder episode.

Correlation still spans both sides. τjs adopts an inbound `x-trace-id` header if present, and otherwise your Fastify `req.id`, so a request identity you set with `genReqId` flows into τjs logs and traces without any wiring.

### Two boot failures are fixed

Supplying an instance that already had a not-found handler, or that had already registered `@fastify/static`, previously stopped τjs from booting. Both now work.

## Running τjs inside another runtime

Because a supplied instance keeps its own lifecycle, τjs is usable as a subsystem of a larger Fastify application without special support. It never calls `listen()`, never touches process lifecycle, and releases what it owns, including the development Vite server, through ordinary `app.close()`.

That is a property of being a well-behaved Fastify plugin rather than an integration with any particular platform, and τjs ships no provider-specific code.
