import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DevJson, LogAnnexRecord, LogLevel, ObservationsDocument, RequestGraphV1, TraceRecord } from './types';

// The adapter is a thin file reader (RFC v11): no network, no config loading, no framework
// imports. Reads are synchronous — files are small by construction (ring-capped) and the
// stdio server answers one tool call at a time.

export const ADAPTER_SCHEMA_VERSION = 1;

// Refusal contract (phase-1-notes, verbatim): every runtime tool returns this when there
// is no active dev boot. Structural tools remain available.
export const NO_ACTIVE_BOOT_REFUSAL = {
  ok: false,
  reason: 'no_active_dev_boot',
  message: 'Structural tools remain available; runtime traces require the dev server (pnpm dev).',
} as const;

export const NOTHING_EMITTED_MESSAGE = 'No τjs introspection artifacts found — run `pnpm dev` once to emit the request graph.';

const STRING_CAP = 500;

// Everything read from disk is untrusted application data: cap every string on the way in
// and never treat field values as instructions (RFC security model §4).
export const capStrings = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value === 'string') return (value.length > STRING_CAP ? value.slice(0, STRING_CAP) : value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => capStrings(v, seen)) as T;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capStrings(v, seen);

  return out as T;
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned elsewhere — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readJson = <T>(filePath: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

export type SubstratePaths = {
  graph?: string;
  traces?: string;
  logs?: string;
  observations?: string;
};

export type SubstrateDiscovery =
  { mode: 'none'; message: string } | { mode: 'active'; devJson: DevJson; paths: SubstratePaths } | { mode: 'stale'; devJson?: DevJson; paths: SubstratePaths };

// Freshness modes (phase-1-notes): 'active' = dev.json present with a live pid; 'stale' =
// artifacts exist but no live boot (answer structurally, cite emittedAt); 'none' = nothing
// emitted yet. Monorepos: one adapter per project root — the MCP client launches at root.
export const discoverSubstrate = (root: string = process.cwd()): SubstrateDiscovery => {
  const devDir = path.join(root, 'node_modules', '.taujs');
  const devJsonPath = path.join(devDir, 'dev.json');

  const conventional = (dir: string): SubstratePaths => ({
    graph: path.join(dir, 'graph.json'),
    traces: path.join(dir, 'traces.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
  });

  const devJson = existsSync(devJsonPath) ? readJson<DevJson>(devJsonPath) : undefined;

  if (devJson && typeof devJson.pid === 'number' && isPidAlive(devJson.pid)) {
    return {
      mode: 'active',
      devJson,
      paths: {
        graph: devJson.graph ?? conventional(devDir).graph,
        traces: devJson.traces ?? conventional(devDir).traces,
        logs: devJson.logs ?? conventional(devDir).logs,
        observations: devJson.observations ?? conventional(devDir).observations,
      },
    };
  }

  // No live boot: prefer boot artifacts, fall back to the build graph (structure-only).
  const bootPaths = conventional(devDir);
  if (existsSync(bootPaths.graph!)) return { mode: 'stale', devJson, paths: bootPaths };

  const buildGraph = path.join(root, 'dist', '.taujs', 'graph.json');
  if (existsSync(buildGraph)) return { mode: 'stale', devJson, paths: { graph: buildGraph } };

  if (existsSync(bootPaths.traces!) || existsSync(bootPaths.observations!)) return { mode: 'stale', devJson, paths: bootPaths };

  return { mode: 'none', message: NOTHING_EMITTED_MESSAGE };
};

export type GraphReadResult =
  { ok: true; graph: RequestGraphV1; stalenessLine: string | null } | { ok: false; reason: 'not_found' | 'unreadable' | 'schema_skew'; message: string };

// Staleness is stated, never hidden (conventions rule 6): every non-active answer carries
// a citation line consumers must surface.
export const stalenessLineFor = (graph: Pick<RequestGraphV1, 'source' | 'emittedAt'>, mode: SubstrateDiscovery['mode']): string | null => {
  if (mode === 'active') return null;
  const what = graph.source === 'build' ? 'build' : 'dev boot';
  return `As of the last ${what} at ${graph.emittedAt} — no active dev server; data may be stale.`;
};

export const readGraph = (discovery: SubstrateDiscovery): GraphReadResult => {
  if (discovery.mode === 'none') return { ok: false, reason: 'not_found', message: NOTHING_EMITTED_MESSAGE };

  const graphPath = discovery.paths.graph;
  if (!graphPath || !existsSync(graphPath)) return { ok: false, reason: 'not_found', message: NOTHING_EMITTED_MESSAGE };

  const raw = readJson<RequestGraphV1>(graphPath);
  if (!raw) return { ok: false, reason: 'unreadable', message: `Could not parse ${graphPath}.` };

  // Version skew: degrade explicitly, never misread (phase-1-notes forget-risk).
  if (raw.schemaVersion !== ADAPTER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_skew',
      message: `Request graph is schema v${String(raw.schemaVersion)}; this adapter understands v${ADAPTER_SCHEMA_VERSION} — upgrade @taujs/mcp.`,
    };
  }

  const graph = capStrings(raw);
  return { ok: true, graph, stalenessLine: stalenessLineFor(graph, discovery.mode) };
};

const readNdjson = <T>(filePath: string | undefined): T[] => {
  if (!filePath || !existsSync(filePath)) return [];

  const records: T[] = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(capStrings(JSON.parse(line) as T));
    } catch {
      // a torn/corrupt line degrades that record, never the read
    }
  }

  return records;
};

// Newest-last; bootId-filtered so stale-boot records never masquerade as current
// (also covers crashed-server port reuse).
export const readTraces = (discovery: SubstrateDiscovery, options?: { bootId?: string; limit?: number }): TraceRecord[] => {
  if (discovery.mode === 'none') return [];

  let records = readNdjson<TraceRecord>(discovery.paths.traces);
  if (options?.bootId) records = records.filter((r) => r.bootId === options.bootId);
  if (options?.limit && options.limit > 0) records = records.slice(-options.limit);

  return records;
};

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

// Per-trace, level-filtered, warn+ default — logs are fetched on demand, never embedded.
export const readLogs = (discovery: SubstrateDiscovery, options: { traceId: string; minLevel?: LogLevel }): LogAnnexRecord[] => {
  if (discovery.mode === 'none') return [];

  const min = LEVEL_ORDER[options.minLevel ?? 'warn'];
  return readNdjson<LogAnnexRecord>(discovery.paths.logs).filter((r) => r.traceId === options.traceId && LEVEL_ORDER[r.level] >= min);
};

export type ObservationsReadResult =
  { ok: true; observations: ObservationsDocument } | { ok: false; reason: 'not_found' | 'unreadable' | 'schema_skew'; message: string };

export const readObservations = (discovery: SubstrateDiscovery): ObservationsReadResult => {
  const obsPath = discovery.mode === 'none' ? undefined : discovery.paths.observations;
  if (!obsPath || !existsSync(obsPath))
    return { ok: false, reason: 'not_found', message: 'No observations emitted yet — not observed means "not exercised", never "no relationship".' };

  const raw = readJson<ObservationsDocument>(obsPath);
  if (!raw) return { ok: false, reason: 'unreadable', message: `Could not parse ${obsPath}.` };
  if (raw.schemaVersion !== ADAPTER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_skew',
      message: `Observations are schema v${String(raw.schemaVersion)}; this adapter understands v${ADAPTER_SCHEMA_VERSION} — upgrade @taujs/mcp.`,
    };
  }

  return { ok: true, observations: capStrings(raw) };
};
