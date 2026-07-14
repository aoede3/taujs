---
'@taujs/create-taujs': patch
---

Scaffold a commented `vite` / `alias` stub in the generated `taujs.config.ts`, pointing at the declared Vite customisation surface (RFC 0005, VS7). This is the discoverability moment for the new fields - no `vite.config.ts` is ever scaffolded, since τjs never reads one.
