---
'@taujs/server': minor
'@taujs/mcp': minor
'@taujs/create-taujs': minor
---

The recorder subsystem stops using "trace": the settled concept word is "episode" (SC-09 ruling 9).

This is a behaviour-preserving surface migration - the recorder's behaviour is unchanged, but
observable interfaces change, with no compatibility aliases:

- MCP tools: `taujs_get_recent_traces` becomes `taujs_get_recent_episodes`, `taujs_get_trace`
  becomes `taujs_get_episode`, `taujs_get_trace_logs` becomes `taujs_get_episode_logs`; the
  recent-episodes response key `traces` becomes `episodes`, and the not-found reason
  `trace_not_found` becomes `episode_not_found`
- development endpoint `/__taujs/traces` becomes `/__taujs/episodes`, and its response key
  `traces` becomes `episodes`
- development artefact `traces.ndjson` becomes `episodes.ndjson`; `dev.json` exposes
  `paths.episodes` and no longer exposes `paths.traces`. A stale legacy `traces.ndjson` from an
  earlier boot is removed explicitly at the next boot so it can never be mistaken for current-boot
  evidence, and current MCP never reads the old file
- TypeScript types: `TraceRecorder` becomes `EpisodeRecorder`, `noopTraceRecorder` becomes
  `noopEpisodeRecorder`, `TraceRecord` becomes `EpisodeRecord`, `TraceTimeline` becomes
  `EpisodeTimeline`; `getTraces()` becomes `getEpisodes()`, `findTrace()` becomes `findEpisode()`
  and `tracesRevision` becomes `episodesRevision`
- an episode carries no `episodeId`: its key is the canonical `requestId`

The word "trace" is reserved in the τjs observability model for genuine distributed tracing
(`traceparent`, OpenTelemetry trace and span IDs), which remains a separate future capability.
