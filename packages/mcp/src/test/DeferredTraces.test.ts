// @vitest-environment node
// RFC 0007 (R5, product acceptance): ONE REAL MCP READ proving a deferred outcome is visible to the
// existing trace tool. No new MCP tool: the additive-optional `deferredData` field rides the
// existing trace record through the real assembler, the real artefact writer, the real substrate
// reader and the real `taujs_get_trace` handler.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';

import { allTools } from '../server';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { DevJson } from '../types';
import type { ToolResult } from '../toolkit';

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'playground-react',
      entryPoint: '',
      routes: [{ path: '/product/:id', attr: { render: 'streaming', meta: {}, deferred: { reviews: async () => ({ count: 3 }) } } as never }],
    },
  ],
};

let tools: Map<string, (args: Record<string, unknown>) => ToolResult>;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-deferred-'));
  const dir = path.join(root, 'node_modules', '.taujs');
  const dev = createDevIntrospection();

  // One streaming request whose declared deferred entries settle three different ways.
  dev.recorder.requestStart({ requestId: 'deferred-1', url: '/product/42', method: 'GET' });
  dev.recorder.routeMatched({ requestId: 'deferred-1', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
  dev.recorder.deferredData({ requestId: 'deferred-1', key: 'reviews', ms: 41.2, outcome: 'complete' });
  dev.recorder.deferredData({ requestId: 'deferred-1', key: 'blurb', ms: 5, outcome: 'failed' });
  dev.recorder.deferredData({ requestId: 'deferred-1', key: 'stock', ms: 120, outcome: 'aborted' });
  dev.recorder.sent({ requestId: 'deferred-1', status: 200, mode: 'streaming' });

  await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-28T11:00:00.000Z' })));
  await writeTaujsArtifact(
    dir,
    'traces.ndjson',
    dev
      .getTraces()
      .map((t) => JSON.stringify(t))
      .join('\n') + '\n',
  );

  const devJson: DevJson = {
    bootId: dev.bootId,
    token: 'tok',
    pid: process.pid,
    startedAt: '2026-07-28T11:00:00.000Z',
    host: '127.0.0.1',
    port: 5173,
    graph: path.join(dir, 'graph.json'),
    traces: path.join(dir, 'traces.ndjson'),
    logs: path.join(dir, 'logs.ndjson'),
    observations: path.join(dir, 'observations.json'),
  };
  await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson));

  tools = new Map(allTools(root).map((t) => [t.name, t.handler]));
});

describe('MCP surfaces RFC 0007 deferred outcomes with no new tool', () => {
  it('taujs_get_trace: every declared key and its outcome is readable, detail-free', () => {
    const result = tools.get('taujs_get_trace')!({ requestId: 'deferred-1' }) as any;

    expect(result.ok).toBe(true);
    expect((result.trace as { deferredData?: unknown }).deferredData).toEqual([
      { key: 'reviews', outcome: 'complete', ms: 41.2 },
      { key: 'blurb', outcome: 'failed', ms: 5 },
      { key: 'stock', outcome: 'aborted', ms: 120 },
    ]);
  });

  it('taujs_get_route: the declared deferred edge rides the existing route row as-is', () => {
    const result = tools.get('taujs_get_route')!({ path: '/product/:id' }) as any;

    expect(result.ok).toBe(true);
    expect(result.routes[0].deferred).toEqual([{ key: 'reviews', data: { kind: 'dynamic' } }]);
  });
});
