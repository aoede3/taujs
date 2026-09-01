import { z } from 'zod';

import { NO_ACTIVE_BOOT_REFUSAL, STALE_REASON_MESSAGE, discoverSubstrate, readGraph, readLogs, readEpisodes } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded, defineTool } from '../toolkit';
import { renderStrategyCitation } from './contracts';

import type { SubstrateDiscovery } from '../SubstrateReader';
import type { ToolDefinition, ToolResult } from '../toolkit';
import type { EpisodeRecord } from '../types';

// No ring cap is declared here. It used to be duplicated from the server (DevIntrospection.ts)
// with nothing keeping the two equal - and it drove an input-schema `max()` and a user-facing
// message, so a server-side change would have silently refused valid requests and stated a wrong
// number. The server already bounds what it returns, so accepting a larger requested limit costs
// nothing, and the ring's size is now described rather than asserted.
const RECENT_DEFAULT_LIMIT = 5;
const DOCTOR_FAILED_LIMIT = 5;

// Runtime tools answer from live traffic only: without an active dev boot they return the
// refusal contract verbatim (structural tools keep working — the refusal says so).
const withActiveBoot = (root: string, fn: (discovery: Extract<SubstrateDiscovery, { mode: 'active' }>) => ToolResult): ToolResult => {
  const discovery = discoverSubstrate(root);
  // The refusal now says WHY there is no active boot. "No live boot" and "the boot stopped
  // answering" call for different actions from whoever reads this, and a single message for both
  // is the same conflation these tools exist to avoid.
  if (discovery.mode !== 'active')
    return {
      ...NO_ACTIVE_BOOT_REFUSAL,
      ...(discovery.mode === 'stale' ? { staleReason: discovery.reason, detail: STALE_REASON_MESSAGE[discovery.reason] } : {}),
    };

  return fn(discovery);
};

// Episode rows lead with identifiers and outcomes; logs are NEVER embedded - the intended
// flow is get_recent_episodes → get_episode → only then get_episode_logs.
const episodeSummary = (t: EpisodeRecord) => ({
  requestId: t.requestId,
  at: t.at,
  mode: t.mode,
  outcome: t.outcome,
  status: t.status,
  route: t.route,
  appId: t.appId,
  pathname: t.url.pathname,
  serviceCalls: t.serviceCalls.map((c) => `${c.service}.${c.method} ${c.ok ? 'ok' : 'FAILED'} ${c.ms}ms`),
  ...(t.error ? { error: t.error } : {}),
});

// Shared by every runtime tool: a read that failed is reported as a read that failed, with the
// artefact named. It is never flattened into an empty result, because "nothing was recorded" and
// "I could not read what was recorded" lead an agent to opposite conclusions.
const substrateUnreadable = (read: { reason: 'not_found' | 'unreadable'; message: string }, bootId: string): ToolResult => ({
  ok: false,
  reason: read.reason === 'not_found' ? 'substrate_missing' : 'substrate_unreadable',
  membership: 'unknown',
  bootId,
  message: read.message,
});

// Emitted only when non-zero, and per artefact: a count that appears only in the doctor is a count
// the agent will not see at the moment it matters.
const malformedNote = (counts: { episodes?: number; logs?: number }): { malformedRecords?: Record<string, number> } => {
  const entries = Object.entries(counts).filter(([, n]) => typeof n === 'number' && n > 0);

  return entries.length ? { malformedRecords: Object.fromEntries(entries) } : {};
};

// The certain sentence ("at any level") is earned only when nothing is unaccounted for.
const emptyLogsNote = (minLevel: string, membership: string, anyLevelCount: number, logsMalformed: number): string => {
  if (logsMalformed > 0 || membership === 'unknown') return 'Some records could not be read, so this list may be incomplete.';
  if (anyLevelCount > 0) return `No ${minLevel}+ annex lines, but this episode did log at a lower level - try minLevel: "info".`;

  return 'No annex lines for this episode at any level. The annex captures only the framework request logger, so a separate user logger would not appear here.';
};

export const runtimeTools = (root: string): ToolDefinition[] => [
  defineTool({
    name: 'taujs_get_recent_episodes',
    title: 'Recent request episodes',
    description: `Most recent request episodes from the active dev boot (default ${RECENT_DEFAULT_LIMIT}). Filter by outcome or mode. Follow up with taujs_get_episode, then taujs_get_episode_logs - logs are never embedded here. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      limit: z.number().int().positive().optional().describe(`Max episodes (default ${RECENT_DEFAULT_LIMIT})`),
      outcome: z.enum(['complete', 'failed', 'aborted']).optional().describe('Filter by terminal outcome'),
      mode: z.enum(['ssr', 'streaming', 'fallthrough']).optional().describe('Filter by render mode'),
    }),
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const limit = args.limit ?? RECENT_DEFAULT_LIMIT;
        const read = readEpisodes(discovery, { bootId: discovery.devJson.bootId });
        if (!read.ok) return substrateUnreadable(read, discovery.devJson.bootId);

        let records = read.records;
        if (typeof args.outcome === 'string') records = records.filter((t) => t.outcome === args.outcome);
        if (typeof args.mode === 'string') records = records.filter((t) => t.mode === args.mode);

        const recent = records.slice(-limit).reverse(); // newest first for reading
        return {
          ok: true,
          bootId: discovery.devJson.bootId,
          episodes: { items: recent.map(episodeSummary), total: records.length, truncated: records.length > limit },
          ...malformedNote({ episodes: read.malformed }),
        };
      }),
  }),
  defineTool({
    name: 'taujs_get_episode',
    title: 'Get one request episode',
    description: `The full episode record for one requestId - timeline, service calls, client hydration, error. Logs are fetched separately via taujs_get_episode_logs. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      requestId: z.string().describe('From taujs_get_recent_episodes or an x-request-id response header'),
    }),
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const requestId = args.requestId;
        const read = readEpisodes(discovery, { bootId: discovery.devJson.bootId });
        if (!read.ok) return substrateUnreadable(read, discovery.devJson.bootId);

        const episode = read.records.find((t) => t.requestId === requestId);

        if (!episode) {
          // Absence NAMES ITS SCOPE. A bounded ring cannot prove an episode never existed, only
          // that it is not in the ring - and if any record was unreadable it cannot prove even
          // that, so the answer becomes unknown rather than not-found.
          return read.malformed > 0
            ? {
                ok: false,
                reason: 'substrate_incomplete',
                membership: 'unknown',
                message: `Cannot say whether episode "${requestId}" is in this boot's episode ring: ${read.malformed} record(s) could not be read.`,
                bootId: discovery.devJson.bootId,
                ...malformedNote({ episodes: read.malformed }),
              }
            : {
                ok: false,
                reason: 'episode_not_found',
                membership: 'not_in_episode_ring',
                message: `No episode "${requestId}" in this boot's retained episode ring; older episodes may have been evicted.`,
                bootId: discovery.devJson.bootId,
              };
        }

        return { ok: true, bootId: discovery.devJson.bootId, membership: 'in_episode_ring', episode };
      }),
  }),
  defineTool({
    name: 'taujs_get_episode_logs',
    title: 'Logs for one episode',
    description: `Logs-annex lines for one requestId, level-filtered (default warn+). Only lines through the framework request logger are captured - a separate user logger is not; absence here does not mean nothing was logged. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      requestId: z.string().describe('The episode to fetch logs for'),
      minLevel: z.enum(['info', 'warn', 'error']).optional().describe('Minimum level (default warn)'),
    }),
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const requestId = args.requestId;
        const minLevel = args.minLevel ?? 'warn';
        const bootId = discovery.devJson.bootId;

        const logsRead = readLogs(discovery, { requestId, minLevel, bootId });
        if (!logsRead.ok) return substrateUnreadable(logsRead, bootId);

        // Membership is asked of the EPISODE ring, which is smaller than the logs ring - so an
        // episode can be evicted while its lines survive. Answering `ok: true, logs: []` for a
        // requestId that never existed told an agent to retry a query that can never succeed.
        const episodesRead = readEpisodes(discovery, { bootId });
        const membership = !episodesRead.ok
          ? 'unknown'
          : episodesRead.records.some((t) => t.requestId === requestId)
            ? 'in_episode_ring'
            : episodesRead.malformed > 0
              ? 'unknown'
              : 'not_in_episode_ring';

        const malformed = malformedNote({ episodes: episodesRead.ok ? episodesRead.malformed : 0, logs: logsRead.malformed });

        // Nothing to hand back AND nothing established: the same state taujs_get_episode reports as
        // ok:false, so it answers ok:false here too. An agent that gates on `ok` before reading
        // `membership` would otherwise see two opposite verdicts for one fact - and the whole point
        // of `membership` is that "I cannot tell" is not a quieter kind of "no".
        // Absence is claimed only when BOTH rings are provable: a malformed annex line could be
        // this episode's only surviving evidence.
        if (logsRead.anyLevelCount === 0 && membership !== 'in_episode_ring') {
          return membership === 'unknown' || logsRead.malformed > 0
            ? {
                ok: false,
                reason: 'substrate_incomplete',
                membership,
                bootId,
                requestId,
                message: `Cannot say whether episode "${requestId}" has evidence in this boot: some records could not be read.`,
                ...malformed,
              }
            : {
                ok: false,
                reason: 'episode_not_found',
                membership,
                bootId,
                requestId,
                message: `No episode "${requestId}" in this boot's retained episode ring, and no annex lines for it at any level.`,
              };
        }

        return {
          ok: true,
          bootId,
          requestId,
          minLevel,
          membership,
          logs: logsRead.records,
          ...malformed,
          ...(logsRead.records.length === 0 ? { note: emptyLogsNote(minLevel, membership, logsRead.anyLevelCount ?? 0, logsRead.malformed) } : {}),
        };
      }),
  }),
  defineTool({
    name: 'taujs_doctor',
    title: 'τjs diagnostics',
    description: `Bounded health report: graph warnings grouped by severity, fallthrough reachability, defaulted renders, and recent failed episodes with error kinds. Each fact is source-labelled; staleness cited when not live. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({}),
    handler: () => {
      const discovery = discoverSubstrate(root);
      if (discovery.mode === 'none')
        return { ok: false, reason: 'nothing_emitted', message: 'Nothing to diagnose — run `pnpm dev` once to emit the request graph.' };

      const graphResult = readGraph(discovery);
      if (!graphResult.ok) return { ok: false, reason: graphResult.reason, message: graphResult.message };
      const { graph, stalenessLine } = graphResult;

      const warnings = {
        source: 'declared (graph warnings)',
        // A clean verdict must say what it covers: a warning-free GRAPH is not application
        // health — routes and code outside the taujs graph are never examined here.
        ...(graph.warnings.length === 0 ? { note: 'No taujs graph warnings. This covers the declared taujs graph only, not application health.' } : {}),
        ...['error', 'warn', 'info'].reduce<Record<string, unknown>>((acc, sev) => {
          const of = graph.warnings.filter((w) => w.severity === sev);
          if (of.length) acc[sev] = of;
          return acc;
        }, {}),
      };

      const defaultedRenders = graph.routes.filter((r) => r.render.defaulted).map((r) => r.id);

      // The doctor has its OWN episode projection - it reports failed service calls where
      // get_recent_episodes reports a summary line - so it is a near-duplicate of episodeSummary,
      // not a call to it. Worth stating: fixing the summary alone would have left this one reading
      // unvalidated records. It no longer needs to defend itself, because the reader now refuses to
      // hand back a record that is not the shape these fields assume.
      const failedEpisodes = ((): Record<string, unknown> => {
        if (discovery.mode !== 'active')
          return {
            source: 'runtime (unavailable without an active boot)',
            unavailable: { note: NO_ACTIVE_BOOT_REFUSAL.message, staleReason: discovery.reason, detail: STALE_REASON_MESSAGE[discovery.reason] },
          };

        const read = readEpisodes(discovery, { bootId: discovery.devJson.bootId });
        if (!read.ok)
          return {
            source: 'runtime (unreadable)',
            unavailable: { note: read.message, reason: read.reason === 'not_found' ? 'substrate_missing' : 'substrate_unreadable' },
          };

        const failed = read.records
          .filter((t) => t.outcome === 'failed')
          .reverse()
          .map((t) => ({
            requestId: t.requestId,
            route: t.route,
            pathname: t.url.pathname,
            error: t.error,
            serviceCalls: t.serviceCalls.filter((c) => !c.ok),
          }));

        return { source: 'observed (seen in dev traffic)', ...bounded(failed, DOCTOR_FAILED_LIMIT), ...malformedNote({ episodes: read.malformed }) };
      })();

      return {
        ok: true,
        mode: discovery.mode,
        ...(discovery.mode === 'stale' ? { staleReason: discovery.reason } : {}),
        ...(stalenessLine ? { staleness: stalenessLine } : {}),
        warnings,
        fallthrough: {
          ...graph.fallthrough,
          note: graph.fallthrough.reachable ? undefined : 'A wildcard route makes fallthrough unreachable.',
        },
        defaultedRenders: {
          source: 'declared',
          routeIds: defaultedRenders,
          // Contract-backed enrichment only (RFC 0015 Phase B): absent on older or mismatched
          // installations, while the routeIds fact keeps flowing.
          ...((): Record<string, unknown> => {
            // Optional-chained: enrichment must never fail a doctor that previously answered,
            // even against a substrate whose graph lacks the emitter block.
            const citation = renderStrategyCitation(root, graph.taujs?.server);
            return citation ? { contract: citation } : {};
          })(),
        },
        // Two explicit branches, built where the fact is known. It used to be assembled by probing
        // the value's shape (`'items' in ...`) under a hard-coded `source: 'observed'`, which
        // produced an object announcing itself as OBSERVED while carrying `unavailable` inside it.
        failedEpisodes,
      };
    },
  }),
];
