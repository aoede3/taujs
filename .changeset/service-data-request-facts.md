---
'@taujs/server': minor
---

`serviceData()` mappers now receive a second argument, `ServiceDataRequestFacts`: a frozen copy of the request's `url` and `headers`. A declared single-service edge can map query state (sort, filters, variant selection) and specific header values into explicit service params, without falling back to a hand-written closure that loses the declared edge. Existing one-argument mappers and mapper-free calls are unaffected. The facts view does not grant the mapper τjs's request-scoped registry caller; mappers should remain synchronous, side-effect-free argument translations.
