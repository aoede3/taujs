---
'@taujs/solid': patch
---

`@taujs/solid` no longer declares `seroval` as a runtime dependency. The error sanitiser is a plain plugin object consumed by the `seroval` that `solid-js` itself installs, and the renderer's only runtime call into the package returned its argument unchanged. With solid-js 1.9.16 and later, which depend on seroval 1.6, the renderer's own pinned 1.5.5 copy could be hoisted above solid-js's by npm and handed to `seroval-plugins`, which then failed to import on the first server render. A fresh install of a generated Solid project now holds one `seroval`, solid-js's own, and the renderer's behaviour is unchanged.
