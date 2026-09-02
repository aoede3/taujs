---
'@taujs/server': minor
---

Request time budget: opt-in `server.requestBudgetMs` creates one monotonic request budget as soon as τjs begins handling the request - before any pre-render work - placed on the service context as `ctx.budget` (`deadline`, `signal`, `remaining()`, `child(reserveMs)`, `dispose()`). Nested `ctx.call()` work always inherits this same budget instead of manufacturing new time, so a call made later in the chain, or after pre-render work has already spent some of the allowance, sees what is actually left. Service work that cannot possibly fit refuses to start rather than beginning anyway, following the normal service-call failure path.

Left unset (the default), behaviour is unchanged byte-for-byte: no budget is created and `ctx.budget` is `undefined`. `requestBudgetMs` must be a positive finite number of milliseconds no greater than 2,147,483,647 (the largest delay `setTimeout` honours). `deadlineMs` and `withDeadline()` are deprecated in favour of `ctx.budget` - they start a fresh relative timer per call, so a nested call receives a new full allowance instead of the time remaining on the request - but remain unchanged and fully functional.

V1 is deliberately bounded: an exhausted budget refuses new service work and aborts `ctx.budget.signal`, but never aborts the request's own render or response. Once the response reaches its terminal, τjs disposes the budget's timer without aborting `signal` or changing `remaining()`, so a deferred service call still in flight past that point still refuses once genuinely past the deadline - it only loses the chance to observe a late `signal` abort.
