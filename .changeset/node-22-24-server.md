---
'@taujs/server': minor
---

Node 20 is no longer supported. The supported range is Node `>=22.12.0`: Node 22 and Node 24. The package now declares it in `engines`, so a package manager reports an unsupported Node at install time.

**BREAKING CHANGE** (released as `minor` under the repository's pre-1.0 convention - these packages are pre-1 and a `major` bump would declare τjs stable 1.0, which this work does not decide). Node 20 reached end-of-life on 2026-04-30. The test matrix now runs Node 22 and 24, and dependencies are free to require Node 22. If you are on Node 20, upgrade Node before taking this release.
