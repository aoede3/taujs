---
title: Host Ownership
description: What τjs owns when you supply your own Fastify instance, and what it owns when it creates one for you.
---

Whether τjs creates Fastify or receives an existing instance determines the installation boundary.
When `fastify` is omitted, τjs creates the instance and installs its whole-server defaults. When
`fastify` is supplied, τjs registers its application routes and supporting facilities inside an
encapsulated scope. There is no separate ownership option or flag.

```ts
// τjs creates Fastify: whole-server SPA fallback, CSP and request identity
const { app, net } = await createServer({ config });

// You own Fastify: τjs installs into an encapsulated application scope
await createServer({ config, fastify: app });
```

The boot summary reports which installation shape is active. On a caller-owned host it also
states whether a terminal wildcard page is declared and what consequently owns the remaining GET
paths, so the choice described below is visible at boot rather than discovered when unmatched
URLs behave unexpectedly.

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
| CSP and request identity | Whole server | τjs responses only |
| Auth | τjs routes | τjs routes |
| Page errors | τjs root handler | τjs scoped handler |
| Host route errors | τjs | You |
| Not-found and SPA fallback | Implicit τjs fallback document | You, unless you declare `/*` |
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

### SPA fallback and unmatched URLs

On a caller-owned host, URLs that match no Fastify route reach the host's not-found handler. τjs does
not install its implicit SPA fallback document in the caller's root scope.

To keep client-routed URLs inside a τjs application, declare a terminal wildcard page route. It
is an ordinary Fastify route compiled from the τjs application contract:

```ts
routes: [
  { path: '/', attr: { render: 'ssr' } },
  { path: '/*', attr: { render: 'ssr' } },
];
```

The wildcard is the server route. Child URLs can remain client-routed inside the application.
For the separate single-application composition pattern using shared browser-side chrome,
routing and state, see [App Shell Architecture](/guides/app-shell-pattern).

The implicit fallback and the explicit wildcard have different asset behaviour. The implicit SPA
fallback document on a τjs-created host
delegates asset-like misses such as `/logo.png` to a 404. An explicit `/*` owns and renders every
URL it matches. Use narrower page patterns or a separate asset prefix when missing asset-like URLs
must remain 404 responses. When more than one application is configured, the implicit fallback
document is always the first configured application's shell.

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
instance. τjs continues to manage policy for the pages it renders: when τjs CSP is active for a
page (a global policy, or a route declaring its own), a caller-set `content-security-policy`
reaching that page is replaced by τjs's own, because the nonce it carries must match the page's
inline scripts. Where τjs sets no policy - `middleware.csp: false`, or production with no global
or route policy - the caller's header stands. Other caller headers pass through unchanged.

### Request identity and episode scope

τjs opens a recorder episode only for responses it owns. Host routes do not receive a τjs
`x-request-id` response header and do not start a τjs recorder episode.

Fastify `req.id` is the canonical request-correlation identity in both host modes, including
numeric IDs, whose textual form is used. The τjs request identity is always `String(req.id)`: it
keys the recorder episode, appears in log bindings as the Fastify-native `reqId` and echoes on
τjs-owned responses as `x-request-id`. τjs never rewrites `req.id` and never reinterprets an
inbound correlation header after Fastify has created the request; a caller that wants to adopt
inbound correlation configures it at Fastify construction with a validating `genReqId`. See
[Logging and Telemetry](/guides/logging-telemetry/#request-identity) for the recipe.

## Response policy and lifecycle hooks

Host response policy, such as cache headers, security headers or a marker header, is applied with a
Fastify lifecycle hook. Fastify owns the response transport for every strategy: a streamed page is
sent by returning a document Fastify consumes, exactly as an ordinary response returns a body. What
differs is *when* the response becomes irreversible - a streamed response commits as soon as its
first byte is delivered, and after that its status can no longer change.

Two questions decide whether a hook is a usable policy point, and they have different answers:

1. Is the hook **invoked**?
2. Does a header set there **reach the client**?

| Hook | SSR: invoked | SSR: header reaches client | Streaming: invoked | Streaming: header reaches client |
| --- | --- | --- | --- | --- |
| `onRequest` | Yes | Yes | Yes | Yes |
| `preParsing` | Yes | Yes | Yes | Yes |
| `preValidation` | Yes | Yes | Yes | Yes |
| `preHandler` | Yes | Yes | Yes | Yes |
| `preSerialization` | No | Not applicable | No | Not applicable |
| `onSend` | Yes | Yes | Yes | Yes |
| `onResponse` | Yes | No, already sent | Yes | No, already sent |

The table is identical for both installation shapes. It is verified against a real listener, not an
injected request, because header behaviour on a streamed response is only observable on the wire.

### Headers that depend on route data

A response header must be known before the shell byte. On a streamed page the shell is deliberately
sent before `attr.data` resolves, so a header whose value comes from a subrequest made inside the
route's data loader (a session cookie, a timing header, a cache key) cannot reach the client on that
strategy; `onSend` has already run. This is not a hook-ordering defect. It is what streaming means.

Two placements exist today:

- `attr.head` is the pre-byte work slot. It resolves before the document is handed to Fastify, so a
  subrequest made there finishes before `onSend`. The head loader has no header-setting API of its
  own; the host carries the value across in its own request-scoped state and sets it in `onSend`.
- A route whose response headers depend on body-data-time work should declare `render: 'ssr'`.
  There the whole page, and every subrequest behind it, is complete before `onSend` runs.

### A streamed response that fails before its first byte

A streamed page hands Fastify a document that has not started producing bytes. If rendering fails
before the first of them, Fastify never sent that document, so it falls back to its error path -
and it runs its send phase **once per payload**:

1. `onSend` is invoked with the streamed document that was about to be sent;
2. rendering fails before any byte reaches the client;
3. `onSend` is invoked again with the error representation Fastify sends instead;
4. `onResponse` describes the request **once**, as it always does.

This sequence belongs to a document Fastify has already been handed. A request that fails **before**
that - a configuration error, or a `preHandler` that throws - never produces a document at all, so
it takes Fastify's ordinary single error path with one `onSend`.

Write `onSend` hooks so they are safe across response attempts. Do not assume one invocation per
request, and do not assume the payload you are handed is the one the client receives.

A failure **after** the first byte cannot become an error response: the transfer is aborted with
whatever was already delivered.

### Replacing or wrapping the payload

An `onSend` hook may replace the streamed document outright. If it does, the renderer never runs at
all - the document is cold until Fastify consumes it - and the response completes with whatever the
hook returned.

A hook may also wrap the payload in a transform. **The wrapper must propagate source errors to the
stream it returns**: Node's `.pipe()` alone does not, so a wrapper built with it leaves a failed
response hanging rather than terminating. If the document's error has no other listener, it can
also surface as an uncaught exception. Compose the two ends and return the wrapper immediately -
**do not await the transformation**. Fastify consumes the wrapper's readable side, so nothing drains
it while you are awaiting: the request completes only if the entire document happens to fit in the
transform's high-water mark, and a document larger than that never completes at all. Awaiting is
therefore worst in production, where it can pass on a small page and deadlock on a real one:

```ts
import { Transform, pipeline } from "node:stream";

app.addHook("onSend", async (request, reply, payload) => {
  if (!payload || typeof (payload as NodeJS.ReadableStream).pipe !== "function") {
    return payload;
  }

  const wrapper = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });

  // `pipeline` forwards destruction in both directions, so a failing document
  // tears the wrapper down too. Not awaited: the stream is returned immediately.
  pipeline(payload as NodeJS.ReadableStream, wrapper, () => {});

  return wrapper;
});
```

Both `onRequest` and `preHandler` reach every strategy, so either covers all rendered pages. Which
one depends on what the policy is:

- **`onRequest`** for unconditional host-wide policy, such as security headers.
- **`preHandler`** for route-selected or authentication-sensitive policy, such as HTML caching. It
  runs after authentication and validation have succeeded, so a rejected request does not carry a
  header that assumed success.
- **`onSend`** for a deliberate transformation of the final response, once the caveats above are
  understood.

`onSend` reaches streamed responses as well as ordinary ones, because τjs hands Fastify a document
to send rather than taking over the socket. It is the right place for a deliberate transformation of
the final response, with the two caveats above: a pre-byte failure produces a second send pass, and
a wrapper must propagate source errors itself.

`preSerialization` runs only when Fastify serialises a payload. τjs page responses are an HTML
string or a raw stream, so neither shape is serialised. This is payload shape, not a τjs omission:
the same hook on the same server runs normally for a route returning an object.

`onResponse` is invoked for every strategy and is the right place to observe completion, including
the final status of a streamed response. It runs after the response has been sent, so it is an
observation point rather than a policy point.

### Where to register hooks

On a caller-owned instance, register hooks before passing the instance to `createServer`:

```ts
app.addHook('onRequest', async (_request, reply) => {
  reply.header('X-Host-Policy', 'applied');
});

await createServer({ config, fastify: app });
```

On a τjs-created instance, add them to the returned app before `listen()`:

```ts
const { app } = await createServer({ config });

app.addHook('onRequest', async (_request, reply) => {
  reply.header('X-Host-Policy', 'applied');
});

await app.listen({ port: 3000 });
```

Both flows reach τjs page routes, including the routes τjs registers in its own encapsulated scope.
The boundary is the server boot: Fastify rejects `addHook` once the instance has booted, so hooks
must be installed before `listen()`.

## Running τjs inside another runtime

Because a supplied instance keeps its own lifecycle, τjs can run as a subsystem of a larger Fastify
application without special support. It never calls `listen()`, never touches process lifecycle,
and releases what it owns, including the development Vite server, through ordinary `app.close()`.

This follows Fastify's plugin lifecycle and requires no provider-specific integration.
