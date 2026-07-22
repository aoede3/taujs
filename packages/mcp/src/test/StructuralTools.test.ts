// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, beforeAll } from 'vitest';

// Fixture via the real emitters (files are the contract) — mirrors the playground shape.
import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { createServiceData } from '../../../server/src/core/services/ServiceData';
import { defineService, defineServiceRegistry } from '../../../server/src/core/services/DataServices';

import { createTaujsMcpServer, allTools } from '../server';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { ToolResult } from '../toolkit';

const catalog = defineService({
  getProduct: {
    handler: async (p: { id: string }) => ({ product: { id: p.id } }),
    params: { parse: (u: unknown) => u as { id: string } },
  },
});
const content = defineService({ home: async (_p: {}) => ({ heading: 'hi' }) });
const registry = defineServiceRegistry({ catalog, content });
const serviceData = createServiceData<typeof registry>();

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'playground-react',
      entryPoint: '',
      routes: [
        { path: '/', attr: { render: 'ssr', data: serviceData('content', 'home') } },
        { path: '/product/:id', attr: { render: 'streaming', meta: {}, data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) } },
        { path: '/legacy', attr: { render: 'ssr', data: async () => ({ legacy: true }) } },
        { path: '/admin', attr: { render: 'ssr', middleware: { auth: {} } } },
      ],
    },
  ],
};

let root: string;
let toolByName: Map<string, (args: Record<string, unknown>) => ToolResult>;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-tools-'));
  const dir = path.join(root, 'node_modules', '.taujs');

  const graph = createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z', serviceRegistry: registry });
  await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(graph, null, 2));

  // Observed traffic: one getProduct call recorded through the real assembler.
  const dev = createDevIntrospection();
  dev.recorder.requestStart({ traceId: 'obs-1', url: '/product/7', method: 'GET' });
  dev.recorder.routeMatched({ traceId: 'obs-1', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
  dev.recorder.serviceCall({ traceId: 'obs-1', service: 'catalog', method: 'getProduct', ms: 4, ok: true });
  dev.recorder.sent({ traceId: 'obs-1', status: 200, mode: 'streaming' });
  await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(dev.getObservations(), null, 2));

  // No dev.json → stale mode: structural tools must work cold and cite staleness.
  toolByName = new Map(allTools(root).map((t) => [t.name, t.handler]));
});

const call = (name: string, args: Record<string, unknown> = {}): any => {
  const handler = toolByName.get(name);
  if (!handler) throw new Error(`unknown tool ${name}`);
  return handler(args);
};

describe('structural tools (cold/stale mode)', () => {
  it('taujs_overview summarises the graph and cites staleness', () => {
    const result = call('taujs_overview');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('stale');
    expect(result.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(result.routeCount).toBe(4);
    expect(result.fallthrough.reachable).toBe(true);
    expect(result.services).toEqual([
      { name: 'catalog', methods: ['getProduct'] },
      { name: 'content', methods: ['home'] },
    ]);
  });

  it('taujs_list_routes bounds output and filters by app', () => {
    const result = call('taujs_list_routes', { limit: 2 });

    expect(result.routes.items).toHaveLength(2);
    expect(result.routes.total).toBe(4);
    expect(result.routes.truncated).toBe(true);

    const none = call('taujs_list_routes', { appId: 'nope' });
    expect(none.routes.total).toBe(0);
  });

  it('taujs_get_route by id and by path; honest miss lists known ids', () => {
    const byId = call('taujs_get_route', { routeId: 'playground-react:/product/:id' });
    expect(byId.ok).toBe(true);
    expect(byId.routes[0].data).toEqual({ kind: 'service', service: 'catalog', method: 'getProduct' });

    const byPath = call('taujs_get_route', { path: '/legacy' });
    expect(byPath.routes[0].data.kind).toBe('dynamic');

    const miss = call('taujs_get_route', { path: '/nope' });
    expect(miss.ok).toBe(false);
    expect(miss.knownRouteIds.items).toContain('playground-react:/product/:id');
  });

  it('taujs_who_calls_service labels declared and observed edges per source', () => {
    const result = call('taujs_who_calls_service', { service: 'catalog', method: 'getProduct' });

    expect(result.ok).toBe(true);
    const sources = result.edges.map((e: { source: string }) => e.source);
    expect(sources).toContain('declared');
    expect(sources).toContain('observed');
    const observed = result.edges.find((e: { source: string }) => e.source === 'observed');
    expect(observed.count).toBe(1);
    expect(result.note).toContain('seen in dev traffic');

    const miss = call('taujs_who_calls_service', { service: 'ghost' });
    expect(miss.ok).toBe(false);
    expect(miss.knownServices.items).toEqual(['catalog', 'content']);
  });

  it('taujs_explain_route composes render, data edge with schema flags, and warnings', () => {
    const result = call('taujs_explain_route', { routeId: 'playground-react:/product/:id' });

    expect(result.ok).toBe(true);
    const explanation = result.explanations[0];
    expect(explanation.render.strategy).toBe('streaming');
    expect(explanation.data.schema).toMatchObject({ name: 'getProduct', params: { declared: true, kind: 'parse' } });
    expect(explanation.middleware.auth.declared).toBe(false);
  });
});

describe('MCP server end-to-end (InMemory transport)', () => {
  it('lists all taujs_-prefixed tools and answers a call over the protocol', async () => {
    const server = createTaujsMcpServer(root);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'taujs_doctor',
      'taujs_explain_route',
      'taujs_get_recent_traces',
      'taujs_get_route',
      'taujs_get_trace',
      'taujs_get_trace_logs',
      'taujs_list_routes',
      'taujs_overview',
      'taujs_who_calls_service',
    ]);
    expect(tools.tools.every((t) => t.description?.includes('untrusted application data'))).toBe(true);

    const result = await client.callTool({ name: 'taujs_overview', arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.routeCount).toBe(4);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      'taujs_skill_add_streamed_route',
      'taujs_skill_diagnose_broken_route',
      'taujs_skill_hydration_mismatch',
    ]);
    const skill = await client.getPrompt({ name: 'taujs_skill_diagnose_broken_route' });
    expect(JSON.stringify(skill.messages)).toContain('taujs_get_recent_traces');

    await client.close();
    await server.close();
  });
});
