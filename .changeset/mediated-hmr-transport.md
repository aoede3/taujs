---
'@taujs/server': minor
---

Adds `server.hmrTransport: 'mediated'` for a caller-supplied Fastify host (mode B): the application offers τjs first refusal on each upgrade through a new `dev.hmr.tryHandleUpgrade(req, socket, head)` capability, returned from `createServer` in every mode and ownership. HMR then rides whatever channel the caller's own `upgrade` listener is on, without τjs attaching to or reordering listeners on a host it does not own. `'attached'` and `'fixed-port'` are unchanged.
