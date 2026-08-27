---
'@taujs/server': minor
---

The request graph now models a route's declared head-data edge (`route.head.data`) and counts it
in `services[].methods[].usedBy`. Before, a method reached only through `attr.head.data` was
emitted with `usedBy: []`, so the graph claimed no route used a method a route declared. Additive,
schema v1.
