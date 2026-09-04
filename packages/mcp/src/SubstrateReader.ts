import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { DevJsonSchema, EpisodeRecordSchema, LogAnnexRecordSchema } from './schemas';

import type { ComparableGraph } from './GraphCompare';

import type { z } from 'zod';
import type { DevJson, LogAnnexRecord, LogLevel, ObservationsDocument, RequestGraphV2, EpisodeRecord } from './types';

// The adapter is a thin file reader (RFC v11): no network, no config loading, no framework
// imports. Reads are synchronous — files are small by construction (ring-capped) and the
// stdio server answers one tool call at a time.

// The request graph and the observations document are versioned independently: the graph
// carries breaking config-shape changes (schemaVersion 2, decisions.md), the observations
// document has had none yet and stays at 1.
export const GRAPH_SCHEMA_VERSION = 2;
export const OBSERVATIONS_SCHEMA_VERSION = 1;

// Refusal contract (phase-1-notes, verbatim): every runtime tool returns this when there
// is no active dev boot. Structural tools remain available.
export const NO_ACTIVE_BOOT_REFUSAL = {
  ok: false,
  reason: 'no_active_dev_boot',
  message: 'Structural tools remain available; runtime episodes require the dev server (pnpm dev).',
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

// A live pid is not a live boot: pids are recycled, and a crashed boot's dev.json survives because
// the server removes it only on graceful close. The boot therefore proves liveness by advancing
// dev.json's mtime on its poll tick (500 ms); this window is twenty ticks. It is a constant, not a
// negotiated value: the adapter has no runtime dependency on @taujs/server (RFC v11), and a server
// too old to heartbeat is exactly the case that should read stale.
const HEARTBEAT_STALE_MS = 10_000;

export type StaleReason = 'no_dev_json' | 'dead_pid' | 'heartbeat_expired' | 'dev_json_unreadable' | 'dev_json_invalid';

export const STALE_REASON_MESSAGE: Record<StaleReason, string> = {
  no_dev_json: 'No dev boot has recorded itself (node_modules/.taujs/dev.json is absent).',
  dead_pid: "The last dev boot's process is gone; its artefacts remain but describe a finished boot.",
  heartbeat_expired:
    'A dev.json exists with a live pid, but the boot has not touched it within the freshness window. It may have crashed and had its pid recycled, or @taujs/server may be older than @taujs/mcp and not heartbeat at all - upgrade @taujs/server to match.',
  dev_json_unreadable: 'A dev.json exists but could not be read or inspected for freshness - most likely a boot shutting down as this ran.',
  dev_json_invalid:
    'A dev.json exists but does not parse, or lacks fields a boot always writes. Restart the dev server, or upgrade @taujs/server to match @taujs/mcp.',
};

const realDirOf = (dir: string): string | undefined => {
  try {
    return realpathSync(dir);
  } catch {
    return undefined;
  }
};

// A path is handed out only as its real path, and only if that is a regular file beneath the real
// directory: a lexical check would still follow a symlink inside the directory to anywhere.
const containedFile = (candidate: string, realDir: string | undefined): string | undefined => {
  if (!realDir) return undefined;

  try {
    const real = realpathSync(candidate);

    return real.startsWith(realDir + path.sep) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
};

// The artefact names are derived, never taken from dev.json: that file is application data read
// back from disk, and the emitter writes its path fields from these same names, so deriving costs
// nothing and cannot be steered.
const containedPaths = (dir: string): SubstratePaths => {
  const realDir = realDirOf(dir);
  const at = (name: string) => containedFile(path.join(dir, name), realDir);

  return { graph: at('graph.json'), episodes: at('episodes.ndjson'), logs: at('logs.ndjson'), observations: at('observations.json') };
};

const notFoundMessage = (artefactName: string, location: string): string => `${artefactName} is not present as a regular file inside ${location}.`;

const livenessFailure = (devJson: DevJson, devJsonPath: string): StaleReason | undefined => {
  if (!isPidAlive(devJson.pid)) return 'dead_pid';

  try {
    return Date.now() - statSync(devJsonPath).mtimeMs > HEARTBEAT_STALE_MS ? 'heartbeat_expired' : undefined;
  } catch {
    // Reachable when a boot removes dev.json between the read and this stat.
    return 'dev_json_unreadable';
  }
};

type DevJsonRead = { ok: true; devJson: DevJson } | { ok: false; reason: 'dev_json_unreadable' | 'dev_json_invalid' };

// Validated, not cast: a partial dev.json with a live pid must not become `active` with fields
// silently undefined (an undefined bootId would skip the episode reader's boot filter).
const readDevJson = (filePath: string): DevJsonRead => {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'dev_json_unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'dev_json_invalid' };
  }

  const result = DevJsonSchema.safeParse(parsed);
  return result.success ? { ok: true, devJson: result.data } : { ok: false, reason: 'dev_json_invalid' };
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
  episodes?: string;
  logs?: string;
  observations?: string;
};

export type SubstrateDiscovery =
  | { mode: 'none'; message: string }
  | { mode: 'active'; devJson: DevJson; paths: SubstratePaths }
  | { mode: 'stale'; reason: StaleReason; devJson?: DevJson; paths: SubstratePaths };

// Freshness modes (phase-1-notes): 'active' = a valid dev.json with a live pid and a fresh
// heartbeat; 'stale' = artifacts exist but no live boot (answer structurally, cite emittedAt), with
// the reason carried; 'none' = nothing emitted yet. Monorepos: one adapter per project root — the
// MCP client launches at root.
export const discoverSubstrate = (root: string = process.cwd()): SubstrateDiscovery => {
  const devDir = path.join(root, 'node_modules', '.taujs');
  const devJsonPath = path.join(devDir, 'dev.json');
  const paths = containedPaths(devDir);

  let devJson: DevJson | undefined;
  let failure: StaleReason | undefined;

  if (!existsSync(devJsonPath)) {
    failure = 'no_dev_json';
  } else {
    const read = readDevJson(devJsonPath);
    // `devJson` travels on a stale result only when it validated.
    if (read.ok) {
      devJson = read.devJson;
      failure = livenessFailure(devJson, devJsonPath);
    } else {
      failure = read.reason;
    }
  }

  if (devJson && !failure) return { mode: 'active', devJson, paths };

  // No live boot: prefer boot artifacts, fall back to the build graph (structure-only).
  const reason = failure ?? 'no_dev_json';
  if (paths.graph) return { mode: 'stale', reason, devJson, paths };

  const buildDir = path.join(root, 'dist', '.taujs');
  const buildGraph = containedFile(path.join(buildDir, 'graph.json'), realDirOf(buildDir));
  if (buildGraph) return { mode: 'stale', reason, devJson, paths: { graph: buildGraph } };

  if (paths.episodes || paths.observations) return { mode: 'stale', reason, devJson, paths };

  // A dev.json that exists is a fact about a boot even when nothing else was emitted: its reason is
  // preserved rather than collapsed into 'none', which would claim no boot ever recorded itself.
  if (failure !== 'no_dev_json') return { mode: 'stale', reason, devJson, paths };

  return { mode: 'none', message: NOTHING_EMITTED_MESSAGE };
};

export type GraphReadResult =
  { ok: true; graph: RequestGraphV2; stalenessLine: string | null } | { ok: false; reason: 'not_found' | 'unreadable' | 'schema_skew'; message: string };

// Staleness is stated, never hidden (conventions rule 6): every non-active answer carries
// a citation line consumers must surface.
export const stalenessLineFor = (graph: Pick<RequestGraphV2, 'source' | 'emittedAt'>, mode: SubstrateDiscovery['mode']): string | null => {
  if (mode === 'active') return null;
  if (graph.source === 'build') {
    return `As of the last build at ${graph.emittedAt}, which is when the topology graph was emitted, not when every referenced application bundle was rebuilt — no active dev server; data may be stale.`;
  }
  return `As of the last dev boot at ${graph.emittedAt} — no active dev server; data may be stale.`;
};

// `cap` defaults to true: every tool that presents graph values reads them display-capped. The
// comparison tool alone reads uncapped (cap: false) - two strings sharing their first 500
// characters must still compare as different - and applies the cap itself at its response
// boundary instead.
export const readGraph = (discovery: SubstrateDiscovery, opts?: { cap?: boolean }): GraphReadResult => {
  if (discovery.mode === 'none') return { ok: false, reason: 'not_found', message: NOTHING_EMITTED_MESSAGE };

  const graphPath = discovery.paths.graph;
  if (!graphPath) return { ok: false, reason: 'not_found', message: notFoundMessage('graph.json', 'node_modules/.taujs or dist/.taujs') };

  const raw = readJson<RequestGraphV2>(graphPath);
  if (!raw) return { ok: false, reason: 'unreadable', message: `Could not parse ${graphPath}.` };

  // Version skew: degrade explicitly, never misread (phase-1-notes forget-risk).
  if (raw.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_skew',
      message: `Request graph is schema v${String(raw.schemaVersion)}; this adapter understands v${GRAPH_SCHEMA_VERSION} — upgrade @taujs/mcp.`,
    };
  }

  const graph = opts?.cap === false ? raw : capStrings(raw);
  return { ok: true, graph, stalenessLine: stalenessLineFor(graph, discovery.mode) };
};

// An NDJSON read reports three facts: the records it could read, how many it could not, and
// whether the artefact was readable at all. "Nothing happened" and "I could not tell" lead an agent
// to opposite conclusions, so none of them is flattened into an empty list.
export type NdjsonReadResult<T> = { ok: true; records: T[]; malformed: number } | { ok: false; reason: 'not_found' | 'unreadable'; message: string };

// Each line is validated against the full schema of the record (schemas.ts), so a line that parses
// but is not what the tools read - including an unrecognised log level - is counted, not served.
const readNdjson = <T>(filePath: string | undefined, schema: z.ZodType<T>, artefactName: string): NdjsonReadResult<T> => {
  if (!filePath) return { ok: false, reason: 'not_found', message: notFoundMessage(artefactName, 'node_modules/.taujs') };

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const records: T[] = [];
  let malformed = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      malformed += 1;
      continue;
    }

    records.push(capStrings(result.data));
  }

  return { ok: true, records, malformed };
};

// Newest-last; bootId-filtered so stale-boot records never masquerade as current
// (also covers crashed-server port reuse).
export const readEpisodes = (discovery: SubstrateDiscovery, options?: { bootId?: string; limit?: number }): NdjsonReadResult<EpisodeRecord> => {
  if (discovery.mode === 'none') return { ok: false, reason: 'not_found', message: NOTHING_EMITTED_MESSAGE };

  const read = readNdjson(discovery.paths.episodes, EpisodeRecordSchema, 'episodes.ndjson');
  if (!read.ok) return read;

  // Presence, not truthiness, decides whether the boot filter applies: an empty string is a
  // filter that matches nothing, never a filter that is skipped.
  let records = read.records;
  if (options?.bootId !== undefined) records = records.filter((r) => r.bootId === options.bootId);
  if (options?.limit && options.limit > 0) records = records.slice(-options.limit);

  // `malformed` describes the read, not the selection, so it survives the filters.
  return { ok: true, records, malformed: read.malformed };
};

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

// Per-episode, level-filtered, warn+ default - logs are fetched on demand, never embedded.
// bootId-filtered for the same reason readEpisodes is: the logs ring outlives a boot on disk.
export const readLogs = (
  discovery: SubstrateDiscovery,
  options: { requestId: string; minLevel?: LogLevel; bootId?: string },
): NdjsonReadResult<LogAnnexRecord> & { anyLevelCount?: number } => {
  if (discovery.mode === 'none') return { ok: false, reason: 'not_found', message: NOTHING_EMITTED_MESSAGE };

  const read = readNdjson(discovery.paths.logs, LogAnnexRecordSchema, 'logs.ndjson');
  if (!read.ok) return read;

  const min = LEVEL_ORDER[options.minLevel ?? 'warn'];
  let records = read.records;
  if (options.bootId !== undefined) records = records.filter((r) => r.bootId === options.bootId);

  const forEpisode = records.filter((r) => r.requestId === options.requestId);

  // The any-level count lets a caller tell "logged nothing" from "logged nothing at this level".
  return { ok: true, records: forEpisode.filter((r) => LEVEL_ORDER[r.level] >= min), malformed: read.malformed, anyLevelCount: forEpisode.length };
};

export type BaselineGraphReadResult =
  | { ok: true; graph: ComparableGraph }
  | { ok: false; reason: 'invalid_baseline_path' | 'baseline_not_found' | 'baseline_unreadable' | 'schema_skew'; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Proves every field the graph comparison COMPARES OR EMITS - identities and dereferenced paths
// (app/route ids, the middleware object facets are reached through, deferred keys sorted by),
// the facet values and global blocks that land in change rows, and the metadata the response
// reports (source, emittedAt, taujs.server). It is deliberately NOT the full v1 schema: interior
// facet shapes (a render's fields, a csp's contents) are compared and shown as-is by deep
// structural equality, and misdeclaring those is a difference for a row to state, not a reason
// to refuse. A document that passes produces complete metadata and well-formed rows; a partial
// one that would not - even one no dereference trips over - refuses as a baseline problem.
const hasComparableGraphShape = (raw: unknown): raw is ComparableGraph => {
  if (!isRecord(raw)) return false;
  if (typeof raw.source !== 'string' || typeof raw.emittedAt !== 'string') return false;
  if (!isRecord(raw.taujs) || typeof raw.taujs.server !== 'string') return false;
  if (!isRecord(raw.security) || !isRecord(raw.fallthrough)) return false;
  if (!Array.isArray(raw.apps) || !raw.apps.every((a) => isRecord(a) && typeof a.appId === 'string' && typeof a.entryPoint === 'string')) return false;
  if (!Array.isArray(raw.routes)) return false;

  return raw.routes.every(
    (r) =>
      isRecord(r) &&
      typeof r.id === 'string' &&
      isRecord(r.render) &&
      isRecord(r.hydrate) &&
      isRecord(r.middleware) &&
      isRecord(r.middleware.auth) &&
      isRecord(r.middleware.csp) &&
      isRecord(r.data) &&
      (r.head === undefined || isRecord(r.head)) &&
      (r.deferred === undefined || (Array.isArray(r.deferred) && r.deferred.every((e) => isRecord(e) && typeof e.key === 'string'))),
  );
};

// A retained baseline is a file the CALLER copied earlier, from anywhere under the project. It is
// never resolved through node_modules/.taujs (containedPaths is for artefacts this adapter itself
// derives), so it gets its own containment logic against the project root - reusing the exact
// realpath pattern containedFile applies to the substrate directory, plus a lexical pre-check so a
// syntactically invalid path (absolute, or `../` escaping the root before any file even exists) is
// distinguished from a path that resolves on disk to somewhere it should not.
export const readBaselineGraph = (root: string, baselinePath: string): BaselineGraphReadResult => {
  if (path.isAbsolute(baselinePath))
    return { ok: false, reason: 'invalid_baseline_path', message: `baselinePath must be project-relative, not absolute: "${baselinePath}".` };

  const realRoot = realDirOf(root);
  const lexical = path.normalize(path.join(root, baselinePath));
  if (!realRoot || (lexical !== root && !lexical.startsWith(root + path.sep)))
    return { ok: false, reason: 'invalid_baseline_path', message: `baselinePath escapes the project root by traversal: "${baselinePath}".` };

  // Beyond this point the path is lexically inside root; a symlink can still escape it, or the
  // target can be missing or not a regular file - containedFile answers all three the same honest
  // way the substrate directory's own artefacts are resolved.
  const real = containedFile(lexical, realRoot);
  if (!real)
    return {
      ok: false,
      reason: 'baseline_not_found',
      message: `"${baselinePath}" is not present as a regular file inside the project root (or resolves outside it via a symlink).`,
    };

  const raw = readJson<unknown>(real);
  if (raw === undefined) return { ok: false, reason: 'baseline_unreadable', message: `Could not parse baseline graph at "${baselinePath}".` };

  // Same version-skew discipline as readGraph: a baseline is untrusted application data too, and
  // an unrecognised schema must degrade explicitly rather than be misread as today's shape.
  const version = isRecord(raw) ? raw.schemaVersion : undefined;
  if (version !== GRAPH_SCHEMA_VERSION)
    return {
      ok: false,
      reason: 'schema_skew',
      message: `Baseline graph is schema v${String(version)}; this adapter understands v${GRAPH_SCHEMA_VERSION} — upgrade @taujs/mcp.`,
    };

  // A right-version document can still be malformed - a caller can retain (or hand-edit) anything.
  // That must refuse as a baseline problem, not surface later as a generic tool_failure when the
  // comparison dereferences a path that is not there.
  if (!hasComparableGraphShape(raw))
    return {
      ok: false,
      reason: 'baseline_unreadable',
      message: `Baseline graph at "${baselinePath}" parses as schema v${GRAPH_SCHEMA_VERSION} but does not have the request-graph shape this comparison reads.`,
    };

  // Returned UNCAPPED, deliberately: the one consumer (taujs_compare_graphs) must compare original
  // values - capping first would make long values equal at character 500 - and applies the display
  // cap itself at its response boundary.
  return { ok: true, graph: raw };
};

export type ObservationsReadResult =
  { ok: true; observations: ObservationsDocument } | { ok: false; reason: 'not_found' | 'unreadable' | 'schema_skew' | 'foreign_boot'; message: string };

export const readObservations = (discovery: SubstrateDiscovery): ObservationsReadResult => {
  if (discovery.mode === 'none')
    return { ok: false, reason: 'not_found', message: 'No observations emitted yet — not observed means "not exercised", never "no relationship".' };

  const obsPath = discovery.paths.observations;
  if (!obsPath) return { ok: false, reason: 'not_found', message: notFoundMessage('observations.json', 'node_modules/.taujs') };

  const raw = readJson<ObservationsDocument>(obsPath);
  if (!raw) return { ok: false, reason: 'unreadable', message: `Could not parse ${obsPath}.` };
  if (raw.schemaVersion !== OBSERVATIONS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_skew',
      message: `Observations are schema v${String(raw.schemaVersion)}; this adapter understands v${OBSERVATIONS_SCHEMA_VERSION} — upgrade @taujs/mcp.`,
    };
  }

  // Same principle as readEpisodes' bootId filter: stale-boot records never masquerade as
  // current. The emitter only rewrites observations.json on the first current-boot service
  // call, so early in a boot the file on disk can still be the PREVIOUS boot's — serving it
  // would claim old edges were "seen this boot".
  if (discovery.mode === 'active' && raw.bootId !== discovery.devJson.bootId) {
    return {
      ok: false,
      reason: 'foreign_boot',
      message: 'Observations on disk are from a previous boot; none recorded this boot yet — not observed means "not exercised", never "no relationship".',
    };
  }

  return { ok: true, observations: capStrings(raw) };
};
