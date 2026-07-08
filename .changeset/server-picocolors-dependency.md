---
'@taujs/server': patch
---

Declare `picocolors` as a dependency. It is imported at runtime (logging, network, and server bootstrap) but was previously undeclared and resolved only via package hoisting — which fails under pnpm's strict `node_modules` layout and for consumers installing the package on its own.
