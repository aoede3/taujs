---
'@taujs/create-taujs': patch
---

Fix the solid fastify pin drift (was ^5.2.0, now ^5.8.5 to match @taujs/server's peer) and derive the generated README's project tree and pins from the plan the scaffolder already acts on, so they cannot drift from the workspace again unnoticed.
