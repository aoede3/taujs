---
'@taujs/vue': patch
---

R2-03: close the two vue-side sweep items (twin of react's R2-01/R2-02).

- **Missing root is now reported.** A missing root element in `hydrateApp`'s bootstrap previously
  logged and returned silently; it now also emits a `hydration:error` beacon and calls
  `onHydrationError` (mirroring react's R2-01). It emits an error WITHOUT a preceding `hydration:start`
  (hydration never began; vue already does this for a setupApp failure). The `onHydrationError` call is
  isolated so a throwing observer cannot escape bootstrap.
- **Bootstrap attributes are escaped (SEC2).** The manually-written streaming bootstrap `<script>` now
  passes its `src` (bootstrapModules) and `nonce` (cspNonce) through the shared `escapeHtml`.
  Defence-in-depth: `escapeHtml` is a no-op on clean module URLs and base64 nonces, so the tag is
  byte-unchanged for valid input.

No behaviour change on the success path. Vue's existing hydration-phase/single-settlement machinery is
unchanged (the missing-root case precedes it).
