---
'@taujs/server': patch
---

`createServer({ port })` was declared but never read. It now sets the port between `config.server.port` and the environment, so a programmatic caller can pin or override the port without an env var or CLI flag. `port: 0` requests an ephemeral port.
