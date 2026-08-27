---
'@taujs/mcp': minor
---

Runtime tools stop reporting what they could not establish

These tools are an agent's evidence, and every defect below shares one mistake: absence was reported as knowledge.

**A live pid is no longer taken for a live boot.** Pids are recycled, and a crashed boot's `dev.json` survives because the server removes it only on graceful close, so `active` could describe a dead boot and its `bootId` filter then passed that boot's records through as current. `@taujs/server` now advances `dev.json`'s mtime on the poll tick it already runs, and a boot is active only while that heartbeat is fresh. A `@taujs/server` older than this release does not heartbeat, so it reads stale and the message says to upgrade it.

**`dev.json` is validated before it can make a boot active.** It used to be a cast, so a partial document with a live pid became `active` with `bootId` undefined, which skipped the episode reader's boot filter and served an old boot's episodes as current. A `dev.json` that does not parse, lacks a field a boot always writes, or carries an empty `bootId` now reads as stale with `dev_json_invalid` - even when no other artefact exists; additive fields are tolerated.

**Refusals say why.** `no_dev_json`, `dead_pid`, `heartbeat_expired`, `dev_json_invalid` and `dev_json_unreadable` arrive as `staleReason` alongside the existing refusal contract.

**Artefact paths are derived, never taken from `dev.json`**, and each is resolved to its real path and required to be a regular file beneath the real `.taujs` directory. A symlink inside `.taujs` pointing elsewhere is treated as absent, not followed.

**Unreadable is distinguished from empty.** A missing or unreadable artefact returns a typed failure rather than an empty list. Records are validated against a full schema of the documented record shape; a line that cannot be parsed, or parses but is not that shape (including an unrecognised log level, which used to be silently filtered out), is counted and reported per artefact as `malformedRecords`, only when non-zero. An empty logs answer next to a malformed count says the list may be incomplete rather than that nothing was logged.

**Episode membership names its scope.** `taujs_get_episode_logs` answered `ok: true, logs: []` for a `requestId` that never existed, telling an agent to retry a query that could never succeed. It now reports `membership` as `in_episode_ring`, `not_in_episode_ring`, or `unknown` when a malformed record makes the ring unprovable - a bounded ring can never prove an episode did not exist, only that it is not in the ring. The logs ring outlives the episode ring, so an evicted episode whose lines survive answers with those lines.

**A tool that throws answers in the envelope.** `{ ok: false, reason: 'tool_failure', message }`, with the full error on stderr and only a bounded message returned. Rejected promises are covered too.

**`taujs_doctor`'s unavailable branch no longer labels itself observed.**

**`EpisodeRecord` declares `deferredData`**, which the server has written since RFC 0007 R5.

BREAKING, and pre-1.0 so it is stated plainly rather than shimmed: `readEpisodes` and `readLogs` return a read result (`{ ok, records, malformed }` or a typed failure) instead of an array, and the response vocabulary above is new. The `limit` input of `taujs_get_recent_episodes` no longer caps at a hard-coded 200: the server already bounds what it returns.
