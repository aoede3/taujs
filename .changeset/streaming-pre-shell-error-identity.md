---
'@taujs/server': patch
---

A streaming route whose loader or renderer fails before the first document byte now keeps its original error status and envelope, even when a payload transform such as compression sits between the document and the wire and reports its own stream error instead of the original one. The abandoned content encoding is cleared before the replacement body is sent, so it decodes correctly. Post-byte failures are unaffected and continue to abort the transfer.
