import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allTools } from '../server';
import { discoverSubstrate, readEpisodes, readGraph, readLogs } from '../SubstrateReader';

import type { ChildProcess } from 'node:child_process';
import type { DevJson, EpisodeRecord } from '../types';

// A full, schema-valid episode record - used where a cell needs SOME record in the ring
// without exercising the malformed-record machinery (that is EvidenceIntegrity.test.ts's job).
const fullEpisode = (overrides: Partial<EpisodeRecord> = {}): EpisodeRecord => ({
  requestId: 'req',
  bootId: 'boot',
  at: '2026-08-20T00:00:00.000Z',
  route: null,
  appId: null,
  mode: null,
  outcome: 'complete',
  status: 200,
  url: { pathname: '/x', queryKeys: [], queryValuesRedacted: true },
  timeline: {},
  serviceCalls: [],
  client: null,
  error: null,
  ...overrides,
});

// A boot is "active" only if it is PROVING it is alive. A live pid does not prove that: pids are
// recycled, and a crashed boot leaves its dev.json behind because the server removes it only on
// graceful close. These cells are written against real processes and real files rather than a
// mocked `isPidAlive`, because the defect is precisely that the pid tells the truth about a process
// and nothing about the boot.

const devDirFor = (root: string) => path.join(root, 'node_modules', '.taujs');

const seedDevJson = async (root: string, overrides: Partial<DevJson> = {}): Promise<string> => {
  const dir = devDirFor(root);
  await mkdir(dir, { recursive: true });

  const devJson: DevJson = {
    bootId: 'boot-current',
    token: 'tok',
    pid: process.pid,
    startedAt: '2026-08-26T10:00:00.000Z',
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    episodes: path.join(dir, 'episodes.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
    ...overrides,
  };

  const devJsonPath = path.join(dir, 'dev.json');
  await writeFile(devJsonPath, JSON.stringify(devJson), 'utf8');
  // Every artefact the reader may consult must exist, so a cell fails on liveness or containment
  // and never merely on a missing file.
  await writeFile(path.join(dir, 'graph.json'), '{}', 'utf8');
  await writeFile(path.join(dir, 'episodes.ndjson'), '', 'utf8');
  await writeFile(path.join(dir, 'logs.ndjson'), '', 'utf8');
  await writeFile(path.join(dir, 'observations.json'), '{}', 'utf8');

  return devJsonPath;
};

const ageDevJson = async (devJsonPath: string, ms: number): Promise<void> => {
  const when = new Date(Date.now() - ms);
  await utimes(devJsonPath, when, when);
};

// One parent for every root this file creates, removed whole in afterAll (after the kills).
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-liveness-'));
});

const spawned: ChildProcess[] = [];

// A REAL second process, not a fabricated pid. This is what a recycled pid looks like from the
// reader's side: a pid that is genuinely alive and genuinely is not this boot.
const spawnIdleProcess = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  spawned.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  return child.pid!;
};

afterAll(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
});

describe('boot liveness (@taujs/mcp)', () => {
  it('is active while dev.json is fresh and its pid is alive', async () => {
    const root = await mkdtemp(path.join(scratch, 'live-'));
    await seedDevJson(root);

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'active' });
  });

  it('is stale with reason dead_pid once the recorded process is gone', async () => {
    const root = await mkdtemp(path.join(scratch, 'dead-'));
    const pid = await spawnIdleProcess();
    const devJsonPath = await seedDevJson(root, { pid });

    process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Fresh heartbeat, dead process: liveness must not rest on the file's age alone either.
    await utimes(devJsonPath, new Date(), new Date());

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'stale', reason: 'dead_pid' });
  });

  it('is stale with reason heartbeat_expired when a LIVE pid is not this boot - the recycled-pid case', async () => {
    const root = await mkdtemp(path.join(scratch, 'recycled-'));
    // The whole defect in one arrangement: the pid in dev.json belongs to a real, running process
    // that is not the dev server. Pid liveness alone answers `active` here and serves a dead boot's
    // records as current; only the absent heartbeat can tell the difference.
    const pid = await spawnIdleProcess();
    const devJsonPath = await seedDevJson(root, { pid });
    await ageDevJson(devJsonPath, 60_000);

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'stale', reason: 'heartbeat_expired' });
  });

  it('is stale with reason no_dev_json when nothing recorded a boot', async () => {
    const root = await mkdtemp(path.join(scratch, 'nodev-'));
    const dir = devDirFor(root);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'graph.json'), '{}', 'utf8');

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'stale', reason: 'no_dev_json' });
  });
});

describe('dev.json validation (@taujs/mcp)', () => {
  it('an invalid dev.json ({ pid }) reads as stale, and never lets an old boot answer as current', async () => {
    const root = await mkdtemp(path.join(scratch, 'invalid-devjson-'));
    const dir = devDirFor(root);
    await mkdir(dir, { recursive: true });
    // A live pid and nothing else: this passed liveness under a cast and, with bootId undefined,
    // readEpisodes's bootId filter used to be SKIPPED entirely - an old boot's episode then read
    // as current evidence.
    await writeFile(path.join(dir, 'dev.json'), JSON.stringify({ pid: process.pid }), 'utf8');
    await writeFile(path.join(dir, 'episodes.ndjson'), `${JSON.stringify(fullEpisode({ requestId: 'old-req', bootId: 'old-boot' }))}\n`, 'utf8');
    await writeFile(path.join(dir, 'graph.json'), '{}', 'utf8');

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_get_recent_episodes')!({}) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, staleReason: 'dev_json_invalid' });
    // The old boot's episode must never surface as this call's evidence.
    expect(JSON.stringify(result)).not.toContain('old-req');
  });

  it('a dev.json that is not JSON reads as stale, with no devJson carried on the result', async () => {
    const root = await mkdtemp(path.join(scratch, 'notjson-'));
    const dir = devDirFor(root);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'dev.json'), 'not json', 'utf8');
    await writeFile(path.join(dir, 'graph.json'), '{}', 'utf8');

    const discovery = discoverSubstrate(root);

    expect(discovery).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });
    expect((discovery as { devJson?: unknown }).devJson).toBeUndefined();
  });

  it('tolerates an additive unknown field in an otherwise-valid dev.json', async () => {
    const root = await mkdtemp(path.join(scratch, 'additive-devjson-'));
    const devJsonPath = await seedDevJson(root);
    const devJson = JSON.parse(await readFile(devJsonPath, 'utf8')) as Record<string, unknown>;
    devJson.futureField = 'from a later @taujs/server';
    await writeFile(devJsonPath, JSON.stringify(devJson), 'utf8');

    expect(discoverSubstrate(root)).toMatchObject({ mode: 'active' });
  });

  it('an EMPTY bootId is invalid, and never bypasses the boot filter', async () => {
    const root = await mkdtemp(path.join(scratch, 'empty-bootid-'));
    const devJsonPath = await seedDevJson(root, { bootId: '' });
    await writeFile(path.join(devDirFor(root), 'episodes.ndjson'), `${JSON.stringify(fullEpisode({ requestId: 'old-req', bootId: 'old-boot' }))}\n`, 'utf8');

    // Schema-valid in every other field and freshly written: only the empty bootId makes it invalid.
    const discovery = discoverSubstrate(root);
    expect(discovery).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const result = tools.get('taujs_get_recent_episodes')!({}) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, staleReason: 'dev_json_invalid' });
    expect(JSON.stringify(result)).not.toContain('old-req');

    // The filter itself keys on presence, not truthiness: an empty bootId matches nothing.
    await writeFile(devJsonPath, JSON.stringify({ ...JSON.parse(await readFile(devJsonPath, 'utf8')), bootId: 'boot-current' }), 'utf8');
    const live = discoverSubstrate(root);
    expect(readEpisodes(live, { bootId: '' })).toMatchObject({ ok: true, records: [] });
    expect(readLogs(live, { requestId: 'old-req', bootId: '' })).toMatchObject({ ok: true, anyLevelCount: 0 });
  });

  it('an invalid dev.json ALONE - no other artefact - still reads stale with its reason, not none', async () => {
    for (const body of [JSON.stringify({ pid: process.pid }), 'not json']) {
      const root = await mkdtemp(path.join(scratch, 'invalid-alone-'));
      const dir = devDirFor(root);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'dev.json'), body, 'utf8');

      expect(discoverSubstrate(root)).toMatchObject({ mode: 'stale', reason: 'dev_json_invalid' });

      const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
      expect(tools.get('taujs_get_recent_episodes')!({})).toMatchObject({ ok: false, staleReason: 'dev_json_invalid' });
    }
  });
});

describe('dev.json path containment (@taujs/mcp)', () => {
  it('ignores a declared path outside the .taujs directory', async () => {
    const root = await mkdtemp(path.join(scratch, 'escape-'));
    const outside = path.join(root, 'elsewhere.ndjson');
    await writeFile(outside, `${JSON.stringify({ requestId: 'r1', bootId: 'boot-current', at: 'x', level: 'error', msg: 'FROM OUTSIDE' })}\n`, 'utf8');
    await seedDevJson(root, { logs: outside });

    const discovery = discoverSubstrate(root);

    expect(discovery.mode).toBe('active');
    // The derived path (empty) is used; the declared outside file is never opened.
    expect(discovery.mode === 'active' ? discovery.paths.logs : undefined).toBe(path.join(devDirFor(root), 'logs.ndjson'));
    expect(readLogs(discovery, { requestId: 'r1', minLevel: 'info' })).toMatchObject({ ok: true, records: [] });
  });

  it('ignores a SYMLINK inside .taujs that points outside it', async () => {
    const root = await mkdtemp(path.join(scratch, 'symlink-'));
    const outside = path.join(root, 'elsewhere.ndjson');
    await writeFile(outside, `${JSON.stringify({ requestId: 'r1', bootId: 'boot-current', at: 'x', level: 'error', msg: 'FROM OUTSIDE' })}\n`, 'utf8');

    const dir = devDirFor(root);
    await mkdir(dir, { recursive: true });
    const link = path.join(dir, 'logs-link.ndjson');
    await symlink(outside, link);
    await seedDevJson(root, { logs: link });

    // The case a lexical prefix check passes: the declared path IS inside .taujs, and still escapes.
    const discovery = discoverSubstrate(root);

    expect(discovery.mode).toBe('active');
    expect(discovery.mode === 'active' ? discovery.paths.logs : undefined).toBe(path.join(dir, 'logs.ndjson'));
    expect(readLogs(discovery, { requestId: 'r1', minLevel: 'info' })).toMatchObject({ ok: true, records: [] });
  });

  it('accepts the emitter’s own declared paths', async () => {
    const root = await mkdtemp(path.join(scratch, 'ok-'));
    await seedDevJson(root);
    const discovery = discoverSubstrate(root);

    expect(discovery.mode === 'active' ? discovery.paths.episodes : undefined).toBe(path.join(devDirFor(root), 'episodes.ndjson'));
  });

  it('refuses the conventional logs.ndjson when it is itself a symlink out', async () => {
    const root = await mkdtemp(path.join(scratch, 'logs-conventional-symlink-'));
    const outside = path.join(root, 'elsewhere.ndjson');
    await writeFile(outside, `${JSON.stringify({ requestId: 'r1', bootId: 'boot-current', at: 'x', level: 'error', msg: 'FROM OUTSIDE' })}\n`, 'utf8');

    await seedDevJson(root);
    const dir = devDirFor(root);
    const conventionalLogs = path.join(dir, 'logs.ndjson');
    await rm(conventionalLogs, { force: true });
    await symlink(outside, conventionalLogs);

    const discovery = discoverSubstrate(root);
    expect(discovery.mode).toBe('active');
    expect(discovery.mode === 'active' ? discovery.paths.logs : 'defined').toBeUndefined();

    const readResult = readLogs(discovery, { requestId: 'r1', minLevel: 'info' });
    expect(readResult).toMatchObject({ ok: false, reason: 'not_found' });
    expect(JSON.stringify(readResult)).not.toContain('FROM OUTSIDE');

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const toolResult = tools.get('taujs_get_episode_logs')!({ requestId: 'r1' }) as Record<string, unknown>;
    expect(toolResult).toMatchObject({ ok: false, reason: 'substrate_missing' });
  });

  it('refuses the conventional episodes.ndjson when it is itself a symlink out', async () => {
    const root = await mkdtemp(path.join(scratch, 'episodes-conventional-symlink-'));
    const outside = path.join(root, 'elsewhere-episodes.ndjson');
    await writeFile(outside, `${JSON.stringify(fullEpisode({ requestId: 'from-outside', bootId: 'boot-current' }))}\n`, 'utf8');

    await seedDevJson(root);
    const dir = devDirFor(root);
    const conventionalEpisodes = path.join(dir, 'episodes.ndjson');
    await rm(conventionalEpisodes, { force: true });
    await symlink(outside, conventionalEpisodes);

    const discovery = discoverSubstrate(root);
    expect(discovery.mode).toBe('active');
    expect(discovery.mode === 'active' ? discovery.paths.episodes : 'defined').toBeUndefined();

    const tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
    const toolResult = tools.get('taujs_get_recent_episodes')!({}) as Record<string, unknown>;
    expect(toolResult).toMatchObject({ ok: false, reason: 'substrate_missing' });
    expect(JSON.stringify(toolResult)).not.toContain('from-outside');
  });

  it('stale mode: a symlinked conventional graph.json is refused, not read through', async () => {
    const root = await mkdtemp(path.join(scratch, 'graph-conventional-symlink-'));
    const outside = path.join(root, 'elsewhere-graph.json');
    await writeFile(
      outside,
      JSON.stringify({
        schemaVersion: 1,
        source: 'boot',
        emittedAt: 'x',
        routes: [],
        services: [],
        warnings: [],
        fallthrough: { reachable: true },
        secret: 'FROM OUTSIDE',
      }),
      'utf8',
    );

    const dir = devDirFor(root);
    await mkdir(dir, { recursive: true });
    await symlink(outside, path.join(dir, 'graph.json'));
    // Some other artefact must be real, or discovery degrades all the way to 'none' rather than
    // 'stale' - this cell is about containment on a path within a stale discovery, not emptiness.
    await writeFile(path.join(dir, 'episodes.ndjson'), '', 'utf8');

    const discovery = discoverSubstrate(root);
    expect(discovery.mode).toBe('stale');
    expect(discovery.mode === 'stale' ? discovery.paths.graph : 'defined').toBeUndefined();

    const result = readGraph(discovery);
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect(JSON.stringify(result)).not.toContain('FROM OUTSIDE');
  });
});

describe('readLogs bootId filter (@taujs/mcp)', () => {
  it('excludes a previous boot’s lines for the same requestId', async () => {
    const root = await mkdtemp(path.join(scratch, 'logs-boot-'));
    await seedDevJson(root);

    const lines = [
      { requestId: 'r1', bootId: 'boot-previous', at: 'a', level: 'error', msg: 'OLD BOOT' },
      { requestId: 'r1', bootId: 'boot-current', at: 'b', level: 'error', msg: 'THIS BOOT' },
    ];
    await writeFile(path.join(devDirFor(root), 'logs.ndjson'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    const discovery = discoverSubstrate(root);
    const withFilter = readLogs(discovery, { requestId: 'r1', bootId: 'boot-current' });

    expect(withFilter.ok && withFilter.records.map((l) => l.msg)).toEqual(['THIS BOOT']);
    // Without the filter both lines answer - which is what the tool used to do.
    expect(readLogs(discovery, { requestId: 'r1' })).toMatchObject({ ok: true, anyLevelCount: 2 });
  });
});
