// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

import { allTools, runTool } from '../server';

import type { ToolDefinition, ToolResult } from '../toolkit';
import type { DevJson } from '../types';

// One parent for every root this file creates, removed whole in afterAll.
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-evidence-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// These cells are about the difference between "nothing happened" and "I could not tell". The tools
// are an agent's evidence, so an answer that cannot distinguish the two is worse than no answer:
// it is a confident wrong one, and the agent has no way to see through it.

const EPISODE = {
  requestId: 'req-1',
  bootId: 'boot-1',
  at: '2026-08-26T10:00:00.000Z',
  route: '/product/:id',
  appId: 'web',
  mode: 'streaming',
  outcome: 'complete',
  status: 200,
  url: { pathname: '/product/42', queryKeys: [], queryValuesRedacted: true },
  timeline: {},
  serviceCalls: [],
  client: null,
  error: null,
};

const seed = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(scratch, 'evidence-'));
  const dir = path.join(root, 'node_modules', '.taujs');
  await mkdir(dir, { recursive: true });

  const devJson: DevJson = {
    bootId: 'boot-1',
    token: 'tok',
    pid: process.pid,
    startedAt: '2026-08-26T10:00:00.000Z',
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    episodes: path.join(dir, 'episodes.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
  };

  const defaults: Record<string, string> = {
    'dev.json': JSON.stringify(devJson),
    'graph.json': JSON.stringify({
      schemaVersion: 2,
      source: 'boot',
      emittedAt: '2026-08-26T09:00:00.000Z',
      routes: [],
      services: [],
      warnings: [],
      fallthrough: { reachable: true },
    }),
    'episodes.ndjson': '',
    'logs.ndjson': '',
    'observations.json': JSON.stringify({ schemaVersion: 1, bootId: 'boot-1', updatedAt: '2026-08-26T10:00:00.000Z', edges: [] }),
  };

  for (const [name, body] of Object.entries({ ...defaults, ...files })) await writeFile(path.join(dir, name), body, 'utf8');

  return root;
};

const toolsAt = (root: string) => new Map(allTools(root).map((t) => [t.name, t.handler]));
const call = (root: string, name: ToolDefinition['name'], args: Record<string, unknown> = {}): any => toolsAt(root).get(name)!(args as never) as ToolResult;

describe('episode-ring membership (@taujs/mcp)', () => {
  it('reports IN the ring for an episode that is there', async () => {
    const root = await seed({
      'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`,
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-1', bootId: 'boot-1', at: 'x', level: 'error', msg: 'boom' })}\n`,
    });

    expect(call(root, 'taujs_get_episode_logs', { requestId: 'req-1' })).toMatchObject({ ok: true, membership: 'in_episode_ring' });
  });

  it('refuses a requestId that is in NEITHER ring, instead of answering "no logs"', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n` });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'never-existed' });

    // The old answer was ok:true, logs:[], "try minLevel: info" - which sends an agent to retry a
    // query that can never succeed, for an id that was never recorded.
    expect(result).toMatchObject({ ok: false, reason: 'episode_not_found', membership: 'not_in_episode_ring' });
  });

  it('answers with the lines when the episode was EVICTED but its logs survive', async () => {
    // The logs ring outlives the episode ring by an order of magnitude on the server, so this is
    // ordinary rather than exotic: the episode is gone, the evidence is not.
    const root = await seed({
      'episodes.ndjson': '',
      'logs.ndjson': `${JSON.stringify({ requestId: 'evicted-1', bootId: 'boot-1', at: 'x', level: 'error', msg: 'still here' })}\n`,
    });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'evicted-1' });

    expect(result).toMatchObject({ ok: true, membership: 'not_in_episode_ring' });
    expect(result.logs).toHaveLength(1);
  });

  it('says UNKNOWN, not not-found, when a malformed record makes membership unprovable', async () => {
    const root = await seed({
      'episodes.ndjson': '{"requestId":"x","bootId":"boot-1"}\n',
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-9', bootId: 'boot-1', at: 'x', level: 'error', msg: 'hm' })}\n`,
    });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'req-9' });

    // One unreadable record means the ring cannot be spoken for. Saying "not found" here would be
    // asserting a fact the reader does not have.
    expect(result).toMatchObject({ ok: true, membership: 'unknown', malformedRecords: { episodes: 1 } });
  });

  it('distinguishes "nothing at this level" from "nothing at all"', async () => {
    const root = await seed({
      'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`,
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-1', bootId: 'boot-1', at: 'x', level: 'info', msg: 'quiet' })}\n`,
    });

    expect(call(root, 'taujs_get_episode_logs', { requestId: 'req-1' }).note).toContain('lower level');
  });
});

describe('malformed record accounting (@taujs/mcp)', () => {
  it('counts a torn line rather than presenting a filtered set as complete', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n{torn\n` });
    const result = call(root, 'taujs_get_recent_episodes');

    expect(result).toMatchObject({ ok: true, malformedRecords: { episodes: 1 } });
    expect((result.episodes as { items: unknown[] }).items).toHaveLength(1);
  });

  it('omits the count entirely when nothing was malformed', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n` });

    expect(call(root, 'taujs_get_recent_episodes')).not.toHaveProperty('malformedRecords');
  });

  it('counts an unrecognised log level instead of silently dropping it', async () => {
    const root = await seed({
      'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`,
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-1', bootId: 'boot-1', at: 'x', level: 'debug', msg: 'invisible' })}\n`,
    });

    // `LEVEL_ORDER['debug']` is undefined and `undefined >= min` is false, so this line used to
    // vanish with no trace at all.
    expect(call(root, 'taujs_get_episode_logs', { requestId: 'req-1', minLevel: 'info' })).toMatchObject({ malformedRecords: { logs: 1 } });
  });

  it('reports a directory at the episodes path as missing, not as an empty boot', async () => {
    const root = await seed({});
    const dir = path.join(root, 'node_modules', '.taujs');
    await writeFile(path.join(dir, 'episodes.ndjson'), '', 'utf8');
    await mkdir(path.join(dir, 'episodes-dir-marker'), { recursive: true });
    // Point dev.json's episodes at a DIRECTORY through the conventional name by replacing the file.
    // Containment now refuses anything that is not a real regular file (F3), so this is reported as
    // 'substrate_missing' - never opened - rather than 'substrate_unreadable' - opened and failed.
    const { rm } = await import('node:fs/promises');
    await rm(path.join(dir, 'episodes.ndjson'), { force: true });
    await mkdir(path.join(dir, 'episodes.ndjson'), { recursive: true });

    expect(call(root, 'taujs_get_recent_episodes')).toMatchObject({ ok: false, reason: 'substrate_missing', membership: 'unknown' });
  });
});

describe('doctor shape (@taujs/mcp)', () => {
  it('does not label an UNAVAILABLE section as observed', async () => {
    const root = await mkdtemp(path.join(scratch, 'doctor-cold-'));
    const dir = path.join(root, 'node_modules', '.taujs');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'graph.json'),
      JSON.stringify({
        schemaVersion: 2,
        source: 'boot',
        emittedAt: '2026-08-26T09:00:00.000Z',
        routes: [],
        services: [],
        warnings: [],
        fallthrough: { reachable: true },
      }),
      'utf8',
    );

    const result = call(root, 'taujs_doctor');
    const failed = result.failedEpisodes as { source: string; unavailable?: { staleReason?: string } };

    // It used to read: { source: 'observed (seen in dev traffic)', unavailable: { ... } } - an
    // object announcing itself as observed while carrying the reason it observed nothing.
    expect(failed.source).not.toContain('observed');
    expect(failed.unavailable?.staleReason).toBe('no_dev_json');
    expect(failed).not.toHaveProperty('items');
  });

  it('labels a populated section as observed, with no unavailable branch', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify({ ...EPISODE, outcome: 'failed', error: { kind: 'x', message: 'y' } })}\n` });
    const failed = call(root, 'taujs_doctor').failedEpisodes as { source: string; items: unknown[] };

    expect(failed.source).toContain('observed');
    expect(failed.items).toHaveLength(1);
    expect(failed).not.toHaveProperty('unavailable');
  });
});

describe('tool_failure envelope (@taujs/mcp)', () => {
  const throwingTool = (fail: () => never | Promise<never>): ToolDefinition => ({
    name: 'taujs_broken',
    title: 'Broken',
    description: 'Throws on purpose.',
    inputSchema: z.object({}),
    handler: fail as unknown as ToolDefinition['handler'],
  });

  const parse = (payload: { content: { text: string }[] }) => JSON.parse(payload.content[0]!.text);

  it('turns a synchronous throw into the same envelope every other failure uses', () => {
    const result = runTool(
      throwingTool(() => {
        throw new TypeError('t.url.pathname is undefined');
      }),
      {},
    ) as { content: { text: string }[]; isError?: boolean };

    // Before this, the SDK caught the throw into prose with no `reason`. Nothing leaked - but an
    // agent had a failure it could read and not act on.
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, reason: 'tool_failure', message: 't.url.pathname is undefined' });
  });

  it('turns a rejected promise into the same envelope', async () => {
    const result = await (runTool(throwingTool((() => Promise.reject(new Error('async boom'))) as () => Promise<never>), {}) as Promise<{
      content: { text: string }[];
      isError?: boolean;
    }>);

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, reason: 'tool_failure', message: 'async boom' });
  });

  it('bounds the returned message and keeps the full error off the wire', () => {
    const result = runTool(
      throwingTool(() => {
        throw new Error('x'.repeat(5_000));
      }),
      {},
    ) as { content: { text: string }[] };

    expect(parse(result).message).toHaveLength(500);
    expect(parse(result)).not.toHaveProperty('stack');
  });

  it('leaves a successful result untouched', () => {
    const ok: ToolDefinition = { name: 'taujs_fine', title: 'Fine', description: '', inputSchema: z.object({}), handler: () => ({ ok: true, value: 1 }) };

    expect(runTool(ok, {})).not.toHaveProperty('isError');
    expect(parse(runTool(ok, {}) as { content: { text: string }[] })).toMatchObject({ ok: true, value: 1 });
  });
});

describe('malformed records are counted at the depth the tools READ (@taujs/mcp)', () => {
  // The predicate originally stopped at the top level, so `serviceCalls: [null]` was "well formed",
  // reached both episode projections, and threw. With the envelope catching it the symptom got
  // QUIETER and worse: the whole batch answered tool_failure and every good record went with it.
  const withBadServiceCall = { ...EPISODE, requestId: 'bad-1', serviceCalls: [null] };

  it('counts a record whose nested serviceCalls element is not a service call', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n${JSON.stringify(withBadServiceCall)}\n` });
    const result = call(root, 'taujs_get_recent_episodes');

    expect(result).toMatchObject({ ok: true, malformedRecords: { episodes: 1 } });
    expect((result.episodes as { items: { requestId: string }[] }).items.map((i) => i.requestId)).toEqual(['req-1']);
  });

  it('keeps the doctor answering, rather than failing it on one bad nested element', async () => {
    const root = await seed({
      'episodes.ndjson': `${JSON.stringify({ ...EPISODE, outcome: 'failed', error: { kind: 'x', message: 'y' } })}\n${JSON.stringify({ ...withBadServiceCall, outcome: 'failed' })}\n`,
    });
    const failed = call(root, 'taujs_doctor').failedEpisodes as { items: unknown[]; malformedRecords?: Record<string, number> };

    // The doctor's projection is a near-duplicate of episodeSummary reading the SAME nested field,
    // so it needs its own cell: a fix validated only through get_recent_episodes would miss it.
    expect(failed.items).toHaveLength(1);
    expect(failed.malformedRecords).toEqual({ episodes: 1 });
  });

  it('does not fail the batch when the bad record is the only one', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(withBadServiceCall)}\n` });

    expect(call(root, 'taujs_get_recent_episodes')).toMatchObject({ ok: true, malformedRecords: { episodes: 1 } });
  });

  it('counts a record missing fields the tools read but the old top-level predicate never checked', async () => {
    // The old isEpisodeRecord only checked requestId, bootId, url.pathname and serviceCalls. This
    // record passes all four and is still missing at, mode, outcome, status, route, appId, client,
    // error - every one of which a projection dereferences.
    const shallow = { requestId: 'shallow-1', bootId: 'boot-1', url: { pathname: '/x' }, serviceCalls: [] };
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(shallow)}\n` });
    const result = call(root, 'taujs_get_recent_episodes');

    expect(result).toMatchObject({ ok: true, malformedRecords: { episodes: 1 } });
    expect((result.episodes as { items: unknown[] }).items).toHaveLength(0);
  });

  it('counts a log record missing at and msg, which the old predicate never checked', async () => {
    const root = await seed({
      'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`,
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-1', bootId: 'boot-1', level: 'error' })}\n`,
    });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'req-1' });

    expect(result).toMatchObject({ malformedRecords: { logs: 1 } });
  });

  it('tolerates an additive field on a full episode record, and returns it whole', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify({ ...EPISODE, futureField: 1 })}\n` });
    const result = call(root, 'taujs_get_episode', { requestId: 'req-1' });

    expect(result).toMatchObject({ ok: true, episode: { requestId: 'req-1' } });
    expect(result).not.toHaveProperty('malformedRecords');
  });

  it('accepts deferredData on a full episode record as well-formed', async () => {
    const withDeferred = { ...EPISODE, deferredData: [{ key: 'reviews', outcome: 'complete', ms: 12 }] };
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(withDeferred)}\n` });
    const result = call(root, 'taujs_get_recent_episodes');

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('malformedRecords');
  });
});

describe('one unprovable state, one verdict (@taujs/mcp)', () => {
  it('get_episode and get_episode_logs agree on ok when membership cannot be established', async () => {
    const root = await seed({ 'episodes.ndjson': '{"requestId":"x","bootId":"boot-1"}\n', 'logs.ndjson': '' });

    const episode = call(root, 'taujs_get_episode', { requestId: 'req-9' });
    const logs = call(root, 'taujs_get_episode_logs', { requestId: 'req-9' });

    // Same fact - "I cannot tell whether this episode existed" - so the same verdict. An agent that
    // gates on `ok` before reading `membership` used to get opposite answers from these two.
    expect(episode.ok).toBe(false);
    expect(logs.ok).toBe(false);
    expect(episode.membership).toBe('unknown');
    expect(logs.membership).toBe('unknown');
    expect(logs.reason).toBe('substrate_incomplete');
  });

  it('still answers ok:true when membership is unknown but there ARE lines to hand back', async () => {
    const root = await seed({
      'episodes.ndjson': '{"requestId":"x","bootId":"boot-1"}\n',
      'logs.ndjson': `${JSON.stringify({ requestId: 'req-9', bootId: 'boot-1', at: 'x', level: 'error', msg: 'evidence' })}\n`,
    });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'req-9' });

    // Unknown membership is not a refusal when there is evidence to return - it qualifies it.
    expect(result).toMatchObject({ ok: true, membership: 'unknown' });
    expect(result.logs).toHaveLength(1);
  });

  it('a malformed-only logs file gives an incomplete note, never the certain "at any level" one', async () => {
    // One malformed annex line for a KNOWN episode cannot establish "no annex lines at any level" -
    // it establishes only that one line could not be read.
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`, 'logs.ndjson': '{not json}\n' });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'req-1' });

    expect(result).toMatchObject({ ok: true, logs: [], malformedRecords: { logs: 1 } });
    expect(result.note).toContain('could not be read');
    expect(result.note).not.toContain('at any level');
  });

  it('a malformed-only logs file makes an absent episode incomplete, not not-found', async () => {
    const root = await seed({ 'episodes.ndjson': `${JSON.stringify(EPISODE)}\n`, 'logs.ndjson': '{not json}\n' });
    const result = call(root, 'taujs_get_episode_logs', { requestId: 'never-existed' });

    expect(result).toMatchObject({ ok: false, reason: 'substrate_incomplete' });
  });
});
