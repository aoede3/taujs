---
title: Running τjs Under a Supervisor or Behind a Gateway
description: Choosing an HMR transport by who owns Fastify, and the host contracts a supervisor, gateway or ingress must satisfy to carry it through development.
---

Development HMR needs a channel from the browser to Vite. Which channel is available, and who
is responsible for keeping it open, follows from who owns the Fastify instance - the same
ownership question the rest of τjs is organised around. This page names the resulting host
contracts once, so a supervisor, gateway or ingress can be checked against them without
re-deriving the reasoning each time. Transport semantics live in the
[`server.hmrTransport` reference](/reference/taujs-config/#serverhmrtransport); sharing one
server's upgrades with another consumer is covered in
[Combining HMR with Another Consumer](/guides/hmr-cohabitation/). This page assumes both.

## Choose the mode by who owns Fastify

### Mode A: τjs is the application

τjs creates the Fastify instance. This is the shape τjs's first-party framework integrations
take, and it is also the simpler host contract: τjs's own HTTP server carries the HMR channel,
so there is nothing else to wire. Select it with `hmrTransport: 'attached'`.

### Mode B: τjs is embedded in an existing Fastify application

You supply the Fastify instance to `createServer`. τjs never attaches to a host it does not
own, so instead your own `upgrade` listener offers τjs first refusal on each upgrade, through a
returned capability. Select it with `hmrTransport: 'mediated'`. The whole developer experience
is this:

```ts
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const tau = await createServer({ fastify: app, config }); // config.server.hmrTransport = 'mediated'

const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
  if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) return;
  socket.destroy(); // the application decides what happens to upgrades that are not τjs's
};
app.server.on('upgrade', onUpgrade);
app.addHook('onClose', async () => { app.server.off('upgrade', onUpgrade); });
```

`tryHandleUpgrade` never throws. It returns `true` when the upgrade is τjs's HMR channel -
handed to Vite, nothing more to do - and `false` when it is not, so your fallback branch stays
authoritative.

### Selection

| | Mode A - τjs is the application | Mode B - τjs is embedded |
| --- | --- | --- |
| Fastify instance | τjs creates it | You supply it to `createServer` |
| `hmrTransport` | `'attached'` | `'mediated'` |
| Who owns the upgrade listener | τjs, on its own server | You, via `dev.hmr.tryHandleUpgrade` |
| What τjs changes on your root's `upgrade` listeners | Not applicable - it is τjs's root | Nothing - it does not install, remove or reorder them |
| What τjs does install on your root | Not applicable | In development only, one `onRequest` hook that delegates unmatched Vite requests to the development server it owns (see [Architecture](/guides/architecture/)) |
| Rejected combination | `'mediated'` (needs no mediation) | `'attached'` (you do not own the host) |

Both rejections happen at configuration time, before Vite installs anything. An unknown
`hmrTransport` value is rejected in every mode, and both `'attached'` and `'mediated'` are
accepted and inert in production.

## The five host-owned contracts

Whichever mode you choose, carrying the channel through a supervisor, gateway or ingress
depends on host behaviour τjs does not run. Each contract below is stated as what τjs
guarantees on its side, and what the host must provide on the other.

### 1. A real TCP path for the upgrade

**τjs guarantees:** the browser-facing HMR dial stays on the same public channel as the page
itself - neither transport opens a second, separately reachable port.

**The host must provide:** a real TCP path from the gateway or proxy to the application's own
HTTP server, the same server the upgrade needs to reach. Measured behaviour: a gateway with no
TCP path to the application has no upstream to dial, and rejects the upgrade before it ever
reaches the application, rather than forwarding a broken one.

### 2. Prefix preservation

**τjs guarantees:** the pathname Vite expects for the HMR handshake is derived from the same
`mountPrefix` and `publicBasePath` the application is configured with, so the served client and
the server-side check agree.

**The host must provide:** a proxy that preserves that prefix, or reconstructs it before the
request reaches the application, rather than stripping it. A stripping proxy delivers the
upgrade at a pathname that does not match the base Vite expects, and the handshake never
completes. Under `'mediated'`, a mismatched offer is classified as not τjs's and is never
claimed, so the never-wired warning (below) will fire; under `'attached'`, the same mismatch
fails at Vite's own guard with no equivalent diagnostic.

### 3. Restart-watcher scope

**τjs guarantees:** neither transport tells the host anything about its own file watcher - τjs
carries no watcher-scope code and makes no assumption about how the host decides to restart.

**The host must provide:** client sources and build output excluded from whatever triggers a
restart. Without that exclusion, an edit both delivers an HMR update and restarts the process
underneath it, or a rebuilt output directory restart-loops the worker. The trade-off: an
allow-list narrow enough to stay quiet also stops configuration and package changes from
restarting the process, so the scope should be chosen knowingly, not left at its broadest
default.

### 4. Admission through rewriting proxies

**τjs guarantees:** no admission checking of its own. Vite's own host and token checks are the
only defence, and they run exactly as they would on a direct connection.

**The host must provide:** a trusted development network. Measured behaviour: a proxy that
drops the `Origin` header and rewrites `Host` - common rewriting-proxy behaviour - defeats
Vite's admission, because the token check only runs when `Origin` is present. Valid, missing
and invalid tokens then all connect equally. The guarantees that hold on a direct connection -
a declared host and a valid token admitted, everything else refused - do not project through
such a proxy.

### 5. Lifecycle: build before start, close exactly once

**τjs guarantees:** on close, it releases the development Vite server exactly once, and nothing
accumulates across repeated boot/close cycles on the same process. On a caller-owned root it
installs, removes or reorders no `upgrade` listener; its one root `onRequest` delegation hook
(development only) is released with the application scope.

**The host must provide:** the application built before it is started or restarted, not
concurrently, so the process that starts serves current output; and a stop sequence that closes
it so the caller's own listener count goes from one to zero exactly once. One ordering detail
worth knowing on Mode B: Fastify runs `onClose` hooks last-registered-first, so a listener
you remove in your own `onClose` (registered after `createServer`) is removed *before* τjs's
own release hook runs. An upgrade offered from inside your own `onClose` is still claimable
right up until that point.

## Checklist

Hold any supervisor, gateway or ingress against these five questions before relying on it for
development HMR:

- Does a WebSocket upgrade have a real TCP path from the gateway to the application?
- Does the proxy preserve, or reconstruct, the mount prefix on the upgrade path, matching
  `mountPrefix` and `publicBasePath`?
- Does the restart watcher exclude client sources and build output from whatever triggers a
  restart?
- Does the proxy preserve `Origin` and `Host` on WebSocket upgrades - and if not, is this a
  development network you trust?
- Does the host build the application before starting it, and close it exactly once?

## What this covers, and what it does not

These are properties of the host's proxy and WebSocket behaviour, not of τjs, measured so far on
one host runtime. Other supervisors, gateways and ingresses are expected to be compatible when
they satisfy the five contracts above, but they are not individually certified by that
measurement - each host's own proxy and watcher behaviour is the thing to verify.
