---
'@taujs/server': minor
---

P0A-04: wire request-graph emission. Dev boot writes `node_modules/.taujs/graph.json` (`source: 'boot'`, registry-enriched) from a Fastify `onListen` hook — registered only inside the structural development gate via lazy dynamic import, so production never loads the introspection code at all. `taujsBuild` writes `dist/.taujs/graph.json` (`source: 'build'`, `services: null`) after successful builds. All artifact writes go through a shared `writeTaujsArtifact` helper: directory ensured, atomic tmp+rename, and non-fatal by contract — a failure warns once per boot and never breaks boot or build.
