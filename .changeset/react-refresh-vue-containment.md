---
'@taujs/server': patch
---

Development: when React's compiler shares the development Vite server with Vue's renderer, τjs now disables oxc JSX fast refresh for that server and says so at boot, so Vue SSR routes render instead of failing with `$RefreshSig$ is not defined`. React edits fall back to a full reload in that composition only; production output was never affected. Contains an upstream `@vitejs/plugin-vue` defect (vitejs/vite-plugin-vue#798, fix pending in PR #814); the containment is removed once a plugin-vue release carries the fix.
