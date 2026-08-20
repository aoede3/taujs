import crypto from 'node:crypto';

import { now } from '../telemetry/Telemetry';
import { createSafeRecorder } from './EpisodeRecorder';

import type { Logs } from '../logging/types';
import type { EpisodeRecorder } from './EpisodeRecorder';

// Redaction denylist (conventions rule 13). Matching is case-insensitive substring on the
// key; a matched key's entire subtree is dropped, never partially serialised.
export const DEFAULT_DENY_KEYS = ['password', 'token', 'secret', 'ssn', 'auth', 'cookie', 'session', 'key'] as const;

// Caps (spec 03 §2)
const MESSAGE_CAP = 500;
const META_VALUE_CAP = 200;
const META_DEPTH_CAP = 4;
const EPISODE_RING_CAP = 200;
const LOGS_RING_CAP = 2000;
const SAMPLE_REQUEST_ID_CAP = 5;
const PENDING_CAP = 500; // safety valve for episodes that never reach a terminal event

export type EpisodeTimeline = { matched?: number; dataStart?: number; dataEnd?: number; head?: number; shellReady?: number; allReady?: number };

export type EpisodeRecord = {
  requestId: string;
  bootId: string;
  at: string;
  route: string | null;
  appId: string | null;
  mode: 'ssr' | 'streaming' | 'fallthrough' | null;
  outcome: 'complete' | 'failed' | 'aborted';
  status: number | null;
  url: { pathname: string; queryKeys: string[]; queryValuesRedacted: true };
  timeline: EpisodeTimeline;
  serviceCalls: { service: string; method: string; ms: number; ok: boolean }[];
  /**
   * RFC 0007 (R5): per-key deferred outcomes, in arrival order. ADDITIVE-OPTIONAL and ABSENT for
   * any episode with no deferred events, so existing episode bytes and older readers are unaffected.
   * Bounded by construction - one entry per DECLARED key per request, and declared keys are static
   * configuration - so it carries no cap of its own, exactly like `serviceCalls`.
   */
  deferredData?: { key: string; outcome: 'complete' | 'failed' | 'aborted'; ms: number }[];
  client: { hydrated: boolean; hydrationMs: number | null; error: string | null } | null;
  error: { kind: string; message: string } | null;
};

export type LogAnnexRecord = {
  requestId: string;
  bootId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta: unknown;
};

export type ObservedEdge = {
  service: string;
  method: string;
  /**
   * `count` per route is the calls attributed to THAT route (spec 03 §4 additive field,
   * decisions.md 2026-08-20). Route counts need not sum to the edge's method-wide `count`:
   * a call recorded before route match increments the method total only.
   */
  routes: { routeId: string; appId: string; path: string; count: number }[];
  count: number;
  lastObservedAt: string;
  sampleRequestIds: string[];
};

export type ObservationsDocument = {
  schemaVersion: 1;
  bootId: string;
  updatedAt: string;
  edges: ObservedEdge[];
  // Shapes require the service result at recording time, which the serviceCall event
  // deliberately does not carry — deferred (honest gap), never guessed.
  shapes: never[];
};

export type DevIntrospection = {
  bootId: string;
  /** Per-boot random secret: required by every overlay endpoint and the beacon (spec 03 §5-6). */
  token: string;
  recorder: EpisodeRecorder;
  wrapRequestLogger: <L extends Logs>(logger: L, requestId: string) => L;
  getEpisodes: (limit?: number) => EpisodeRecord[];
  getLogs: (requestId?: string) => LogAnnexRecord[];
  getObservations: () => ObservationsDocument;
  /** Finalised-or-pending episode lookup - used by the beacon endpoint's duplicate check. */
  findEpisode: (requestId: string) => EpisodeRecord | undefined;
  /**
   * Cumulative counters for change detection by the file emitter. `episodesRevision` also advances
   * when an ALREADY-FINALISED episode is amended in place (RFC 0007 R5: a deferred outcome arriving
   * after the terminal), which `episodes` alone cannot express - without it a late outcome would be
   * visible in memory and absent from the on-disk NDJSON, and therefore from MCP.
   */
  stats: () => { episodes: number; episodesRevision: number; logs: number; observationsUpdatedAt: string | null };
};

type PendingEpisode = EpisodeRecord & { t0: number; done: boolean };

const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

export const createDevIntrospection = (options?: { logger?: Logs; denyKeys?: string[]; replaceDefaultDenyKeys?: boolean }): DevIntrospection => {
  const bootId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('base64url');
  const denyKeys = (options?.replaceDefaultDenyKeys ? (options.denyKeys ?? []) : [...DEFAULT_DENY_KEYS, ...(options?.denyKeys ?? [])]).map((k) =>
    k.toLowerCase(),
  );

  const isDenied = (key: string): boolean => {
    const lower = key.toLowerCase();
    return denyKeys.some((deny) => lower.includes(deny));
  };

  // URL hygiene (spec 03 §2): raw URLs never enter the buffer — pathname + surviving query
  // key names only, values always dropped, denylisted keys dropped entirely.
  const sanitiseUrl = (raw: string): EpisodeRecord['url'] => {
    try {
      const url = new URL(raw, 'http://taujs.invalid');
      const queryKeys = [...new Set([...url.searchParams.keys()])].filter((k) => !isDenied(k));

      return { pathname: url.pathname, queryKeys, queryValuesRedacted: true };
    } catch {
      return { pathname: String(raw).split('?')[0] || '/', queryKeys: [], queryValuesRedacted: true };
    }
  };

  const filterMeta = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return cap(String(value), META_VALUE_CAP);
    if (seen.has(value as object)) return '[circular]';
    if (depth >= META_DEPTH_CAP) return '[depth]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.slice(0, 32).map((v) => filterMeta(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isDenied(k)) continue;
      out[k] = filterMeta(v, depth + 1, seen);
    }

    return out;
  };

  const pending = new Map<string, PendingEpisode>();
  const episodes: EpisodeRecord[] = [];
  const logs: LogAnnexRecord[] = [];
  const edges = new Map<string, ObservedEdge>();
  let observationsChangedAt: string | null = null;
  let totalEpisodes = 0;
  let episodesRevision = 0;
  let totalLogs = 0;

  const finalize = (episode: PendingEpisode, outcome: EpisodeRecord['outcome']): void => {
    if (episode.done) return;
    episode.done = true;
    episode.outcome = outcome;
    pending.delete(episode.requestId);

    const { t0: _t0, done: _done, ...record } = episode;
    episodes.push(record);
    totalEpisodes += 1;
    episodesRevision += 1;
    if (episodes.length > EPISODE_RING_CAP) episodes.shift();
  };

  const assembler: EpisodeRecorder = {
    requestStart(e) {
      if (pending.size >= PENDING_CAP) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(e.requestId, {
        requestId: e.requestId,
        bootId,
        at: new Date().toISOString(),
        route: null,
        appId: null,
        mode: null,
        outcome: 'complete',
        status: null,
        url: sanitiseUrl(e.url),
        timeline: {},
        serviceCalls: [],
        client: null,
        error: null,
        t0: now(),
        done: false,
      });
    },

    routeMatched(e) {
      const episode = pending.get(e.requestId);
      if (!episode) return;
      episode.route = e.path;
      episode.appId = e.appId;
      episode.mode = e.render;
      episode.timeline.matched = +(now() - episode.t0).toFixed(1);
    },

    dataFetch(e) {
      const episode = pending.get(e.requestId);
      if (!episode) return;
      const dataEnd = +(now() - episode.t0).toFixed(1);
      episode.timeline.dataEnd = dataEnd;
      episode.timeline.dataStart = +(dataEnd - e.ms).toFixed(1);
    },

    deferredData(e) {
      // RFC 0007 (R5) retention. FINALISED episodes are looked up too (the `clientHydration` idiom):
      // on a client disconnect the host records the benign abort - finalising the episode - BEFORE
      // the abort reaches the registry, so the per-key outcomes for exactly the case R5 exists to
      // explain would otherwise be dropped. An amendment to a finalised episode bumps
      // `episodesRevision`, which is what carries it into the on-disk NDJSON.
      const finalised = pending.get(e.requestId) === undefined;
      const episode = pending.get(e.requestId) ?? episodes.find((t) => t.requestId === e.requestId);
      if (!episode) return;
      (episode.deferredData ??= []).push({ key: e.key, outcome: e.outcome, ms: e.ms });
      if (finalised) episodesRevision += 1;
    },

    serviceCall(e) {
      const episode = pending.get(e.requestId);
      if (episode) episode.serviceCalls.push({ service: e.service, method: e.method, ms: e.ms, ok: e.ok });

      // Observed edge upsert — evidence lives beside the graph, never merged into it.
      const key = `${e.service}\u0000${e.method}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { service: e.service, method: e.method, routes: [], count: 0, lastObservedAt: '', sampleRequestIds: [] };
        edges.set(key, edge);
      }
      edge.count += 1;
      edge.lastObservedAt = new Date().toISOString();
      if (edge.sampleRequestIds.length < SAMPLE_REQUEST_ID_CAP && !edge.sampleRequestIds.includes(e.requestId)) edge.sampleRequestIds.push(e.requestId);
      if (episode?.route && episode.appId) {
        const routeId = `${episode.appId}:${episode.route}`;
        let row = edge.routes.find((r) => r.routeId === routeId);
        if (!row) {
          row = { routeId, appId: episode.appId, path: episode.route, count: 0 };
          edge.routes.push(row);
        }
        row.count += 1;
      }
      observationsChangedAt = edge.lastObservedAt;
    },

    streamPhase(e) {
      const episode = pending.get(e.requestId);
      if (!episode) return;
      episode.timeline[e.phase] = +(now() - episode.t0).toFixed(1);
    },

    sent(e) {
      const episode = pending.get(e.requestId);
      if (!episode || episode.done) return;
      episode.status = e.status;
      if (e.mode === 'fallthrough') episode.mode = 'fallthrough';
      finalize(episode, 'complete');
    },

    aborted(e) {
      const episode = pending.get(e.requestId);
      if (!episode || episode.done) return;
      finalize(episode, 'aborted');
    },

    failed(e) {
      const episode = pending.get(e.requestId);
      if (!episode || episode.done) return;
      episode.error = { kind: e.error.kind, message: cap(e.error.message, MESSAGE_CAP) };
      finalize(episode, 'failed');
    },

    clientHydration(e) {
      // One beacon per requestId; late beacons for evicted episodes drop silently.
      const episode = pending.get(e.requestId) ?? episodes.find((t) => t.requestId === e.requestId);
      if (!episode || episode.client) return;
      episode.client = { hydrated: e.ok, hydrationMs: e.ms ?? null, error: e.error ? cap(e.error, MESSAGE_CAP) : null };
    },
  };

  const logger = options?.logger;
  const recorder = createSafeRecorder(assembler, (err) => {
    logger?.warn(
      { component: 'introspection', error: err instanceof Error ? err.message : String(err) },
      'Episode recorder failed (non-fatal; suppressing further warnings this boot)',
    );
  });

  const recordLog = (requestId: string, level: LogAnnexRecord['level'], meta?: unknown, message?: string): void => {
    try {
      const msg = typeof message === 'string' ? message : typeof meta === 'string' ? meta : '';
      const record: LogAnnexRecord = {
        requestId,
        bootId,
        at: new Date().toISOString(),
        level,
        msg: cap(msg, MESSAGE_CAP),
        meta: meta !== undefined && typeof meta !== 'string' ? filterMeta(meta) : undefined,
      };
      logs.push(record);
      totalLogs += 1;
      if (logs.length > LOGS_RING_CAP) logs.shift();
    } catch {
      // annex capture must never affect the request (invariant 2)
    }
  };

  // Dev-only tee at the request child-logger seam (spec 03 §3): every level(meta, msg) call
  // through ctx.logger also feeds the annex; debug is excluded; delegation is unchanged.
  const wrapRequestLogger = <L extends Logs>(base: L, requestId: string): L => {
    const wrapped: Logs = {
      debug: (...args: unknown[]) => (base.debug as (...a: unknown[]) => void)(...args),
      info: (meta?: unknown, message?: string) => {
        recordLog(requestId, 'info', meta, message);
        base.info(meta, message);
      },
      warn: (meta?: unknown, message?: string) => {
        recordLog(requestId, 'warn', meta, message);
        base.warn(meta, message);
      },
      error: (meta?: unknown, message?: string) => {
        recordLog(requestId, 'error', meta, message);
        base.error(meta, message);
      },
      child: (context: Record<string, unknown>) => wrapRequestLogger(base.child(context), requestId),
      isDebugEnabled: (category) => base.isDebugEnabled(category),
    };

    return wrapped as L;
  };

  return {
    bootId,
    token,
    recorder,
    wrapRequestLogger,
    getEpisodes: (limit?: number) => (limit && limit > 0 ? episodes.slice(-limit) : [...episodes]),
    getLogs: (requestId?: string) => (requestId ? logs.filter((l) => l.requestId === requestId) : [...logs]),
    getObservations: () => ({
      schemaVersion: 1,
      bootId,
      updatedAt: observationsChangedAt ?? new Date().toISOString(),
      edges: [...edges.values()]
        .sort((a, b) => a.service.localeCompare(b.service) || a.method.localeCompare(b.method))
        // Route rows are mutable (per-route count) — copy each so a held document never drifts.
        .map((edge) => ({ ...edge, routes: edge.routes.map((r) => ({ ...r })) })),
      shapes: [],
    }),
    findEpisode: (requestId: string) => {
      const p = pending.get(requestId);
      if (p) {
        const { t0: _t0, done: _done, ...record } = p;
        return record;
      }
      return episodes.find((t) => t.requestId === requestId);
    },
    stats: () => ({ episodes: totalEpisodes, episodesRevision, logs: totalLogs, observationsUpdatedAt: observationsChangedAt }),
  };
};
