---
'@taujs/mcp': patch
---

Build graphs are now cited as declared topology: the staleness line for a `dist/.taujs/graph.json` says `emittedAt` is when the topology graph was emitted, not that every referenced application bundle was rebuilt then, and `taujs_overview`'s scope statement says the same. Filtered builds re-emit the graph for every declared app, so the previous wording let an agent report a selectively rebuilt deployment as wholly current.
