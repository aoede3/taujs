---
'@taujs/server': minor
---

One runtime-mode derivation replaces the scattered `NODE_ENV` comparisons. Development must be
requested explicitly; `production`, `test`, unset and any other value (`staging`, `ci`, a typo)
are one production mode, resolved once and snapshotted at module evaluation.

This fixes a real boot failure. Two derivations disagreed about every value that was neither
literal: the client root partitioned on `=== 'production'` (so `test` and unset selected
`src/client`) while asset loading partitioned on `=== 'development'` (so the same values took the
production branch). The result was a development client root with production asset loading, i.e. a
guaranteed `src/client/.vite/manifest.json` ENOENT at boot - an infinite crash-loop under a
supervisor that restarts failed workers, and the reason `NODE_ENV`-unset hosts such as
Platformatic Watt workers could not boot a τjs application at all.

An unset `NODE_ENV` now selects production mode consistently. With built assets present, the
application boots from `dist/client` instead of incorrectly reading production manifests from
`src/client`. An explicitly supplied `clientRoot` remains authoritative in every mode.

Intentional behaviour changes when `NODE_ENV` is `test`, unset, or any value other than
`development` and `production`. Each was previously treated as non-production:

- the client root is `dist/client`, not `src/client`
- the runtime logger minimum level is `info`, not `debug`, in both fallback constructions. Debug
  records are a development facility, so `debug` options no longer produce debug output in these
  environments
- log timestamps are ISO, not `HH:mm:ss.SSS`
- warning records strip stacks by default
- a missing global CSP raises the production advisory, in the boot summary and in the security
  contract report (status `warning` with the production tail note)

Set `NODE_ENV=development` for the development loop, as the scaffolded scripts already do. No
public API changes: the derivation is internal, and `resolveRuntimeMode` is not exported from the
package.
