---
'@taujs/server': patch
---

`resolveEntryFile` now requires the entry candidate to be a regular file. A directory named like an entry (for example `entry-client.ts/`) is skipped instead of being reported as the entry and failing later at bundling or on the first dev request.
