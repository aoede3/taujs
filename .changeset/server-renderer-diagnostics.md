---
'@taujs/server': patch
---

The required-renderer diagnostic and the other runtime messages that name renderer factories now name all four first-party factories (`reactRenderer()`/`vueRenderer()`/`solidRenderer()`/`htmlRenderer()`), following the addition of `@taujs/html`. No behavioural change.
