---
'@taujs/create-taujs': patch
---

Generated applications ask the runtime-mode question the way τjs answers it. The server template
derived its debug setting from `process.env.NODE_ENV !== "production"`, which treats `test`,
`staging` and an unset variable as development while the server runs them as production. It now
reads `process.env.NODE_ENV === "development"`, with a comment stating the rule.

No behaviour change for `npm run dev` or `npm start`, which set `NODE_ENV` explicitly; the
difference appears when a supervisor, CI runner or container leaves it at some other value.
