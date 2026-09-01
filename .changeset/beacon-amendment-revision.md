---
'@taujs/server': patch
---

Hydration beacon amendments now reach the on-disk episode mirror promptly. A beacon virtually always amends an episode that has already finalised, and the amendment did not advance the episode revision the file emitter polls, so `episodes.ndjson` kept `client: null` for that episode until an unrelated later episode finalised or the server closed. `clientHydration` now advances the revision when it amends a finalised episode, matching the existing late-deferred-outcome behaviour, so the hydration outcome appears through the ordinary bounded rewrite.
