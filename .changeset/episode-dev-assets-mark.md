---
'@taujs/server': minor
'@taujs/mcp': patch
---

Development episodes carry a `devAssetsReady` timeline mark, recorded when Vite has loaded the render module and transformed the template for the request. The time between `matched` and `dataStart` is now attributable: on a boot's first request to an app it is mostly Vite's cold module load, not the route's loader. `EpisodeRecorder` gains the matching `devAssetsReady` method, and the MCP episode type and schema name the mark.
