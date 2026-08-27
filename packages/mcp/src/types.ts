// Substrate document shapes, v1 — duplicated from the FROZEN specs (02 request graph,
// 03 episodes/files) deliberately: the files on disk are the contract between
// @taujs/server and this adapter, not a shared TypeScript package. The adapter has no
// runtime dependency on @taujs/server (RFC v11); schemaVersion checks guard drift.

export type GraphSource = 'boot' | 'build';

export type GraphSchemaFlag = { declared: boolean; kind?: 'parse' | 'function' };

export type GraphWarning = {
  code: string;
  severity: 'error' | 'warn' | 'info';
  source: string;
  routeId?: string;
  message?: string;
};

export type GraphRouteData = { kind: 'none' } | { kind: 'dynamic' } | { kind: 'service'; service: string; method: string };

export type GraphRoute = {
  id: string;
  appId: string;
  path: string;
  render: { strategy: 'ssr' | 'streaming'; defaulted: boolean };
  hydrate: { enabled: boolean; defaulted: boolean };
  specificity: number;
  middleware: { auth: { declared: boolean }; csp: Record<string, unknown> };
  data: GraphRouteData;
  /** RFC 0007 (R5): declared deferred entries, key-sorted; absent when the route declares none. */
  deferred?: { key: string; data: GraphRouteData }[];
  /** head edge, mirrors data (decisions.md 2026-08-27): present only when `attr.head.data` is declared. */
  head?: { data: GraphRouteData };
};

export type GraphServiceMethod = {
  name: string;
  params: GraphSchemaFlag;
  result: GraphSchemaFlag;
  usedBy: { routeId: string; appId: string; path: string }[];
};

export type GraphService = { name: string; methods: GraphServiceMethod[] };

export type RequestGraphV1 = {
  schemaVersion: 1;
  taujs: { server: string };
  source: GraphSource;
  emittedAt: string;
  disclosure: 'conservative';
  apps: { appId: string; entryPoint: string; routeCount: number }[];
  routes: GraphRoute[];
  services: GraphService[] | null;
  security: { cspDefaultMode: 'merge' | 'replace'; reporting: boolean };
  fallthrough: { mode: 'spa'; appId: string; assetLike: 404; reachable: boolean };
  warnings: GraphWarning[];
};

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
  timeline: Partial<Record<'matched' | 'dataStart' | 'dataEnd' | 'head' | 'shellReady' | 'allReady', number>>;
  serviceCalls: { service: string; method: string; ms: number; ok: boolean }[];
  /**
   * RFC 0007 (R5): per-key deferred outcomes, in arrival order. Additive-optional and ABSENT for an
   * episode with no deferred events, which is why a reader that never declared it still worked -
   * the value flowed through `taujs_get_episode` untyped, and the suite had to reach it by hand
   * cast. This file exists precisely so the on-disk contract is stated somewhere, so a field the
   * emitter has written since RFC 0007 belongs in it.
   */
  deferredData?: { key: string; outcome: 'complete' | 'failed' | 'aborted'; ms: number }[];
  client: { hydrated: boolean; hydrationMs: number | null; error: string | null } | null;
  error: { kind: string; message: string } | null;
};

export type LogLevel = 'info' | 'warn' | 'error';

export type LogAnnexRecord = {
  requestId: string;
  bootId: string;
  at: string;
  level: LogLevel;
  msg: string;
  meta?: unknown;
};

export type ObservationsDocument = {
  schemaVersion: 1;
  bootId: string;
  updatedAt: string;
  edges: {
    service: string;
    method: string;
    /** `count` per route (additive, spec 03 §4 2026-08-20): calls attributed to that route; absent from older emissions. */
    routes: { routeId: string; appId: string; path: string; count?: number }[];
    count: number;
    lastObservedAt: string;
    sampleRequestIds: string[];
  }[];
  shapes: unknown[]; // deferred in v1 (decisions.md) — never promise content
};

export type DevJson = {
  bootId: string;
  token: string;
  pid: number;
  startedAt: string;
  host: string | null;
  port: number | null;
  graph: string;
  episodes: string;
  logs: string;
  observations: string;
};
