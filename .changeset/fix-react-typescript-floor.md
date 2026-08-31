---
'@taujs/react': minor
---

Raise the TypeScript peer floor to `^5.6.2`.

`@vitejs/plugin-react` 5.2's published declarations require TypeScript 5.6 or later to parse; a consumer on TypeScript 5.5.x that reaches the `/renderer` or `/plugin` entry could not typecheck. The declared floor now matches the measured minimum, so the peer range no longer advertises a combination that fails to compile.
