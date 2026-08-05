---
'@taujs/server': minor
---

A declared `vite.server.allowedHosts` now reaches the development server, so τjs can run behind a proxy.

Vite 6.1+ rejects any request whose `Host` is not localhost-like unless `server.allowedHosts` permits it - a DNS-rebinding defence. A reverse proxy or process supervisor commonly presents such a host, and development behind one then answered Vite's 403 block page instead of the application, with no supported way to allow it: τjs composed its dev config by writing `server` as a whole object **after** the user's, silently discarding the declared field.

The composition now merges. The framework stays authoritative for exactly two fields:

- `server.middlewareMode` stays `true` - τjs owns the request pipeline;
- `server.hmr` is derived from the resolved dev host and port, and is replaced **whole** rather than deep-merged. A partly-user, partly-framework `hmr` would pair a user port with a framework host and fail in a way that looks like a τjs bug.

Both remain warned-and-dropped invariants if declared, alongside `root`, `configFile` and the rest.

The admitted surface is deliberately one field, `server.allowedHosts`:

```ts
// taujs.config.ts
export default {
  vite: {
    server: { allowedHosts: ['app.internal'] },
  },
};
```

Everything else under Vite's `server` stays withheld, each for a reason: `ws: false` would disable the WebSocket connection HMR runs on; `host`, `port`, `strictPort`, `https` and `open` configure Vite's own HTTP listener, which does not exist in middleware mode because Fastify owns it; and `proxy` overlaps caller-route ownership. Supplying any of them **in development** warns and is not applied; in a build the whole `server` object is stripped silently, so nothing under it warns there. More can be admitted later, one at a time, with evidence that each works in middleware mode.

The security posture is narrowed, never removed: a host you have not declared is still refused.

`server` is development-only, and now behaves like `optimizeDeps` on the build side: absent from client and SSR builds **silently**. `config.vite` is one declaration feeding the development server and every app build, so warning there would report the recipe above as misuse, once per app, on every build.
