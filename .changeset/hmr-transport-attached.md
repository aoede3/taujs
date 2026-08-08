---
'@taujs/server': minor
---

feat(server): optional attached HMR transport for development (RFC 0013)

Adds `server.hmrTransport?: 'fixed-port' | 'attached'`, defaulting to `'fixed-port'` so
standalone development is unchanged.

`'attached'` carries the development HMR WebSocket on the application's own HTTP server
instead of a dedicated port, so it flows wherever that channel flows. This is what makes
development work where a second fixed port cannot be reached: a supervisor that virtualises
worker binds, a firewall, or a proxy forwarding only one channel. The served client then
derives its socket from the origin that served it rather than a hard-coded port.

The transport is never inferred - τjs does no host detection and reads no environment to
decide - and `'attached'` requires a τjs-created Fastify host. Supplying your own instance
with `'attached'` is rejected at configuration time, before any listener is installed or
reordered, rather than being silently ignored. Unknown values are rejected rather than
falling back. `hmrPort`, `HMR_PORT` and `--hmr-port` remain accepted so an existing
configuration can switch transport without being rewritten, but they do not select or alter
the attached channel.

Running an attached channel behind a proxy is host configuration, not τjs machinery: the host
must expose a real upstream, preserve the path prefix so the pathname reaching Vite matches
its base, and exclude client sources from its restart watcher. It also requires a trusted
development network, because proxies commonly drop `Origin` and rewrite `Host`, and Vite's
WebSocket admission checks depend on those headers. See the configuration reference.
