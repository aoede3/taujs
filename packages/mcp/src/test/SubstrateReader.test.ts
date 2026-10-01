// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Fixtures are produced by the REAL Phase 0 emitters, not hand-rolled JSON — the files on
// disk are the contract this adapter reads, so tests exercise that contract end-to-end.
// (dev.json is assembled to DevFiles.ts's exact field set: its emission needs a live
// fastify listen, verified in the server package's own suite.)
import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { now } from '../../../server/src/core/telemetry/Telemetry';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';

import {
  GRAPH_SCHEMA_VERSION,
  OBSERVATIONS_SCHEMA_VERSION,
  NO_ACTIVE_BOOT_REFUSAL,
  NOTHING_EMITTED_MESSAGE,
  capStrings,
  discoverSubstrate,
  readGraph,
  readLogs,
  readObservations,
  readEpisodes,
} from '../SubstrateReader';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { Logs } from '../../../server/src/core/logging/types';
import type { SubstrateDiscovery } from '../SubstrateReader';
import type { DevJson } from '../types';

// None of these fixtures produce more than one live boot folder except the dedicated
// multiple_active_boots cells below (which call discoverSubstrate directly and never feed the
// result into a read* function) - this wrapper narrows that branch away so every other cell can
// pass its discovery straight into readGraph/readEpisodes/readLogs/readObservations.
const discover = (root: string): Exclude<SubstrateDiscovery, { mode: 'multiple_active_boots' }> => {
  const d = discoverSubstrate(root);
  if (d.mode === 'multiple_active_boots') throw new Error('test fixture produced multiple_active_boots unexpectedly');
  return d;
};

const config: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

const OPTS = { source: 'boot', emittedAt: '2026-07-10T09:00:00.000Z' } as const;

// One parent for every root this file creates, removed whole in afterAll.
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-reader-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const mkRoot = async () => mkdtemp(path.join(scratch, 'root-'));

// Per-boot directories (rev 3.1): every boot's own artefacts live under
// node_modules/.taujs/boots/<bootId>/. BOOT_ID is the default folder every helper below writes
// to unless a cell passes its own - most cells need exactly one boot and never care which id.
const BOOT_ID = 'boot-1';
const taujsDir = (root: string) => path.join(root, 'node_modules', '.taujs');
const bootDir = (root: string, bootId: string = BOOT_ID) => path.join(taujsDir(root), 'boots', bootId);

const emitGraph = async (root: string, mutate?: (graph: Record<string, unknown>) => void, bootId: string = BOOT_ID) => {
  const graph = JSON.parse(JSON.stringify(createRequestGraph(config, OPTS))) as Record<string, unknown>;
  // The emitter stamps bootId on every boot graph (rev 3.1, emitter rule 5) - mirrored here so a
  // migrated fixture reads exactly as a real per-boot emitter would, unless a cell's own
  // `mutate` deliberately strips or changes it.
  if (graph.source === 'boot') graph.bootId = bootId;
  mutate?.(graph);
  await writeTaujsArtifact(bootDir(root, bootId), 'graph.json', JSON.stringify(graph, null, 2));
  return graph;
};

const emitDevJson = async (root: string, overrides?: Partial<DevJson>, bootId: string = BOOT_ID) => {
  const dir = bootDir(root, bootId);
  const devJson: DevJson = {
    bootId,
    token: 'tok',
    pid: process.pid,
    startedAt: OPTS.emittedAt,
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    episodes: path.join(dir, 'episodes.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
    ...overrides,
  };
  await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson, null, 2));
  return devJson;
};

// Records via the real assembler, mirrored to disk exactly as DevFiles does.
const emitEpisodes = async (root: string, seed: (dev: ReturnType<typeof createDevIntrospection>) => void, bootId: string = BOOT_ID) => {
  const dev = createDevIntrospection();
  seed(dev);
  await writeTaujsArtifact(
    bootDir(root, bootId),
    'episodes.ndjson',
    dev
      .getEpisodes()
      .map((t) => JSON.stringify(t))
      .join('\n') + '\n',
  );
  await writeTaujsArtifact(
    bootDir(root, bootId),
    'logs.ndjson',
    dev
      .getLogs()
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  await writeTaujsArtifact(bootDir(root, bootId), 'observations.json', JSON.stringify(dev.getObservations(), null, 2));
  return dev;
};

describe('discoverSubstrate — freshness matrix', () => {
  it('none: nothing emitted yet, with the first-run message', async () => {
    const root = await mkRoot();

    const d = discover(root);

    expect(d).toEqual({ mode: 'none', message: NOTHING_EMITTED_MESSAGE });
  });

  it('active: dev.json with a live pid, paths taken from dev.json', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    const devJson = await emitDevJson(root);

    const d = discover(root);

    expect(d.mode).toBe('active');
    if (d.mode === 'active') {
      expect(d.devJson.bootId).toBe('boot-1');
      expect(d.paths.graph).toBe(devJson.graph);
      expect(d.bootFolder).toBe('boot-1');
    }
  });

  it('stale: dev.json with a dead pid falls back to stale (crash case)', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    await emitDevJson(root, { pid: 999999999 });

    const d = discover(root);

    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') expect(d.devJson?.bootId).toBe('boot-1');
  });

  it('stale: build graph only (dist/.taujs) when no boot artifacts exist at all (no node_modules/.taujs either)', async () => {
    const root = await mkRoot();
    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const graph = createRequestGraph(config, { ...OPTS, source: 'build' });
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(graph));

    const d = discover(root);

    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') expect(d.paths.graph).toBe(path.join(distDir, 'graph.json'));
  });

  it('stale: build graph only, with an EMPTY boots/ directory present (per-boot layout, no boot ever ran)', async () => {
    const root = await mkRoot();
    await mkdir(path.join(taujsDir(root), 'boots'), { recursive: true });
    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const graph = createRequestGraph(config, { ...OPTS, source: 'build' });
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(graph));

    const d = discover(root);

    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') {
      expect(d.reason).toBe('no_dev_json');
      expect(d.paths.graph).toBe(path.join(distDir, 'graph.json'));
    }
  });

  it('multiple_active_boots: two live folders are refused together, listing both, sorted by startedAt', async () => {
    const root = await mkRoot();
    await emitDevJson(root, { startedAt: '2026-07-10T09:05:00.000Z', host: '127.0.0.1', port: 5174 }, 'boot-b');
    await emitDevJson(root, { startedAt: '2026-07-10T09:00:00.000Z', host: '127.0.0.1', port: 5173 }, 'boot-a');

    const d = discoverSubstrate(root);

    expect(d).toMatchObject({
      mode: 'multiple_active_boots',
      boots: [
        { bootId: 'boot-a', startedAt: '2026-07-10T09:00:00.000Z', host: '127.0.0.1', port: 5173 },
        { bootId: 'boot-b', startedAt: '2026-07-10T09:05:00.000Z', host: '127.0.0.1', port: 5174 },
      ],
    });
  });

  it('one live folder plus one closed folder: the live one is active, the closed one is invisible to discovery', async () => {
    const root = await mkRoot();
    await emitDevJson(root, { state: 'closed' }, 'boot-closed');
    await emitDevJson(root, {}, 'boot-live');

    const d = discover(root);

    expect(d).toMatchObject({ mode: 'active', devJson: { bootId: 'boot-live' }, bootFolder: 'boot-live' });
  });

  it('only closed folders: stale with reason closed, naming that boot', async () => {
    const root = await mkRoot();
    await emitGraph(root, undefined, 'boot-closed');
    await emitDevJson(root, { state: 'closed' }, 'boot-closed');

    const d = discover(root);

    expect(d).toMatchObject({ mode: 'stale', reason: 'closed', devJson: { bootId: 'boot-closed' }, bootFolder: 'boot-closed' });

    const result = readGraph(d);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stalenessLine).toBe('As of boot boot-closed at 2026-07-10T09:00:00.000Z — no active dev server; data may be stale.');
  });

  it('closed wins over a live pid: two servers can share one process, and a closed marker is never read as live', async () => {
    const root = await mkRoot();
    await emitDevJson(root, { state: 'closed', pid: process.pid }, 'boot-closed-shared-pid');

    const d = discover(root);

    expect(d).toMatchObject({ mode: 'stale', reason: 'closed' });
  });

  it('dev_json_invalid is reported for a folder whose dev.json fails schema validation', async () => {
    const root = await mkRoot();
    const dir = bootDir(root, 'boot-bad');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'dev.json'), JSON.stringify({ pid: process.pid }), 'utf8');

    const d = discover(root);

    expect(d).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });
  });

  it('dev_json_unreadable is reported for a folder whose dev.json is not JSON', async () => {
    const root = await mkRoot();
    const dir = bootDir(root, 'boot-torn');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'dev.json'), 'not json', 'utf8');

    const d = discover(root);

    expect(d).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });
  });

  it('newest-of-stale: compares the newest boot folder against dist/.taujs/graph.json by emittedAt and says which wins', async () => {
    const root = await mkRoot();
    await emitGraph(root, (g) => {
      g.emittedAt = '2026-01-01T00:00:00.000Z';
    });
    await emitDevJson(root, { state: 'closed', startedAt: '2026-01-01T00:00:00.000Z' });

    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const buildGraph = createRequestGraph(config, { source: 'build', emittedAt: '2026-06-01T00:00:00.000Z' });
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(buildGraph));

    const d = discover(root);
    expect(d.mode).toBe('stale');
    if (d.mode !== 'stale') return;
    expect(d.paths.graph).toBe(path.join(distDir, 'graph.json'));
    expect(d.bootFolder).toBeUndefined();

    const result = readGraph(d);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.source).toBe('build');

    // The reverse: an older build loses to a newer closed boot.
    const root2 = await mkRoot();
    await emitGraph(root2, (g) => {
      g.emittedAt = '2026-06-01T00:00:00.000Z';
    });
    await emitDevJson(root2, { state: 'closed', startedAt: '2026-06-01T00:00:00.000Z' });
    const distDir2 = path.join(root2, 'dist', '.taujs');
    await mkdir(distDir2, { recursive: true });
    await writeTaujsArtifact(distDir2, 'graph.json', JSON.stringify(createRequestGraph(config, { source: 'build', emittedAt: '2026-01-01T00:00:00.000Z' })));

    const d2 = discover(root2);
    expect(d2.mode).toBe('stale');
    if (d2.mode !== 'stale') return;
    expect(d2.paths.graph).toBe(path.join(bootDir(root2), 'graph.json'));
    expect(d2.bootFolder).toBe(BOOT_ID);
  });
});

describe('readGraph', () => {
  it('active mode: graph with no staleness line', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    await emitDevJson(root);

    const result = readGraph(discover(root));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
      expect(result.graph.routes[0]!.id).toBe('web:/');
      expect(result.stalenessLine).toBeNull();
    }
  });

  it('stale mode, per-boot layout: the staleness line names the boot', async () => {
    const root = await mkRoot();
    await emitGraph(root);

    const result = readGraph(discover(root));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stalenessLine).toBe('As of boot boot-1 at 2026-07-10T09:00:00.000Z — no active dev server; data may be stale.');
    }
  });

  it("root compat (older emitter, no bootId, no boots/): stale mode cites the generic 'last dev boot' text exactly as before", async () => {
    const root = await mkRoot();
    const graph = JSON.parse(JSON.stringify(createRequestGraph(config, OPTS))) as Record<string, unknown>;
    // Deliberately NOT stamped with bootId: this is what an emitter predating per-boot
    // directories produced, and it never created boots/ either.
    await writeTaujsArtifact(taujsDir(root), 'graph.json', JSON.stringify(graph, null, 2));

    const d = discover(root);
    expect(d.mode).toBe('stale');
    if (d.mode === 'stale') expect(d.bootFolder).toBeUndefined();

    const result = readGraph(d);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // source: 'boot', no bootId — the pre-rev-3.1 text, unchanged.
      expect(result.stalenessLine).toBe('As of the last dev boot at 2026-07-10T09:00:00.000Z — no active dev server; data may be stale.');
    }
  });

  it("stale mode, source: build — the staleness line cites emittedAt as the topology graph's emission, not a rebuild attestation", async () => {
    const root = await mkRoot();
    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const graph = createRequestGraph(config, { ...OPTS, source: 'build' });
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(graph));

    const result = readGraph(discover(root));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stalenessLine).toContain('2026-07-10T09:00:00.000Z');
      expect(result.stalenessLine).toContain('not when every referenced application bundle was rebuilt');
    }
  });

  it('a graph document at schemaVersion 1 is refused by the reader with the upgrade message', async () => {
    const root = await mkRoot();
    await emitGraph(root, (g) => {
      g.schemaVersion = 1;
    });

    const result = readGraph(discover(root));

    expect(result).toEqual({
      ok: false,
      reason: 'schema_skew',
      message: 'Request graph is schema v1; this adapter understands v3 — upgrade @taujs/mcp.',
    });
  });

  it('unparseable graph reports unreadable, not a crash', async () => {
    const root = await mkRoot();
    await writeTaujsArtifact(bootDir(root), 'graph.json', '{not json');

    const result = readGraph(discover(root));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreadable');
  });

  it('a schemaVersion 3 boot graph with no bootId is refused as malformed under per-boot directories', async () => {
    const root = await mkRoot();
    await emitGraph(root, (g) => {
      delete g.bootId;
    });

    const result = readGraph(discover(root));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreadable');
      expect(result.message).toContain('malformed');
    }
  });

  it('a build graph with no bootId is fine (builds never carry one)', async () => {
    const root = await mkRoot();
    const distDir = path.join(root, 'dist', '.taujs');
    await mkdir(distDir, { recursive: true });
    const graph = createRequestGraph(config, { ...OPTS, source: 'build' });
    expect((graph as unknown as Record<string, unknown>).bootId).toBeUndefined();
    await writeTaujsArtifact(distDir, 'graph.json', JSON.stringify(graph));

    const result = readGraph(discover(root));

    expect(result.ok).toBe(true);
  });

  it('substrate_inconsistent: folder name, dev.json bootId and graph.json bootId disagree', async () => {
    const root = await mkRoot();
    // The folder is named 'boot-folder', dev.json says its own bootId is 'boot-dev-json', and the
    // graph inside it says 'boot-graph' — three different stories about the same boot.
    await emitGraph(
      root,
      (g) => {
        g.bootId = 'boot-graph';
      },
      'boot-folder',
    );
    await emitDevJson(root, { bootId: 'boot-dev-json' }, 'boot-folder');

    const discovery = discover(root);
    expect(discovery.mode).toBe('active');

    const result = readGraph(discovery);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('substrate_inconsistent');
      expect(result.message).toContain('boot-folder');
      expect(result.message).toContain('boot-dev-json');
      expect(result.message).toContain('boot-graph');
    }
  });

  it('a folder with no graph yet is simply "graph not present", never substrate_inconsistent', async () => {
    const root = await mkRoot();
    await emitDevJson(root, { bootId: 'mismatched-but-irrelevant' }, 'boot-no-graph');

    const discovery = discover(root);
    const result = readGraph(discovery);

    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('readEpisodes', () => {
  const seedThree = (dev: ReturnType<typeof createDevIntrospection>) => {
    for (const [i, mode] of (['ssr', 'streaming', 'fallthrough'] as const).entries()) {
      dev.recorder.requestStart({ requestId: `t-${i}`, url: `/p${i}`, method: 'GET' });
      dev.recorder.sent({ requestId: `t-${i}`, status: 200, mode });
    }
  };

  it('never reads a legacy traces.ndjson: only episodes are current-boot evidence; contract: server:request-identity#ruling-9-request-observations-use-episode-vocabulary', async () => {
    const root = await mkRoot();
    await emitGraph(root);
    await emitDevJson(root);
    // A leftover pre-rename artefact with a plausible record; no episodes.ndjson exists.
    await writeTaujsArtifact(bootDir(root), 'traces.ndjson', '{"requestId":"stale-legacy","bootId":"boot-1"}\n');

    const discovery = discover(root);

    expect(discovery.mode).toBe('active');
    // No episodes.ndjson exists in this fixture, so containment hands back undefined rather than
    // the conventional name unvalidated - the honest answer is that the artefact is absent, NOT an
    // empty list, which would have claimed the boot recorded nothing. Either way the legacy file is
    // never opened, which is what this cell is for.
    expect((discovery as { paths: { episodes?: string } }).paths.episodes).toBeUndefined();
    expect(readEpisodes(discovery)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('reads records newest-last, filters by bootId, and honours limit from the end', async () => {
    const root = await mkRoot();
    const dev = await emitEpisodes(root, seedThree);
    await emitDevJson(root, { bootId: dev.bootId });

    const discovery = discover(root);
    const all = readEpisodes(discovery);
    expect(all.ok && all.records.map((t) => t.requestId)).toEqual(['t-0', 't-1', 't-2']);

    const limited = readEpisodes(discovery, { limit: 2 });
    expect(limited.ok && limited.records.map((t) => t.requestId)).toEqual(['t-1', 't-2']);
    expect(readEpisodes(discovery, { bootId: dev.bootId })).toMatchObject({ ok: true, records: expect.objectContaining({ length: 3 }) });
    expect(readEpisodes(discovery, { bootId: 'other-boot' })).toMatchObject({ ok: true, records: [] });
  });

  it('skips corrupt ndjson lines without failing the read, and COUNTS them', async () => {
    const root = await mkRoot();
    const dev = await emitEpisodes(root, seedThree);
    const episodesPath = path.join(bootDir(root), 'episodes.ndjson');
    const good = dev.getEpisodes().map((t) => JSON.stringify(t));
    await writeFile(episodesPath, `${good[0]}\n{torn line\n${good[1]}\n`, 'utf8');

    const read = readEpisodes(discover(root));

    // The count is the point. Dropping the line is right; dropping it SILENTLY is how "I could not
    // read this" became "this is not here".
    expect(read).toMatchObject({ ok: true, malformed: 1 });
    expect(read.ok && read.records).toHaveLength(2);
  });

  it('counts a line that PARSES but is not an episode, rather than handing it to the tools', async () => {
    const root = await mkRoot();
    const dev = await emitEpisodes(root, seedThree);
    const good = dev.getEpisodes().map((t) => JSON.stringify(t));
    // Valid JSON, no `url` - the field every episode projection dereferences. This is the line that
    // used to reach `t.url.pathname` and throw the whole tool out of its envelope.
    await writeFile(path.join(bootDir(root), 'episodes.ndjson'), `${good[0]}\n{"requestId":"x","bootId":"b"}\n`, 'utf8');

    const read = readEpisodes(discover(root));

    expect(read).toMatchObject({ ok: true, malformed: 1 });
    expect(read.ok && read.records).toHaveLength(1);
  });

  it('a directory where episodes.ndjson belongs is refused as not_found, never opened', async () => {
    const root = await mkRoot();
    await emitEpisodes(root, seedThree);
    await emitDevJson(root);
    // A directory where a regular file is expected fails containment and is never opened.
    await rm(path.join(bootDir(root), 'episodes.ndjson'), { force: true });
    await mkdir(path.join(bootDir(root), 'episodes.ndjson'), { recursive: true });

    const discovery = discover(root);
    expect((discovery as { paths: { episodes?: string } }).paths.episodes).toBeUndefined();
    expect(readEpisodes(discovery)).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('readLogs', () => {
  it('filters per-episode at warn+ by default; explicit info widens', async () => {
    const root = await mkRoot();
    await emitEpisodes(root, (dev) => {
      dev.recorder.requestStart({ requestId: 'episode-a', url: '/a', method: 'GET' });
      const base: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, isDebugEnabled: () => false };
      base.child = () => base;
      const logger = dev.wrapRequestLogger(base as unknown as Logs, 'episode-a');
      logger.info({}, 'info line');
      logger.warn({}, 'warn line');
      logger.error({}, 'error line');
      dev.recorder.sent({ requestId: 'episode-a', status: 200, mode: 'ssr' });
    });

    const discovery = discover(root);

    const warnPlus = readLogs(discovery, { requestId: 'episode-a' });
    expect(warnPlus.ok && warnPlus.records.map((l) => l.level)).toEqual(['warn', 'error']);
    expect(readLogs(discovery, { requestId: 'episode-a', minLevel: 'info' })).toMatchObject({ ok: true, anyLevelCount: 3 });
    expect(readLogs(discovery, { requestId: 'other' })).toMatchObject({ ok: true, records: [], anyLevelCount: 0 });
  });
});

describe('readObservations', () => {
  it('an observations document at schemaVersion 2 (RFC 0018, the current version) is accepted', async () => {
    const root = await mkRoot();
    await emitEpisodes(root, (dev) => {
      dev.recorder.requestStart({ requestId: 't-obs', url: '/p', method: 'GET' });
      dev.recorder.routeMatched({ requestId: 't-obs', path: '/p', appId: 'web', render: 'ssr', kind: 'page' });
      dev.recorder.serviceCall({ requestId: 't-obs', service: 'catalog', method: 'getProduct', ms: 5, ok: true, startedAt: now() });
      dev.recorder.sent({ requestId: 't-obs', status: 200, mode: 'ssr' });
    });

    const result = readObservations(discover(root));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // This is the real, unmutated document the server emitted - RFC 0018 owns version 2 outright.
      expect(result.observations.schemaVersion).toBe(OBSERVATIONS_SCHEMA_VERSION);
      expect(result.observations.edges[0]).toMatchObject({ service: 'catalog', method: 'getProduct', count: 1 });
      expect(result.observations.shapes).toEqual([]);
    }
  });

  it('an observations document at schemaVersion 1 (pre-RFC-0018) is refused with the upgrade message', async () => {
    const root = await mkRoot();
    const dev = await emitEpisodes(root, () => {});
    await writeTaujsArtifact(bootDir(root), 'observations.json', JSON.stringify({ ...dev.getObservations(), schemaVersion: 1 }, null, 2));

    expect(readObservations(discover(root))).toEqual({
      ok: false,
      reason: 'schema_skew',
      message: 'Observations are schema v1; this adapter understands v2 — upgrade @taujs/mcp.',
    });
  });

  it('RFC 0018: a v1 observations document refuses episodes.ndjson too, as a paired read, even though episodes.ndjson parses cleanly on its own', async () => {
    const root = await mkRoot();
    const dev = await emitEpisodes(root, (d) => {
      d.recorder.requestStart({ requestId: 'paired-1', url: '/p', method: 'GET' });
      d.recorder.routeMatched({ requestId: 'paired-1', path: '/p', appId: 'web', render: 'ssr', kind: 'page' });
      d.recorder.sent({ requestId: 'paired-1', status: 200, mode: 'ssr' });
    });
    // episodes.ndjson on disk is a perfectly valid v2 record - only observations.json is rolled
    // back, to prove the gate reads the PAIRED version rather than validating episodes alone.
    await writeTaujsArtifact(bootDir(root), 'observations.json', JSON.stringify({ ...dev.getObservations(), schemaVersion: 1 }, null, 2));

    const discovery = discover(root);
    const episodesRead = readEpisodes(discovery);
    expect(episodesRead.ok).toBe(false);
    if (!episodesRead.ok) {
      expect(episodesRead.reason).toBe('unreadable');
      expect(episodesRead.message).toContain('refused together with observations');
    }

    // Both documents refuse together - fail closed, not one silently trusted while the other skews.
    expect(readObservations(discovery)).toMatchObject({ ok: false, reason: 'schema_skew' });
  });

  it('RFC 0018: a MISSING observations.json refuses episodes.ndjson too, even though episodes.ndjson exists and parses cleanly', async () => {
    const root = await mkRoot();
    await emitEpisodes(root, (d) => {
      d.recorder.requestStart({ requestId: 'paired-2', url: '/p', method: 'GET' });
      d.recorder.sent({ requestId: 'paired-2', status: 200, mode: 'fallthrough' });
    });
    await rm(path.join(bootDir(root), 'observations.json'), { force: true });

    const episodesRead = readEpisodes(discover(root));
    expect(episodesRead).toMatchObject({ ok: false, reason: 'unreadable' });
    if (!episodesRead.ok) expect(episodesRead.message).toContain('governing observations document');
  });

  it('RFC 0018: a MALFORMED observations.json (unparsable JSON) refuses episodes.ndjson too', async () => {
    const root = await mkRoot();
    await emitEpisodes(root, (d) => {
      d.recorder.requestStart({ requestId: 'paired-3', url: '/p', method: 'GET' });
      d.recorder.sent({ requestId: 'paired-3', status: 200, mode: 'fallthrough' });
    });
    await writeFile(path.join(bootDir(root), 'observations.json'), '{not json', 'utf8');

    const episodesRead = readEpisodes(discover(root));
    expect(episodesRead).toMatchObject({ ok: false, reason: 'unreadable' });
    if (!episodesRead.ok) expect(episodesRead.message).toContain('governing observations document');
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
      message: 'Structural tools remain available; runtime episodes require the dev server (pnpm dev).',
    });
  });
});
