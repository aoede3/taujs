import { z } from 'zod';

import { NO_ACTIVE_BOOT_REFUSAL, discoverSubstrate, readGraph, readLogs, readTraces } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded } from '../toolkit';

import type { SubstrateDiscovery } from '../SubstrateReader';
import type { ToolDefinition, ToolResult } from '../toolkit';
import type { TraceRecord } from '../types';

const TRACE_RING_CAP = 200; // spec 03 §2
const RECENT_DEFAULT_LIMIT = 5;
const DOCTOR_FAILED_LIMIT = 5;

// Runtime tools answer from live traffic only: without an active dev boot they return the
// refusal contract verbatim (structural tools keep working — the refusal says so).
const withActiveBoot = (root: string, fn: (discovery: Extract<SubstrateDiscovery, { mode: 'active' }>) => ToolResult): ToolResult => {
  const discovery = discoverSubstrate(root);
  if (discovery.mode !== 'active') return { ...NO_ACTIVE_BOOT_REFUSAL };

  return fn(discovery);
};

// Trace rows lead with identifiers and outcomes; logs are NEVER embedded — the intended
// flow is get_recent_traces → get_trace → only then get_trace_logs.
const traceSummary = (t: TraceRecord) => ({
  traceId: t.traceId,
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

export const runtimeTools = (root: string): ToolDefinition[] => [
  {
    name: 'taujs_get_recent_traces',
    title: 'Recent request traces',
    description: `Most recent request traces from the active dev boot (default ${RECENT_DEFAULT_LIMIT}). Filter by outcome or mode. Follow up with taujs_get_trace, then taujs_get_trace_logs — logs are never embedded here. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      limit: z.number().int().positive().max(TRACE_RING_CAP).optional().describe(`Max traces (default ${RECENT_DEFAULT_LIMIT})`),
      outcome: z.enum(['complete', 'failed', 'aborted']).optional().describe('Filter by terminal outcome'),
      mode: z.enum(['ssr', 'streaming', 'fallthrough']).optional().describe('Filter by render mode'),
    },
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const limit = typeof args.limit === 'number' ? args.limit : RECENT_DEFAULT_LIMIT;
        let records = readTraces(discovery, { bootId: discovery.devJson.bootId });
        if (typeof args.outcome === 'string') records = records.filter((t) => t.outcome === args.outcome);
        if (typeof args.mode === 'string') records = records.filter((t) => t.mode === args.mode);

        const recent = records.slice(-limit).reverse(); // newest first for reading
        return {
          ok: true,
          bootId: discovery.devJson.bootId,
          traces: { items: recent.map(traceSummary), total: records.length, truncated: records.length > limit },
        };
      }),
  },
  {
    name: 'taujs_get_trace',
    title: 'Get one request trace',
    description: `The full trace record for one traceId — timeline, service calls, client hydration, error. Logs are fetched separately via taujs_get_trace_logs. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      traceId: z.string().describe('From taujs_get_recent_traces or an x-trace-id response header'),
    },
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const traceId = String(args.traceId ?? '');
        const trace = readTraces(discovery, { bootId: discovery.devJson.bootId }).find((t) => t.traceId === traceId);

        if (!trace) {
          return {
            ok: false,
            reason: 'trace_not_found',
            message: `No trace "${traceId}" in this boot's ring buffer (last ${TRACE_RING_CAP} requests; older traces are evicted).`,
            bootId: discovery.devJson.bootId,
          };
        }

        return { ok: true, bootId: discovery.devJson.bootId, trace };
      }),
  },
  {
    name: 'taujs_get_trace_logs',
    title: 'Logs for one trace',
    description: `Logs-annex lines for one traceId, level-filtered (default warn+). Only lines through the framework request logger are captured — a separate user logger is not; absence here does not mean nothing was logged. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      traceId: z.string().describe('The trace to fetch logs for'),
      minLevel: z.enum(['info', 'warn', 'error']).optional().describe('Minimum level (default warn)'),
    },
    handler: (args) =>
      withActiveBoot(root, (discovery) => {
        const traceId = String(args.traceId ?? '');
        const minLevel = (typeof args.minLevel === 'string' ? args.minLevel : 'warn') as 'info' | 'warn' | 'error';
        const logs = readLogs(discovery, { traceId, minLevel });

        return {
          ok: true,
          bootId: discovery.devJson.bootId,
          traceId,
          minLevel,
          logs,
          ...(logs.length === 0
            ? { note: `No ${minLevel}+ annex lines for this trace. Try minLevel: "info"; the annex captures only the framework request logger.` }
            : {}),
        };
      }),
  },
  {
    name: 'taujs_doctor',
    title: 'τjs diagnostics',
    description: `Bounded health report: graph warnings grouped by severity, fallthrough reachability, defaulted renders, and recent failed traces with error kinds. Each fact is source-labelled; staleness cited when not live. ${UNTRUSTED_NOTE}`,
    inputSchema: {},
    handler: () => {
      const discovery = discoverSubstrate(root);
      if (discovery.mode === 'none')
        return { ok: false, reason: 'nothing_emitted', message: 'Nothing to diagnose — run `pnpm dev` once to emit the request graph.' };

      const graphResult = readGraph(discovery);
      if (!graphResult.ok) return { ok: false, reason: graphResult.reason, message: graphResult.message };
      const { graph, stalenessLine } = graphResult;

      const warnings = {
        source: 'declared (graph warnings)',
        ...['error', 'warn', 'info'].reduce<Record<string, unknown>>((acc, sev) => {
          const of = graph.warnings.filter((w) => w.severity === sev);
          if (of.length) acc[sev] = of;
          return acc;
        }, {}),
      };

      const defaultedRenders = graph.routes.filter((r) => r.render.defaulted).map((r) => r.id);

      const failedTraces =
        discovery.mode === 'active'
          ? bounded(
              readTraces(discovery, { bootId: discovery.devJson.bootId })
                .filter((t) => t.outcome === 'failed')
                .reverse()
                .map((t) => ({
                  traceId: t.traceId,
                  route: t.route,
                  pathname: t.url.pathname,
                  error: t.error,
                  serviceCalls: t.serviceCalls.filter((c) => !c.ok),
                })),
              DOCTOR_FAILED_LIMIT,
            )
          : { note: NO_ACTIVE_BOOT_REFUSAL.message, source: 'runtime (unavailable without an active boot)' };

      return {
        ok: true,
        mode: discovery.mode,
        ...(stalenessLine ? { staleness: stalenessLine } : {}),
        warnings,
        fallthrough: {
          ...graph.fallthrough,
          note: graph.fallthrough.reachable ? undefined : 'A wildcard route makes fallthrough unreachable (app-shell pattern).',
        },
        defaultedRenders: { source: 'declared', routeIds: defaultedRenders },
        failedTraces: {
          source: 'observed (seen in dev traffic)',
          ...(('items' in (failedTraces as object) ? failedTraces : { unavailable: failedTraces }) as object),
        },
      };
    },
  },
];
