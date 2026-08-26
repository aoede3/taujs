---
'@taujs/solid': patch
---

Timeout validation gains the upper bound Node can actually honour

`@taujs/solid` already rejected a `shellTimeoutMs` that was neither a sentinel nor a positive finite number, and already refused to arm a timer for one. It did not bound the value from above, and it should have: Node stores a delay as a 32-bit signed integer, so `2_147_483_648` and larger are clamped to one millisecond with a `TimeoutOverflowWarning` - the same failure `Infinity` produces, arriving through a value that does not look like a sentinel.

The shared validator now accepts `0`, `Infinity`, or a positive number of milliseconds no greater than 2_147_483_647, and its message states the range. It is used for `streamOptions.shellTimeoutMs`, `streamOptions.completionTimeoutMs` and `ssrOptions.prerenderTimeoutMs`, so all three gain the bound. The sentinels are now documented on the public type rather than only in internal comments.

This was found by the shared renderer conformance vector introduced alongside it: solid was the reference implementation the other two were brought into line with, and running the vector against it surfaced a defect all three shared.
