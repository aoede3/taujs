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
// content.about has NO edge anywhere (the known-but-edgeless case); pricing is reached ONLY
// through a deferred entry (RFC 0007 R5 — must count as declared coverage).
const content = defineService({ home: async (_p: {}) => ({ heading: 'hi' }), about: async (_p: {}) => ({ page: 'about' }) });
const pricing = defineService({ getQuote: async (_p: {}) => ({ quote: 1 }) });
const registry = defineServiceRegistry({ catalog, content, pricing });
const serviceData = createServiceData<typeof registry>();

// Routes and registry are emitted independently, so declared edges can DANGLE: a WIDER
// registry types two extra edges (phantom.boo; content.gone) that the registry actually
// handed to the graph does not have. `ok` must answer "did the identifier resolve".
const contentWide = defineService({
  home: async (_p: {}) => ({ heading: 'hi' }),
  about: async (_p: {}) => ({ page: 'about' }),
  gone: async (_p: {}) => ({ gone: true }),
});
const phantom = defineService({ boo: async (_p: {}) => ({ boo: 1 }) });
const wideRegistry = defineServiceRegistry({ catalog, content: contentWide, pricing, phantom });
const serviceDataWide = createServiceData<typeof wideRegistry>();

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'playground-react',
      entryPoint: '',
      routes: [
        { path: '/', attr: { render: 'ssr', data: serviceData('content', 'home') } },
        { path: '/product/:id', attr: { render: 'streaming', meta: {}, data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) } },
        { path: '/quote', attr: { render: 'streaming', meta: {}, deferred: { quote: serviceData('pricing', 'getQuote') } } },
        { path: '/ghosted', attr: { render: 'ssr', data: serviceDataWide('phantom', 'boo') } },
        { path: '/gone', attr: { render: 'ssr', data: serviceDataWide('content', 'gone') } },
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
  dev.recorder.requestStart({ requestId: 'obs-1', url: '/product/7', method: 'GET' });
  dev.recorder.routeMatched({ requestId: 'obs-1', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
  dev.recorder.serviceCall({ requestId: 'obs-1', service: 'catalog', method: 'getProduct', ms: 4, ok: true });
  dev.recorder.sent({ requestId: 'obs-1', status: 200, mode: 'streaming' });
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
  it('taujs_overview summarises the graph, states its boundary and declared coverage, and cites staleness', () => {
    const result = call('taujs_overview');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('stale');
    expect(result.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(result.routeCount).toBe(7);
    expect(result.fallthrough.reachable).toBe(true);
    // The boundary, stated at the point of use: the graph covers what taujs owns, and absence
    // from it never means absence from the application.
    expect(result.scope).toContain('Routes registered directly on the Fastify instance');
    expect(result.scope).toContain('never means absence from the application');
    // Coverage: pricing counts as covered through its deferred-only edge (usedBy parity).
    expect(result.services).toEqual([
      { name: 'catalog', methodCount: 1, withDeclaredEdges: 1, methods: ['getProduct'] },
      { name: 'content', methodCount: 2, withDeclaredEdges: 1, methods: ['about', 'home'] },
      { name: 'pricing', methodCount: 1, withDeclaredEdges: 1, methods: ['getQuote'] },
    ]);
    // Episode-tool liveness is explicit, with the refusal remedy, instead of implied by mode.
    expect(result.episodesAvailable).toBe(false);
    expect(result.episodesNote).toContain('pnpm dev');
    // Warning counts are graph-scoped by name; the unlabelled key is gone. The one warn is the
    // fixture's unconfigured security.csp (csp.dev_directives).
    expect(result.graphWarningCounts).toEqual({ warn: 1 });
    expect(result.warningCounts).toBeUndefined();
  });

  it('taujs_list_routes bounds output and filters by app', () => {
    const result = call('taujs_list_routes', { limit: 2 });

    expect(result.routes.items).toHaveLength(2);
    expect(result.routes.total).toBe(7);
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
    const declared = result.edges.find((e: { source: string }) => e.source === 'declared');
    expect(declared.declaredVia).toBe('serviceData');
    const observed = result.edges.find((e: { source: string }) => e.source === 'observed');
    expect(observed.methodCallCount).toBe(1);
    expect(observed.count).toBeUndefined();
    expect(result.note).toContain('seen in dev traffic');
  });

  it('taujs_who_calls_service reaches deferred-only edges, matching the graph usedBy derivation', () => {
    const result = call('taujs_who_calls_service', { service: 'pricing', method: 'getQuote' });

    expect(result.ok).toBe(true);
    expect(result.edges).toEqual([
      {
        source: 'declared',
        service: 'pricing',
        method: 'getQuote',
        declaredVia: 'deferred',
        routeId: 'playground-react:/quote',
        appId: 'playground-react',
        path: '/quote',
      },
    ]);
  });

  it('taujs_who_calls_service distinguishes unknown identifiers from a known service with zero edges', () => {
    const ghost = call('taujs_who_calls_service', { service: 'ghost' });
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toBe('unknown_service');
    expect(ghost.knownServices.items).toEqual(['catalog', 'content', 'pricing']);
    expect(ghost.danglingEdges).toBeUndefined();

    const badMethod = call('taujs_who_calls_service', { service: 'content', method: 'nope' });
    expect(badMethod.ok).toBe(false);
    expect(badMethod.reason).toBe('unknown_method');
    expect(badMethod.knownMethods.items).toEqual(['about', 'home']);

    // A known method with zero edges is a successful empty query, not an error — agents branch
    // hard on `ok`, and this is "the answer is none", not "I asked wrong".
    const edgeless = call('taujs_who_calls_service', { service: 'content', method: 'about' });
    expect(edgeless.ok).toBe(true);
    expect(edgeless.edges).toEqual([]);
    expect(edgeless.note).toContain('Observed edges only exist for traffic seen this boot');
  });

  it('taujs_who_calls_service returns dangling edges on unresolved identifiers instead of hiding them', () => {
    // Routes and registry are emitted independently: /ghosted declares phantom.boo but the
    // registry has no phantom. `ok: false` (identifier does not resolve) AND the real config
    // that references it — hiding either half would mislead.
    const phantom = call('taujs_who_calls_service', { service: 'phantom' });
    expect(phantom.ok).toBe(false);
    expect(phantom.reason).toBe('unknown_service');
    expect(phantom.knownServices.items).toEqual(['catalog', 'content', 'pricing']);
    expect(phantom.danglingEdges).toEqual([
      {
        source: 'declared',
        service: 'phantom',
        method: 'boo',
        declaredVia: 'serviceData',
        routeId: 'playground-react:/ghosted',
        appId: 'playground-react',
        path: '/ghosted',
      },
    ]);
    expect(phantom.danglingNote).toContain('disagree');

    // Same for a method the registry's service does not have.
    const gone = call('taujs_who_calls_service', { service: 'content', method: 'gone' });
    expect(gone.ok).toBe(false);
    expect(gone.reason).toBe('unknown_method');
    expect(gone.knownMethods.items).toEqual(['about', 'home']);
    expect(gone.danglingEdges).toHaveLength(1);
    expect(gone.danglingEdges[0]).toMatchObject({ source: 'declared', routeId: 'playground-react:/gone', method: 'gone' });
  });

  it('taujs_doctor states a clean verdict as graph-scoped, never as application health', async () => {
    // A genuinely warning-free graph needs explicit security.csp (else csp.dev_directives warns).
    const cleanConfig: CoreTaujsConfig = {
      apps: [{ appId: 'clean-app', entryPoint: '', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
      security: { csp: { directives: { defaultSrc: ["'self'"] } } },
    };
    const cleanRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-clean-'));
    const graph = createRequestGraph(cleanConfig, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z' });
    expect(graph.warnings).toEqual([]);
    await writeTaujsArtifact(path.join(cleanRoot, 'node_modules', '.taujs'), 'graph.json', JSON.stringify(graph));

    const result = new Map(allTools(cleanRoot).map((t) => [t.name, t.handler])).get('taujs_doctor')!({}) as any;

    expect(result.ok).toBe(true);
    expect(result.warnings.note).toContain('No taujs graph warnings');
    expect(result.warnings.note).toContain('not application health');

    // And the control: the main fixture's graph HAS a warning, so no clean note there.
    const warned = call('taujs_doctor');
    expect(warned.warnings.note).toBeUndefined();
    expect(warned.warnings.warn).toHaveLength(1);
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
      'taujs_get_episode',
      'taujs_get_episode_logs',
      'taujs_get_recent_episodes',
      'taujs_get_route',
      'taujs_list_routes',
      'taujs_overview',
      'taujs_who_calls_service',
    ]);
    expect(tools.tools.every((t) => t.description?.includes('untrusted application data'))).toBe(true);

    const result = await client.callTool({ name: 'taujs_overview', arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.routeCount).toBe(7);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      'taujs_skill_add_streamed_route',
      'taujs_skill_diagnose_broken_route',
      'taujs_skill_hydration_mismatch',
    ]);
    const skill = await client.getPrompt({ name: 'taujs_skill_diagnose_broken_route' });
    expect(JSON.stringify(skill.messages)).toContain('taujs_get_recent_episodes');

    await client.close();
    await server.close();
  });
});
