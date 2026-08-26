---
'@taujs/vue': patch
---

`streamOptions.shellTimeoutMs` is validated, with an upper bound Node can actually honour

An invalid `shellTimeoutMs` was accepted silently and handed straight to `setTimeout`. Node stores a delay as a 32-bit signed integer and clamps an out-of-range or `NaN` delay to one millisecond, so `NaN`, `-1`, `Infinity` or any value above 2_147_483_647 did not mean "no bound": the shell watchdog fired almost immediately and failed every render whose shell suspended at all. `Infinity` and the out-of-range values additionally emitted a `TimeoutOverflowWarning` on every request. An untyped value may also coerce rather than clamp - `'10'` becomes a ten-millisecond delay, not one - which is a different symptom but the same absence of a contract.

`streamOptions.shellTimeoutMs` is now validated at the factory: `0` and `Infinity` are sentinels meaning no bound, anything else must be a positive number of milliseconds no greater than 2_147_483_647, and anything else again is a `TypeError` naming the option. The sentinels are documented on the public type rather than only in internal comments.

The shell timer arms only for a finite positive delay, so a sentinel means what it says. A per-call `shellTimeoutMs` passed to `renderStream` is validated at that boundary too: it never passes through the factory, and without this an invalid override would have moved from firing the watchdog immediately to silently disabling it, which is quieter and worse.

The rule is pinned by a shared conformance vector that `@taujs/react`, `@taujs/vue` and `@taujs/solid` each run in their own test environment, including the exact message text.
