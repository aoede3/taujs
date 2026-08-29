---
title: "@fastify/websocket Interoperability"
description: A version-pinned note on cohabiting the mediated HMR transport with @fastify/websocket 11.3.0.
---

This page is a **version-pinned interoperability note**, not part of the τjs API. It applies only
when your application registers `@fastify/websocket` 11.3.0 on a Fastify server that also uses
`server.hmrTransport: 'mediated'`. Read the
[general cohabitation guide](/guides/hmr-cohabitation/) first if you have not already - this page
assumes the generic dispatcher pattern it describes.

## The shape

`@fastify/websocket` accepts an `options: { server }` and listens on that server instead of
`fastify.server`. Give it a server dedicated to it and nothing else, register your dispatcher on
the Fastify instance's own server, and pair it with the `preClose` workaround below:

```ts
await app.register(websocket, {
  options: { server: wsSource },
  preClose(done) {
    for (const c of this.websocketServer.clients) c.close(1000, 'server closing');
    this.websocketServer.close(() => {
      wsSource.removeAllListeners('upgrade');
      done();
    });
  },
});
```

## Why the workaround exists

This is a workaround for a **measured upstream cleanup defect**, not a τjs design choice.
`@fastify/websocket` 11.3.0's default `preClose` removes its listener from `fastify.server` -
but when it was configured with a dedicated `options.server`, that listener was never on
`fastify.server` to begin with. Without the override above, the dedicated server keeps carrying
the plugin's listener after the application closes.

The workaround above uses only public facilities of the dedicated server you created for this
plugin - never τjs internals, and never a search-and-replace of the plugin's own listener. It
belongs in this note only until a corrected upstream release removes the need for it; do not
carry it forward once you can confirm the running version resolves it.

## What this does not cover

This note describes cohabitation with `@fastify/websocket` specifically. The workaround is
intrinsic neither to τjs nor to any particular host or runtime - it exists only because of the
measured 11.3.0 cleanup behaviour above, and is removed from this note once a corrected upstream
release ships. τjs's own mediated HMR transport never depends on `@fastify/websocket` and carries
no reference to it in its public surface.
