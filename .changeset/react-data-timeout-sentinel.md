---
'@taujs/react': patch
---

`streamOptions.dataTimeoutMs` accepts the `0`/`Infinity` no-bound sentinel, matching `shellTimeoutMs`

`dataTimeoutMs` was accepted unvalidated and handed straight to `setTimeout`, so `Infinity` (and other non-finite or out-of-range values) clamped to one millisecond and failed the response with "Route data not ready" whenever route data was still pending at shell commit. It is now validated at the factory and per call, with the same sentinels, the same 2_147_483_647 bound and the same `TypeError` as `shellTimeoutMs`, and the timer arms only for a finite positive value.

With no bound, a response whose shell has committed and whose route data never settles is held open indefinitely - the deferred deadline only governs deferred boundaries, so it cannot end it. That trade-off is now documented on the option; it is the caller's choice to make.
