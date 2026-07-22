// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';

import { NO_ACTIVE_BOOT_REFUSAL } from '../SubstrateReader';
import { allTools } from '../server';

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

  dev.recorder.requestStart({ traceId: 'ok-1', url: '/product/123', method: 'GET' });
  dev.recorder.routeMatched({ traceId: 'ok-1', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
  dev.recorder.serviceCall({ traceId: 'ok-1', service: 'catalog', method: 'getProduct', ms: 8, ok: true });
  dev.recorder.sent({ traceId: 'ok-1', status: 200, mode: 'streaming' });

  dev.recorder.requestStart({ traceId: 'boom-999', url: '/product/999?ref=demo', method: 'GET' });
  dev.recorder.routeMatched({ traceId: 'boom-999', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
  dev.recorder.serviceCall({ traceId: 'boom-999', service: 'catalog', method: 'getProduct', ms: 3, ok: false });
  dev.recorder.failed({ traceId: 'boom-999', error: { kind: 'domain', message: 'Product 999 does not exist' } });

  dev.recorder.requestStart({ traceId: 'spa-1', url: '/spa/x', method: 'GET' });
  dev.recorder.sent({ traceId: 'spa-1', status: 200, mode: 'fallthrough' });

  const base: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, isDebugEnabled: () => false };
  base.child = () => base;
  const logger = dev.wrapRequestLogger(base as unknown as Logs, 'boom-999');
  logger.warn({ component: 'fetch-initial-data' }, 'Service method failed');
  logger.error({ kind: 'domain' }, 'Product 999 does not exist');

  const foreign = { ...dev.getTraces()[0]!, traceId: 'foreign-1', bootId: 'other-boot' };

  await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T11:00:00.000Z' })));
  await writeTaujsArtifact(dir, 'traces.ndjson', [...dev.getTraces(), foreign].map((t) => JSON.stringify(t)).join('\n') + '\n');
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
    traces: path.join(dir, 'traces.ndjson'),
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

beforeAll(async () => {
  liveRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-live-'));
  coldRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-cold-'));
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

const live = (name: string, args: Record<string, unknown> = {}): any => liveTools.get(name)!(args);
const cold = (name: string, args: Record<string, unknown> = {}): any => coldTools.get(name)!(args);

describe('cold-mode refusal contract (every runtime tool)', () => {
  it.each(['taujs_get_recent_traces', 'taujs_get_trace', 'taujs_get_trace_logs'])('%s refuses verbatim without an active boot', (name) => {
    const result = cold(name, { traceId: 'anything' });

    expect(result).toEqual(NO_ACTIVE_BOOT_REFUSAL);
  });

  it('taujs_doctor still answers structurally in cold mode, marking runtime facts unavailable', () => {
    const result = cold('taujs_doctor');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('stale');
    expect(result.staleness).toContain('2026-07-10T08:00:00.000Z');
    expect(result.failedTraces.unavailable.note).toBe(NO_ACTIVE_BOOT_REFUSAL.message);
  });
});

describe('runtime tools (active boot)', () => {
  it('taujs_get_recent_traces: newest first, bootId-filtered, small default, outcome filter', () => {
    const all = live('taujs_get_recent_traces');

    expect(all.ok).toBe(true);
    expect(all.bootId).toBe(bootId);
    expect(all.traces.items.map((t: { traceId: string }) => t.traceId)).toEqual(['spa-1', 'boom-999', 'ok-1']);
    expect(all.traces.items.some((t: { traceId: string }) => t.traceId === 'foreign-1')).toBe(false);

    const failed = live('taujs_get_recent_traces', { outcome: 'failed' });
    expect(failed.traces.items).toHaveLength(1);
    expect(failed.traces.items[0].serviceCalls).toEqual(['catalog.getProduct FAILED 3ms']);
  });

  it('taujs_get_trace returns the full record; unknown ids explain the ring', () => {
    const hit = live('taujs_get_trace', { traceId: 'boom-999' });

    expect(hit.ok).toBe(true);
    expect(hit.trace.outcome).toBe('failed');
    expect(hit.trace.error).toEqual({ kind: 'domain', message: 'Product 999 does not exist' });
    expect(hit.trace.url).toEqual({ pathname: '/product/999', queryKeys: ['ref'], queryValuesRedacted: true });

    const miss = live('taujs_get_trace', { traceId: 'gone-1' });
    expect(miss.ok).toBe(false);
    expect(miss.message).toContain('ring buffer');
  });

  it('taujs_get_trace_logs defaults to warn+ and widens on request', () => {
    const warnPlus = live('taujs_get_trace_logs', { traceId: 'boom-999' });

    expect(warnPlus.ok).toBe(true);
    expect(warnPlus.logs.map((l: { level: string }) => l.level)).toEqual(['warn', 'error']);

    const other = live('taujs_get_trace_logs', { traceId: 'ok-1' });
    expect(other.logs).toEqual([]);
    expect(other.note).toContain('framework request logger');
  });

  it('taujs_doctor surfaces the deterministic failure, warnings, and defaulted renders — source-labelled', () => {
    const result = live('taujs_doctor');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('active');
    expect(result.defaultedRenders.routeIds).toEqual(['playground-react:/defaulted']);
    expect(result.warnings.warn.some((w: { code: string }) => w.code === 'render.defaulted')).toBe(true);
    expect(result.failedTraces.items).toHaveLength(1);
    expect(result.failedTraces.items[0].error.message).toContain('999');
    expect(result.failedTraces.source).toContain('observed');
  });
});
