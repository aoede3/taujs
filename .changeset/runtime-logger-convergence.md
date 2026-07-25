---
'@taujs/server': patch
---

Converge τjs runtime logging on the selected Fastify, explicit, or standalone
logger, preserving request correlation, Pino policy, and CSP reporting across
the server lifecycle.

Custom structured sinks now receive the raw semantic message instead of a
τjs-formatted timestamp and level prefix. This corrects the documented
`BaseLogger` contract; consumers parsing the previous embedded prefix should
use their sink's structured timestamp and level fields instead.
