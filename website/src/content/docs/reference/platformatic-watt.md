---
title: Platformatic Watt
description: The worked example of the supervisor and gateway contracts for Platformatic Watt 3.68.0 with the Gateway, and the certification it rests on.
pagefind: false
head:
  - tag: meta
    attrs:
      name: robots
      content: noindex, nofollow
---

This page is the worked example of [Running τjs Under a Supervisor or Behind a
Gateway](/guides/supervisors-and-gateways/) for Platformatic Watt 3.68.0 with the Gateway: the
generic checklist's five contracts, filled in with the concrete Watt settings that satisfy them.
It is not a τjs integration package - τjs contains no Platformatic dependency and does no
Platformatic detection; everything below is a consumer of ordinary τjs capabilities
(`createServer`, `hmrTransport`, `mountPrefix`/`publicBasePath`) from the host side. It rests on a
dated certification against the published packages listed in [What is
certified](#what-is-certified) below, 2026-08-30.

## Selection

Both modes from the generic guide apply unchanged.

**Mode A - τjs is the application.** The scaffold's own server, with a `create()` export that
Watt supervises instead of the scaffold calling `app.listen()` itself. `hmrTransport: 'attached'`.
This is the shape closest to Platformatic's first-party frontend capabilities: one application,
one Fastify instance, Watt owns the process.

**Mode B - τjs is embedded in an existing Fastify application.** The application's own `create()`
builds Fastify and installs τjs. `hmrTransport: 'mediated'`. This is the advanced embedded form -
useful when the Fastify instance already carries other routes, other WebSocket consumers, or
Watt's own logger and request-id policy, and τjs is one capability among several on it.

Neither mode is more Watt-native than the other; the choice is the same ownership question the
generic guide poses, answered once per application.

## Shared Watt configuration

Each item below maps to its contract number in the generic guide.

### 1. WebSocket hand-off

The primary setting is `websocket: true` on the application in `watt.json`:

```json
{
  "applications": [
    { "id": "web-a", "path": "apps/web-a", "websocket": true, "env": { "NODE_ENV": "development" } },
    { "id": "web-b", "path": "apps/web-b", "websocket": true, "env": { "NODE_ENV": "development" } }
  ]
}
```

`useHttp: true` is the broader alternative, for an application that needs its full HTTP surface
exposed rather than only a WebSocket hand-off. For HMR the two are equivalent on
`@platformatic/node`: both hand WebSocket upgrades to the application's own TCP listener, so every
combination of transport and path connects the same under either flag. `websocket: true` is
preferred because it declares exactly what is needed.

### 2. Prefix preservation and admission

The Gateway's `proxy.prefix`/`rewritePrefix` must equal τjs's `mountPrefix`/`publicBasePath` for
the same application, and the Gateway's internal hostname for it must be declared in
`vite.server.allowedHosts`, or Vite's host check rejects the served client:

```jsonc
// watt.json
{ "gateway": { "applications": [
  { "id": "web-a", "proxy": { "prefix": "/a", "rewritePrefix": "/a" } }
] } }
```

```ts
// taujs.config.ts
server: { mountPrefix: '/a', publicBasePath: '/a' },
vite: { server: { allowedHosts: ['web-a.plt.local'] } },
```

### 3. Restart-watcher scope

The measured scope, per application's `watt.json`:

```json
{
  "watch": {
    "enabled": true,
    "allow": ["src/**", "taujs.config.ts", "watt-entry.ts"],
    "ignore": ["dist", "dist/**", "node_modules", "node_modules/**", "**/.vite/**", "src/client/**"]
  }
}
```

`@platformatic/node` rebuilds the application before every worker start, in development as well
as production, so the pre-start build rewriting `dist/` is itself a watched-directory write.
The `allow` list is what keeps that write from restart-looping the worker: without it, and with
`dist` unignored, each start's build triggers the next restart. `ignore` for `dist`/`dist/**` is
belt-and-braces under the narrowed allow-list;
`src/client/**` in `ignore` is what keeps a client edit delivering an HMR update instead of
restarting the process.

### 4. Admission through the Gateway

Measured, on a WebSocket upgrade through the Gateway: `Origin` dropped, `Host` rewritten to the
application's own upstream address, no `x-forwarded-*` headers added. On mesh HTTP requests (the
ordinary page and asset traffic between Gateway and application) the behaviour differs: `Host`
becomes the application's `.plt.local` name and `x-forwarded-*` headers are added. Only the
upgrade path is admission-relevant: Vite's token check only runs when `Origin` is present, so a
proxied upgrade through the Gateway never reaches it, and valid, missing and invalid tokens all
connect equally. A classification, not a defect in either τjs or the Gateway - the same
requirement the [`server.hmrTransport` reference](/reference/taujs-config/#serverhmrtransport)
states generically: a trusted development network.

### 5. Lifecycle

`wattpm dev` runs each application's own build before every worker start, including in
development. `wattpm build` then `wattpm start` is the production sequence. `NODE_ENV` is
supplied through the runtime config's per-application `env` block, not through the scaffold's
`cross-env` npm scripts - Watt does not run those scripts, so the value has to be configuration:

```json
{ "id": "web-b", "env": { "NODE_ENV": "development" } }
```

On `kill -TERM`, teardown happens exactly once per application: one Stopping and one Stopped
each, zero unexpected starts, the Mode B caller's root listener count going from one to zero, and
every port silent afterwards.

## The entry files

`@platformatic/node` requires a module exporting `create()` that returns the application; the
supervisor owns listening. The scaffold's own `src/server/index.ts`, which calls `app.listen()`
itself, is left untouched and still works standalone - a separate `watt-entry.ts` is added and
`package.json`'s `"main"` points at it.

### Mode A entry

```ts
import { join } from 'node:path';
import { createServer } from '@taujs/server';
import config from './taujs.config.ts';
import { serviceRegistry } from './src/server/services/registry.ts';

const appRoot = import.meta.dirname;

export async function create() {
  const isDev = process.env.NODE_ENV === 'development';
  const { app } = await createServer({
    config,
    serviceRegistry,
    debug: isDev ? { ssr: true } : false,
    clientRoot: join(appRoot, isDev ? 'src/client' : 'dist/client'),
    projectRoot: appRoot,
  });
  if (!app) throw new Error('Mode A: expected a taujs-created Fastify application');
  return app;
}
```

`clientRoot` and `projectRoot` are absolute - a Watt worker's current directory is the runtime
root, not the application directory, so the scaffold's implicit `process.cwd()` defaults would
resolve against the wrong location. The development predicate is `NODE_ENV === 'development'`,
exactly as the scaffold's own entry has it. Passing `logger: getLogger()` (optional, not shown
above) gives a Mode A application the same structured Watt log lineage Mode B gets below through
`loggerInstance`.

### Mode B entry

```ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getLogger } from '@platformatic/globals';
import Fastify from 'fastify';
import { createServer } from '@taujs/server';
import config from './taujs.config.ts';
import { serviceRegistry } from './src/server/services/registry.ts';

const appRoot = import.meta.dirname;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9-_:.]{1,128}$/;

export async function create() {
  const logger = getLogger();
  const isDev = process.env.NODE_ENV === 'development';

  const app = Fastify({
    loggerInstance: logger,
    genReqId(raw) {
      const incoming = raw.headers['x-request-id'];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  // Caller root policy: an active CSP header and a marker on every response.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'");
    reply.header('x-host-policy', 'watt-mode-b');
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', marker: 'caller-not-found', url: req.url });
  });
  // Registered under the public prefix - see "Two measured behaviours" below.
  app.get('/b/host/before', async () => ({ host: 'before', marker: 'caller-route' }));

  const tau = await createServer({
    config,
    serviceRegistry,
    fastify: app,
    debug: isDev ? { ssr: true } : false,
    clientRoot: join(appRoot, isDev ? 'src/client' : 'dist/client'),
    projectRoot: appRoot,
  });
  if (tau.app !== undefined) throw new Error('Mode B: createServer must not return an app for a caller-owned Fastify');

  // RFC 0014 section 1 mediation recipe, verbatim.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) return;
    socket.destroy();
  };
  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', async () => { app.server.off('upgrade', onUpgrade); });

  return app;
}
```

`loggerInstance: getLogger()` puts τjs's own boot and request lines on Watt's structured logger,
carrying Watt's `worker`/`name` fields alongside τjs's typed `component` keys, with no banner.
`genReqId` adopts a safe inbound `x-request-id` and regenerates an unsafe one, so request identity
is the caller's decision end to end. A caller route registered before `createServer` and one after
both answer unchanged - τjs never reorders or removes what the caller has registered. If the same
Fastify instance already carries another WebSocket consumer beside τjs, see [Combining HMR with
Another Consumer](/guides/hmr-cohabitation/) for the shared-dispatcher shape.

## Configuration and package deltas

`taujs.config.ts` adds one field to what section 2 already showed - the transport itself:
`server.hmrTransport: 'attached'` for Mode A, `'mediated'` for Mode B.

`package.json` is pinned rather than the scaffold's generated `"latest"`, and gains the Watt
pieces:

```json
{
  "dependencies": { "@taujs/react": "0.8.2", "@taujs/server": "0.30.0", "fastify": "5.12.1" },
  "devDependencies": { "vite": "8.2.1", "@platformatic/node": "3.68.0" },
  "main": "watt-entry.ts"
}
```

Mode B additionally takes `@platformatic/globals` as a runtime dependency, for `getLogger()`.

## Two measured behaviours worth knowing

**Caller routes must be registered under the public prefix.** Under a preserve-prefix Gateway
(`proxy.prefix`/`rewritePrefix` equal to `mountPrefix`/`publicBasePath`), the public prefix is
part of the path the application receives, so a Mode B caller route registered at the
application's own root is not reachable through the Gateway - only a route registered under the
same public prefix is. One observation to be aware of: the caller's not-found handler sees a
request `url` with that prefix already removed, while the worker's request log shows the full
path. τjs never rewrites `url`, and plain Fastify 5.12.1 in the same prefixed, encapsulated shape
hands a root not-found handler the full path; how the hosted arrangement arrives at the shorter
`url` was not pursued. Treat the `url` a not-found handler observes under Watt as the
application-relative path, not the public one.

**On τjs pages, the CSP header is τjs's own.** A caller-set `content-security-policy` survives on
every caller-owned route and on the caller's 404, unchanged. On a τjs-rendered page, τjs replaces
it with its own development policy, because its rendered page carries inline scripts that need
its nonce. Other caller headers set the same way (a marker header, for example) survive
everywhere, including on τjs's own pages - only `content-security-policy` on τjs's own responses
is τjs's.

## What is certified

Node 22.19.0, `@taujs/server` 0.30.0, `@taujs/react` 0.8.2, `@taujs/create-taujs` 0.8.0,
Platformatic (`wattpm`, `@platformatic/node`, `@platformatic/gateway`, `@platformatic/runtime`,
`@platformatic/globals`) 3.68.0, Fastify 5.12.1, Vite 8.2.1. Dated 2026-08-30.

| Cell | Result |
| --- | --- |
| C1 production runtime-import isolation | Zero build-tool modules in either production worker's module graph, both modes |
| C2 non-root production links | Every τjs-emitted script, stylesheet and asset URL carries the public prefix and returns 200 |
| C3 Gateway development, no environment workaround | `NODE_ENV` from the runtime config only; 200 through the Gateway, both modes |
| C4 HMR direct and through the Gateway | Connected, one attributed update, byte-identical restore - both modes, both paths, both `websocket`/`useHttp` |
| C5 two prefixed applications, isolated HMR | No cross-talk between an attached and a mediated channel; 0 stops / 0 starts |
| C6 exactly-once development teardown | One Stopping and one Stopped per application; Mode B root listener 1 to 0; ports silent |
| C7 Mode B ownership | Caller routes, not-found policy, CSP marker and Watt logger lineage all intact (two findings recorded above) |
| C8 build/dist restart loop, watcher scope | Loop absent with the ruled scope; `watch.allow` is the load-bearing half |
| C9 admission classification | `Origin` dropped, `Host` rewritten, token bypass through the Gateway; direct refuses missing and invalid tokens |

## What is not certified

Other Platformatic versions; other supervisors or gateways - see the generic [Running τjs Under a
Supervisor or Behind a Gateway](/guides/supervisors-and-gateways/) guide, which any host can be
checked against directly; production HMR - none exists, in any mode, on any host. Platformatic is
a consumer of ordinary τjs capabilities here, not a τjs-provided integration: there is no
`@taujs/watt` package.
