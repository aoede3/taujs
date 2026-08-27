---
'@taujs/server': patch
---

In development, an author's own `<style type="text/css">` block in `index.html` was stripped from every server-rendered and fallthrough page (production kept it), because the dev template strip was origin-blind. The strip now removes only the `/@vite/client` script tag it exists to dedupe.

τjs's injected style block never accumulated - the template map is read-only after boot - so nothing else changes.
