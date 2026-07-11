---
'@taujs/server': patch
---

Fix Vue streaming routes rendering the app twice in dev. The dev introspection stamp
was written as the first child of `#root` (before the streamed app HTML), which Vue
hydration reports as a node mismatch - it re-renders the whole app as a duplicate
sibling of the server-rendered tree. The stamp now lands in `<head>` on the streaming
path. React is unaffected either way (its hydration skips unexpected scripts) and was
verified against both playgrounds; production HTML never carried the stamp. The ssr
path (stamp after the app HTML, tolerated by both renderers) is unchanged.
