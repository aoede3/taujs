// @vitest-environment node
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { now } from '../../../server/src/core/telemetry/Telemetry';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { defineService, defineServiceRegistry } from '../../../server/src/core/services/DataServices';

import { NO_ACTIVE_BOOT_REFUSAL, STALE_REASON_MESSAGE } from '../SubstrateReader';
import { allTools } from '../server';
import { computeServiceConcurrency } from '../tools/runtime';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { Logs } from '../../../server/src/core/logging/types';
import type { DevJson } from '../types';
import type { ToolResult } from '../toolkit';

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'playground-react',
      entryPoint: '',
      routes: [{ path: '/product/:id', attr: { render: 'streaming', meta: {} } }, { path: '/defaulted' }],
    },
  ],
};

// Live boot: dev.json with OUR pid. Traffic seeded through the real assembler, including
// the killer-demo failure and a foreign-boot record that must be filtered out.
const seed = async (root: string) => {
  const dir = path.join(root, 'node_modules', '.taujs');
  const dev = createDevIntrospection();

  dev.recorder.requestStart({ requestId: 'ok-1', url: '/product/123', method: 'GET' });
  dev.recorder.routeMatched({ requestId: 'ok-1', path: '/product/:id', appId: 'playground-react', render: 'streaming', kind: 'page' });
  dev.recorder.serviceCall({ requestId: 'ok-1', service: 'catalog', method: 'getProduct', ms: 8, ok: true, startedAt: now() });
  dev.recorder.sent({ requestId: 'ok-1', status: 200, mode: 'streaming' });

  dev.recorder.requestStart({ requestId: 'boom-999', url: '/product/999?ref=demo', method: 'GET' });
  dev.recorder.routeMatched({ requestId: 'boom-999', path: '/product/:id', appId: 'playground-react', render: 'streaming', kind: 'page' });
  dev.recorder.serviceCall({ requestId: 'boom-999', service: 'catalog', method: 'getProduct', ms: 3, ok: false, startedAt: now() });
  dev.recorder.failed({ requestId: 'boom-999', status: 404, error: { kind: 'domain', message: 'Product 999 does not exist' } });

  dev.recorder.requestStart({ requestId: 'spa-1', url: '/spa/x', method: 'GET' });
  dev.recorder.sent({ requestId: 'spa-1', status: 200, mode: 'fallthrough' });

  const base: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, isDebugEnabled: () => false };
  base.child = () => base;
  const logger = dev.wrapRequestLogger(base as unknown as Logs, 'boom-999');
  logger.warn({ component: 'fetch-initial-data' }, 'Service method failed');
  logger.error({ kind: 'domain' }, 'Product 999 does not exist');

  const foreign = { ...dev.getEpisodes()[0]!, requestId: 'foreign-1', bootId: 'other-boot' };

  await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T11:00:00.000Z' })));
  await writeTaujsArtifact(dir, 'episodes.ndjson', [...dev.getEpisodes(), foreign].map((t) => JSON.stringify(t)).join('\n') + '\n');
  await writeTaujsArtifact(
    dir,
    'logs.ndjson',
    dev
      .getLogs()
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(dev.getObservations()));

  const devJson: DevJson = {
    bootId: dev.bootId,
    token: 'tok',
    pid: process.pid,
    startedAt: '2026-07-10T11:00:00.000Z',
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    episodes: path.join(dir, 'episodes.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
  };
  await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson));

  return dev.bootId;
};

let liveRoot: string;
let coldRoot: string;
let bootId: string;
let liveTools: Map<string, (args: Record<string, unknown>) => ToolResult>;
let coldTools: Map<string, (args: Record<string, unknown>) => ToolResult>;

// One parent for every fixture root this file creates, removed whole in afterAll.
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-runtime-'));
  liveRoot = await mkdtemp(path.join(scratch, 'live-'));
  coldRoot = await mkdtemp(path.join(scratch, 'cold-'));
  bootId = await seed(liveRoot);
  // Cold root: graph only, no dev.json — runtime tools must refuse.
  await writeTaujsArtifact(
    path.join(coldRoot, 'node_modules', '.taujs'),
    'graph.json',
    JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T08:00:00.000Z' })),
  );
  liveTools = new Map(allTools(liveRoot).map((t) => [t.name, t.handler]));
  coldTools = new Map(allTools(coldRoot).map((t) => [t.name, t.handler]));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// The live fixture's dev.json is written once, in beforeAll, but liveness is now a FRESHNESS
// question - so a slow run could age it past the window mid-suite and turn every live cell stale.
// The real server touches dev.json on its poll tick; this stands in for that tick.
beforeEach(async () => {
  const devJsonPath = path.join(liveRoot, 'node_modules', '.taujs', 'dev.json');
  const now = new Date();
  await utimes(devJsonPath, now, now);
});

const live = (name: string, args: Record<string, unknown> = {}): any => liveTools.get(name)!(args);
const cold = (name: string, args: Record<string, unknown> = {}): any => coldTools.get(name)!(args);

describe('cold-mode refusal contract (every runtime tool)', () => {
  it.each(['taujs_get_recent_episodes', 'taujs_get_episode', 'taujs_get_episode_logs'])('%s refuses without an active boot, and says WHY', (name) => {
    const result = cold(name, { requestId: 'anything' });

    // The refusal contract itself is unchanged - it is now ACCOMPANIED by the reason. "No boot has
    // ever run here" and "the boot stopped answering" call for different actions, and one message
    // for both is the conflation these tools exist to avoid.
    expect(result).toMatchObject(NO_ACTIVE_BOOT_REFUSAL);
    expect(result.staleReason).toBe('no_dev_json');
    expect(result.detail).toBe(STALE_REASON_MESSAGE.no_dev_json);
  });

  it('taujs_doctor still answers structurally in cold mode, marking runtime facts unavailable', () => {
    const result = cold('taujs_doctor');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('stale');
    expect(result.staleness).toContain('2026-07-10T08:00:00.000Z');
    expect(result.failedEpisodes.unavailable.note).toBe(NO_ACTIVE_BOOT_REFUSAL.message);
  });
});

describe('runtime tools (active boot)', () => {
  it('taujs_overview reports episode availability explicitly from the live boot', () => {
    const result = live('taujs_overview');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('active');
    expect(result.episodesAvailable).toBe(true);
    expect(result.episodesNote).toBeUndefined();
  });

  it('observations from a previous boot are masked while a boot is live, never reported as seen this boot', async () => {
    // The emitter only rewrites observations.json on the first current-boot service call, so
    // early in a boot the file on disk is still the previous boot's document.
    const catalog = defineService({ getProduct: async (_p: {}) => ({ p: 1 }) });
    const registry = defineServiceRegistry({ catalog });
    const obsConfig: CoreTaujsConfig = { apps: [{ appId: 'obs-app', entryPoint: '', routes: [{ path: '/p', attr: { render: 'ssr' } }] }] };
    const root = await mkdtemp(path.join(scratch, 'foreignobs-'));
    const dir = path.join(root, 'node_modules', '.taujs');
    await writeTaujsArtifact(
      dir,
      'graph.json',
      JSON.stringify(createRequestGraph(obsConfig, { source: 'boot', emittedAt: '2026-07-10T11:00:00.000Z', serviceRegistry: registry })),
    );
    const foreign = {
      schemaVersion: 2,
      bootId: 'previous-boot',
      updatedAt: '2026-07-10T10:59:00.000Z',
      edges: [
        {
          service: 'catalog',
          method: 'getProduct',
          routes: [{ routeId: 'obs-app:/p', appId: 'obs-app', path: '/p' }],
          count: 7,
          lastObservedAt: '2026-07-10T10:59:00.000Z',
          sampleRequestIds: ['old-1'],
        },
      ],
      shapes: [],
    };
    await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(foreign));
    const devJson: DevJson = {
      bootId: 'live-boot',
      token: 'tok',
      pid: process.pid,
      startedAt: '2026-07-10T11:00:00.000Z',
      host: '127.0.0.1',
      port: 5173,
      graph: path.join(dir, 'graph.json'),
      episodes: path.join(dir, 'episodes.ndjson'),
      logs: path.join(dir, 'logs.ndjson'),
      observations: path.join(dir, 'observations.json'),
    };
    await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson));

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const masked = tools.get('taujs_who_calls_service')!({ service: 'catalog', method: 'getProduct' }) as any;
    expect(masked.ok).toBe(true);
    expect(masked.edges).toEqual([]);
    expect(masked.note).toContain('No declared or observed edges');

    // Control: the same document stamped with the live bootId IS served, with the method-wide count.
    await writeTaujsArtifact(dir, 'observations.json', JSON.stringify({ ...foreign, bootId: 'live-boot' }));
    const seen = tools.get('taujs_who_calls_service')!({ service: 'catalog', method: 'getProduct' }) as any;
    expect(seen.ok).toBe(true);
    expect(seen.edges).toHaveLength(1);
    expect(seen.edges[0]).toMatchObject({ source: 'observed', methodCallCount: 7 });
  });

  it('taujs_who_calls_service without a registry says existence cannot be checked instead of guessing', () => {
    // This graph was emitted with no serviceRegistry and no declared data edges: an unknown name
    // is indistinguishable from an unreferenced one, and the response must say so.
    const result = live('taujs_who_calls_service', { service: 'ghost' });

    expect(result.ok).toBe(true);
    expect(result.edges).toEqual([]);
    expect(result.note).toContain('registry is not present');
    expect(result.servicesSeenOnRouteEdges.items).toEqual([]);
  });

  it('taujs_get_recent_episodes: newest first, bootId-filtered, small default, outcome filter', () => {
    const all = live('taujs_get_recent_episodes');

    expect(all.ok).toBe(true);
    expect(all.bootId).toBe(bootId);
    expect(all.episodes.items.map((t: { requestId: string }) => t.requestId)).toEqual(['spa-1', 'boom-999', 'ok-1']);
    expect(all.episodes.items.some((t: { requestId: string }) => t.requestId === 'foreign-1')).toBe(false);

    const failed = live('taujs_get_recent_episodes', { outcome: 'failed' });
    expect(failed.episodes.items).toHaveLength(1);
    expect(failed.episodes.items[0].serviceCalls).toEqual(['catalog.getProduct FAILED 3ms']);
  });

  it('taujs_get_episode returns the full record; unknown ids explain the persisted mirror', () => {
    const hit = live('taujs_get_episode', { requestId: 'boom-999' });

    expect(hit.ok).toBe(true);
    expect(hit.episode.requestIdContractRef).toBe('server:request-identity#ruling-2-the-episode-key-is-the-textual-request-id');
    expect(hit.episode.client).toBeNull();
    expect(hit.episode.clientContractRef).toBe('server:client-hydration-observation#what-client-null-means');
    expect(hit.episode.outcome).toBe('failed');
    expect(hit.episode.error).toEqual({ kind: 'domain', message: 'Product 999 does not exist' });
    expect(hit.episode.url).toEqual({ pathname: '/product/999', queryKeys: ['ref'], queryValuesRedacted: true });

    const miss = live('taujs_get_episode', { requestId: 'gone-1' });
    expect(miss.ok).toBe(false);
    // Absence names its OBSERVABLE SCOPE. A fresh episode may not have reached the persisted
    // mirror yet; an older one may have been evicted; a typo may never have been recorded.
    expect(miss.membership).toBe('not_in_episode_ring');
    expect(miss.message).toContain('persisted episode mirror');
    expect(miss.message).toContain('may not have been mirrored yet');
    expect(miss.message).toContain('may have been evicted');
    expect(miss.message).toContain('may never have been recorded');
    expect(miss.message).not.toContain('200');
  });

  it('taujs_get_episode_logs defaults to warn+ and widens on request', () => {
    const warnPlus = live('taujs_get_episode_logs', { requestId: 'boom-999' });

    expect(warnPlus.ok).toBe(true);
    expect(warnPlus.logs.map((l: { level: string }) => l.level)).toEqual(['warn', 'error']);

    const other = live('taujs_get_episode_logs', { requestId: 'ok-1' });
    expect(other.logs).toEqual([]);
    expect(other.note).toContain('framework request logger');
  });

  it('taujs_doctor surfaces the deterministic failure, warnings, and defaulted renders — source-labelled', () => {
    const result = live('taujs_doctor');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('active');
    expect(result.defaultedRenders.routeIds).toEqual(['playground-react:/defaulted']);
    expect(result.warnings.warn.some((w: { code: string }) => w.code === 'render.defaulted')).toBe(true);
    expect(result.failedEpisodes.items).toHaveLength(1);
    expect(result.failedEpisodes.items[0].error.message).toContain('999');
    expect(result.failedEpisodes.source).toContain('observed');
  });

  it('taujs_doctor states the unreachable-fallthrough note without classifying the wildcard as a pattern', async () => {
    // A terminal wildcard is a routing/ownership mechanism; the note must not brand it
    // "app-shell pattern" (vocabulary ruling, decisions.md 2026-08-09).
    const wildcardConfig: CoreTaujsConfig = {
      apps: [{ appId: 'wildcard-app', entryPoint: '', routes: [{ path: '/*', attr: { render: 'ssr', meta: {} } }] }],
    };
    const root = await mkdtemp(path.join(scratch, 'wildcard-'));
    const dir = path.join(root, 'node_modules', '.taujs');
    const dev = createDevIntrospection();
    await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(createRequestGraph(wildcardConfig, { source: 'boot', emittedAt: '2026-07-10T11:00:00.000Z' })));
    await writeTaujsArtifact(dir, 'episodes.ndjson', '\n');
    await writeTaujsArtifact(dir, 'logs.ndjson', '\n');
    await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(dev.getObservations()));
    const devJson: DevJson = {
      bootId: dev.bootId,
      token: 'tok',
      pid: process.pid,
      startedAt: '2026-07-10T11:00:00.000Z',
      host: '127.0.0.1',
      port: 5173,
      graph: path.join(dir, 'graph.json'),
      episodes: path.join(dir, 'episodes.ndjson'),
      logs: path.join(dir, 'logs.ndjson'),
      observations: path.join(dir, 'observations.json'),
    };
    await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson));

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_doctor')!({}) as any;

    expect(result.fallthrough.reachable).toBe(false);
    expect(result.fallthrough.note).toBe('A wildcard route makes fallthrough unreachable.');
    expect(result.fallthrough.note).not.toContain('app-shell');
  });
});

describe('computeServiceConcurrency (docs/followups/live/omp-hydrogen-session-residue.md item 2)', () => {
  it('five fully overlapping calls give peakConcurrent 5', () => {
    const calls = Array.from({ length: 5 }, () => ({ ms: 10, startMs: 0 }));
    expect(computeServiceConcurrency(calls)).toEqual({ totalCalls: 5, peakConcurrent: 5 });
  });

  it('three strictly sequential calls (each starting exactly when the previous ends) give peakConcurrent 1', () => {
    const calls = [
      { ms: 10, startMs: 0 },
      { ms: 10, startMs: 10 },
      { ms: 10, startMs: 20 },
    ];
    expect(computeServiceConcurrency(calls)).toEqual({ totalCalls: 3, peakConcurrent: 1 });
  });

  it('a chained pairwise overlap (A overlaps B, B overlaps C, A and C disjoint) gives peakConcurrent 2, not 3', () => {
    const calls = [
      { ms: 10, startMs: 0 }, // A: [0, 10)
      { ms: 10, startMs: 5 }, // B: [5, 15) - overlaps A and C
      { ms: 8, startMs: 12 }, // C: [12, 20) - disjoint from A
    ];
    expect(computeServiceConcurrency(calls)).toEqual({ totalCalls: 3, peakConcurrent: 2 });
  });

  it('a call missing startMs yields no result - no guess for a mixed-vintage episode', () => {
    expect(computeServiceConcurrency([{ ms: 10, startMs: 0 }, { ms: 5 }])).toBeUndefined();
  });

  it('zero calls yields no result', () => {
    expect(computeServiceConcurrency([])).toBeUndefined();
  });
});

describe('taujs_get_episode: serviceConcurrency (end-to-end through the real recorder and substrate reader)', () => {
  const writeFixture = async (dirSuffix: string, dev: ReturnType<typeof createDevIntrospection>) => {
    const root = await mkdtemp(path.join(scratch, dirSuffix));
    const dir = path.join(root, 'node_modules', '.taujs');
    await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T11:00:00.000Z' })));
    await writeTaujsArtifact(
      dir,
      'episodes.ndjson',
      dev
        .getEpisodes()
        .map((t) => JSON.stringify(t))
        .join('\n') + '\n',
    );
    await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(dev.getObservations()));
    const devJson: DevJson = {
      bootId: dev.bootId,
      token: 'tok',
      pid: process.pid,
      startedAt: '2026-07-10T11:00:00.000Z',
      host: '127.0.0.1',
      port: 5173,
      graph: path.join(dir, 'graph.json'),
      episodes: path.join(dir, 'episodes.ndjson'),
      logs: path.join(dir, 'logs.ndjson'),
      observations: path.join(dir, 'observations.json'),
    };
    await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson));
    return root;
  };

  it('derives serviceConcurrency and its sentence when every recorded call carries startMs', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: 'conc-1', url: '/product/1', method: 'GET' });
    dev.recorder.routeMatched({ requestId: 'conc-1', path: '/product/:id', appId: 'playground-react', render: 'streaming', kind: 'page' });
    const t = now();
    for (let i = 0; i < 5; i++) {
      dev.recorder.serviceCall({ requestId: 'conc-1', service: 'shopify', method: `call${i}`, ms: 50, ok: true, startedAt: t });
    }
    dev.recorder.sent({ requestId: 'conc-1', status: 200, mode: 'streaming' });

    const root = await writeFixture('concurrency-', dev);
    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_get_episode')!({ requestId: 'conc-1' }) as any;

    expect(result.ok).toBe(true);
    expect(result.episode.serviceConcurrency).toEqual({ totalCalls: 5, peakConcurrent: 5 });
    expect(result.episode.serviceConcurrencyNote).toBe('Peak concurrency was 5 across 5 recorded service calls.');
  });

  it('omits serviceConcurrency for a pre-field episode whose serviceCalls lack startMs', async () => {
    const dev = createDevIntrospection();
    const root = await writeFixture('concurrency-legacy-', dev);
    const dir = path.join(root, 'node_modules', '.taujs');

    // A hand-written legacy episode: the on-disk shape from before this field existed.
    const legacy = {
      requestId: 'legacy-1',
      bootId: dev.bootId,
      at: '2026-07-10T11:00:00.000Z',
      kind: 'page',
      route: '/product/:id',
      method: null,
      appId: 'playground-react',
      mode: 'streaming',
      outcome: 'complete',
      status: 200,
      url: { pathname: '/product/1', queryKeys: [], queryValuesRedacted: true },
      timeline: {},
      serviceCalls: [{ service: 'catalog', method: 'getProduct', ms: 5, ok: true }],
      client: null,
      error: null,
    };
    await writeTaujsArtifact(dir, 'episodes.ndjson', JSON.stringify(legacy) + '\n');

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_get_episode')!({ requestId: 'legacy-1' }) as any;

    expect(result.ok).toBe(true);
    expect(result.episode.serviceConcurrency).toBeUndefined();
    expect(result.episode.serviceConcurrencyNote).toBeUndefined();
  });

  it('omits serviceConcurrency for an episode with zero service calls', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: 'empty-1', url: '/spa/x', method: 'GET' });
    dev.recorder.sent({ requestId: 'empty-1', status: 200, mode: 'fallthrough' });

    const root = await writeFixture('concurrency-empty-', dev);
    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_get_episode')!({ requestId: 'empty-1' }) as any;

    expect(result.ok).toBe(true);
    expect(result.episode.serviceConcurrency).toBeUndefined();
  });
});
