// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

// Fixtures are produced by the REAL Phase 0 emitters, not hand-rolled JSON — the files on
// disk are the contract this adapter reads, so tests exercise that contract end-to-end.
// (dev.json is assembled to DevFiles.ts's exact field set: its emission needs a live
// fastify listen, verified in the server package's own suite.)
import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';

import {
  ADAPTER_SCHEMA_VERSION,
  NO_ACTIVE_BOOT_REFUSAL,
  NOTHING_EMITTED_MESSAGE,
  capStrings,
  discoverSubstrate,
  readGraph,
  readLogs,
  readObservations,
  readTraces,
} from '../SubstrateReader';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { Logs } from '../../../server/src/core/logging/types';
import type { DevJson } from '../types';

const config: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

const OPTS = { source: 'boot', emittedAt: '2026-07-10T09:00:00.000Z' } as const;

const mkRoot = async () => mkdtemp(path.join(tmpdir(), 'taujs-mcp-'));
const taujsDir = (root: string) => path.join(root, 'node_modules', '.taujs');

const emitGraph = async (root: string, mutate?: (graph: Record<string, unknown>) => void) => {
  const graph = JSON.parse(JSON.stringify(createRequestGraph(config, OPTS))) as Record<string, unknown>;
  mutate?.(graph);
  await writeTaujsArtifact(taujsDir(root), 'graph.json', JSON.stringify(graph, null, 2));
  return graph;
};

const emitDevJson = async (root: string, overrides?: Partial<DevJson>) => {
  const dir = taujsDir(root);
  const devJson: DevJson = {
    bootId: 'boot-1',
    token: 'tok',
    pid: process.pid,
    startedAt: OPTS.emittedAt,
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    traces: path.join(dir, 'traces.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
    ...overrides,
  };
  await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson, null, 2));
  return devJson;
};

// Records via the real assembler, mirrored to disk exactly as DevFiles does.
const emitTraces = async (root: string, seed: (dev: ReturnType<typeof createDevIntrospection>) => void) => {
  const dev = createDevIntrospection();
  seed(dev);
  await writeTaujsArtifact(
    taujsDir(root),
    'traces.ndjson',
    dev
      .getTraces()
      .map((t) => JSON.stringify(t))
      .join('\n') + '\n',
  );
  await writeTaujsArtifact(
    taujsDir(root),
    'logs.ndjson',
    dev
      .getLogs()
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  await writeTaujsArtifact(taujsDir(root), 'observations.json', JSON.stringify(dev.getObservations(), null, 2));
  return dev;
};

describe('discoverSubstrate — freshness matrix', () => {
  it('none: nothing emitted yet, with the first-run message', async () => {
    const root = await mkRoot();

    const d = discoverSubstrate(root);

    expect(d).toEqual({ mode: 'none', message: NOTHING_EMITTED_MESSAGE });
  });

  it('active: dev.json with a live pid, paths taken from dev.json', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    const devJson = await emitDevJson(root);

    const d = discoverSubstrate(root);

    expect(d.mode).toBe('active');
    if (d.mode === 'active') {
      expect(d.devJson.bootId).toBe('boot-1');
      expect(d.paths.graph).toBe(devJson.graph);
    }
  });

  it('stale: dev.json with a dead pid falls back to stale (crash case)', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    await emitDevJson(root, { pid: 999999999 });

    const d = discoverSubstrate(root);

    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') expect(d.devJson?.bootId).toBe('boot-1');
  });

  it('stale: build graph only (dist/.taujs) when no boot artifacts exist', async () => {
    const root = await mkRoot();
    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const graph = createRequestGraph(config, { ...OPTS, source: 'build' });
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(graph));

    const d = discoverSubstrate(root);

    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') expect(d.paths.graph).toBe(path.join(distDir, 'graph.json'));
  });
});

describe('readGraph', () => {
  it('active mode: graph with no staleness line', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    await emitDevJson(root);

    const result = readGraph(discoverSubstrate(root));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.schemaVersion).toBe(ADAPTER_SCHEMA_VERSION);
      expect(result.graph.routes[0]!.id).toBe('web:/');
      expect(result.stalenessLine).toBeNull();
    }
  });

  it('stale mode: cites emittedAt and source in the staleness line', async () => {
    const root = await mkRoot();
    await emitGraph(root);

    const result = readGraph(discoverSubstrate(root));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stalenessLine).toContain('2026-07-10T09:00:00.000Z');
      expect(result.stalenessLine).toContain('dev boot');
    }
  });

  it('schema skew degrades explicitly, never misreads', async () => {
    const root = await mkRoot();
    await emitGraph(root, (g) => {
      g.schemaVersion = 2;
    });

    const result = readGraph(discoverSubstrate(root));

    expect(result).toEqual({
      ok: false,
      reason: 'schema_skew',
      message: 'Request graph is schema v2; this adapter understands v1 — upgrade @taujs/mcp.',
    });
  });

  it('unparseable graph reports unreadable, not a crash', async () => {
    const root = await mkRoot();
    await writeTaujsArtifact(taujsDir(root), 'graph.json', '{not json');

    const result = readGraph(discoverSubstrate(root));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreadable');
  });
});

describe('readTraces', () => {
  const seedThree = (dev: ReturnType<typeof createDevIntrospection>) => {
    for (const [i, mode] of (['ssr', 'streaming', 'fallthrough'] as const).entries()) {
      dev.recorder.requestStart({ traceId: `t-${i}`, url: `/p${i}`, method: 'GET' });
      dev.recorder.sent({ traceId: `t-${i}`, status: 200, mode });
    }
  };

  it('reads records newest-last, filters by bootId, and honours limit from the end', async () => {
    const root = await mkRoot();
    const dev = await emitTraces(root, seedThree);
    await emitDevJson(root, { bootId: dev.bootId });

    const discovery = discoverSubstrate(root);
    const all = readTraces(discovery);
    expect(all.map((t) => t.traceId)).toEqual(['t-0', 't-1', 't-2']);

    expect(readTraces(discovery, { limit: 2 }).map((t) => t.traceId)).toEqual(['t-1', 't-2']);
    expect(readTraces(discovery, { bootId: dev.bootId })).toHaveLength(3);
    expect(readTraces(discovery, { bootId: 'other-boot' })).toHaveLength(0);
  });

  it('skips corrupt ndjson lines without failing the read', async () => {
    const root = await mkRoot();
    const dev = await emitTraces(root, seedThree);
    const tracesPath = path.join(taujsDir(root), 'traces.ndjson');
    const good = dev.getTraces().map((t) => JSON.stringify(t));
    await writeFile(tracesPath, `${good[0]}\n{torn line\n${good[1]}\n`, 'utf8');

    expect(readTraces(discoverSubstrate(root))).toHaveLength(2);
  });
});

describe('readLogs', () => {
  it('filters per-trace at warn+ by default; explicit info widens', async () => {
    const root = await mkRoot();
    await emitTraces(root, (dev) => {
      dev.recorder.requestStart({ traceId: 'trace-a', url: '/a', method: 'GET' });
      const base: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, isDebugEnabled: () => false };
      base.child = () => base;
      const logger = dev.wrapRequestLogger(base as unknown as Logs, 'trace-a');
      logger.info({}, 'info line');
      logger.warn({}, 'warn line');
      logger.error({}, 'error line');
      dev.recorder.sent({ traceId: 'trace-a', status: 200, mode: 'ssr' });
    });

    const discovery = discoverSubstrate(root);

    expect(readLogs(discovery, { traceId: 'trace-a' }).map((l) => l.level)).toEqual(['warn', 'error']);
    expect(readLogs(discovery, { traceId: 'trace-a', minLevel: 'info' })).toHaveLength(3);
    expect(readLogs(discovery, { traceId: 'other' })).toHaveLength(0);
  });
});

describe('readObservations', () => {
  it('reads the real document and reports skew explicitly', async () => {
    const root = await mkRoot();
    await emitTraces(root, (dev) => {
      dev.recorder.requestStart({ traceId: 't-obs', url: '/p', method: 'GET' });
      dev.recorder.routeMatched({ traceId: 't-obs', path: '/p', appId: 'web', render: 'ssr' });
      dev.recorder.serviceCall({ traceId: 't-obs', service: 'catalog', method: 'getProduct', ms: 5, ok: true });
      dev.recorder.sent({ traceId: 't-obs', status: 200, mode: 'ssr' });
    });

    const result = readObservations(discoverSubstrate(root));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observations.edges[0]).toMatchObject({ service: 'catalog', method: 'getProduct', count: 1 });
      expect(result.observations.shapes).toEqual([]);
    }
  });
});

describe('hardening', () => {
  it('caps every string read from disk at 500 chars', () => {
    const capped = capStrings({ nested: { long: 'x'.repeat(2000) }, list: ['y'.repeat(600)] });

    expect(capped.nested.long).toHaveLength(500);
    expect(capped.list[0]).toHaveLength(500);
  });

  it('exports the refusal contract verbatim', () => {
    expect(NO_ACTIVE_BOOT_REFUSAL).toEqual({
      ok: false,
      reason: 'no_active_dev_boot',
      message: 'Structural tools remain available; runtime traces require the dev server (pnpm dev).',
    });
  });
});
