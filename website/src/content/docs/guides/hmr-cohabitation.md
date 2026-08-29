---
title: Combining HMR with Another Upgrade Consumer
description: Sharing one Fastify server's upgrade event between the mediated HMR transport and another WebSocket consumer.
---

This page applies only when `server.hmrTransport: 'mediated'` and your application already has
its own WebSocket consumer on the same Fastify instance. If HMR is the only thing offered
upgrades on your server, you do not need it - see the
[`server.hmrTransport` reference](/reference/taujs-config/#serverhmrtransport) instead.

## The generic rule

Node delivers every `upgrade` event on an HTTP server to every listener registered for it - no
listener can stop the others from also seeing it. Two consumers on one server therefore need:

- one dispatcher you own, installed on the server's `upgrade` event;
- a separate, never-`listen()`ed source per consumer, each consumer's own listener installed on
  its own source.

τjs supplies its own source internally; you never see or manage it. The dispatcher offers τjs
first refusal, and only falls through to the other consumer when τjs declines:

```ts
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
  if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) return;
  otherSource.emit('upgrade', req, socket, head); // the other consumer listens on otherSource
};
app.server.on('upgrade', onUpgrade);
app.addHook('onClose', async () => { app.server.off('upgrade', onUpgrade); });
```

`tryHandleUpgrade` never throws and never writes to a socket it does not claim - it either
returns `true` (the socket is τjs's HMR channel; do nothing more with it) or `false` (offer it
elsewhere). Whether the other consumer accepts a caller-supplied server to listen on, rather than
insisting on the Fastify instance itself, is a property of that consumer - not something τjs
can arrange on its behalf.

If your other consumer is `@fastify/websocket` 11.3.0, see the
[dedicated interoperability note](/guides/fastify-websocket-hmr/) for the exact shape and a
measured cleanup workaround.
