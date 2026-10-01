---
'@taujs/server': minor
---

Each development boot writes its introspection substrate under node_modules/.taujs/boots/<bootId>/ and never touches another boot's folder; dev.json is written first with state active and last with state closed; closed or dead-pid sibling folders are swept on start; boot graphs carry bootId under schema version 3.
