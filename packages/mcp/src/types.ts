// Substrate document shapes, v1 — duplicated from the FROZEN specs (02 request graph,
// 03 traces/files) deliberately: the files on disk are the contract between
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

export type TraceRecord = {
  traceId: string;
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
  client: { hydrated: boolean; hydrationMs: number | null; error: string | null } | null;
  error: { kind: string; message: string } | null;
};

export type LogLevel = 'info' | 'warn' | 'error';

export type LogAnnexRecord = {
  traceId: string;
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
    routes: { routeId: string; appId: string; path: string }[];
    count: number;
    lastObservedAt: string;
    sampleTraceIds: string[];
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
  traces: string;
  logs: string;
  observations: string;
};
