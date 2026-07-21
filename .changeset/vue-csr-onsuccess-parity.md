---
'@taujs/vue': patch
---

`hydrateApp` now calls `onSuccess` after a successful CSR-fallback mount

Previously `onSuccess` fired only on the hydrate path; a successful client-side render fallback (no
SSR snapshot) established the application root but never reported it. It now calls `onSuccess(app)`
exactly once after a successful `app.mount(...)` on the CSR path, matching `@taujs/react`, whose
`onSuccess` already observes both hydrate and CSR root establishment. The CSR path still emits no
hydration beacon and no `onStart` (a CSR mount is not a hydration), and the observer stays isolated:
a throw is logged and the mounted app remains.
