---
'@taujs/server': patch
---

In development a template that fails to read at boot is still logged and the app is skipped, but the original failure is now retained and becomes the `cause` of the "Template not found" error a later request raises, for both server-rendered and fallthrough pages.

The SSR render module is resolved by probing `entry-server.js` then `entry-server.mjs` for an existing file before importing, so a build without `"type": "module"` (which Vite emits as `.mjs`) loads; when neither exists the error lists both candidates tried, and an existing module that fails to evaluate reports that failure rather than trying the other extension.

A related diagnostic was also corrected: the "Entry ... not found in manifest" error now carries its tried/available-keys detail directly on `details`, rather than nested inside `cause`.
