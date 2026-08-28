// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Fixture via the real emitters (files are the contract) — mirrors the playground shape.
import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { createServiceData } from '../../../server/src/core/services/ServiceData';
import { defineService, defineServiceRegistry } from '../../../server/src/core/services/DataServices';

import { createTaujsMcpServer, allTools } from '../server';
// Spied (not stubbed): the real implementation still runs - this only lets a cell assert whether
// it ran, which is the difference between "the SDK rejected before dispatch" and "our handler ran
// and reported an error itself".
import { withGraph } from '../toolkit';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { ObservationsDocument } from '../../../server/src/core/introspection/DevIntrospection';
import type { DevJson } from '../types';
import type { ToolResult } from '../toolkit';

vi.mock('../toolkit', { spy: true });

const catalog = defineService({
  getProduct: {
    handler: async (p: { id: string }) => ({ product: { id: p.id } }),
    params: { parse: (u: unknown) => u as { id: string } },
  },
});
// content.about has NO edge anywhere (the known-but-edgeless case); pricing is reached ONLY
// through a deferred entry (RFC 0007 R5 — must count as declared coverage). content.header is
// reached ONLY through a head entry (head edge, mirrors data — decisions.md 2026-08-27).
const content = defineService({
  home: async (_p: {}) => ({ heading: 'hi' }),
  about: async (_p: {}) => ({ page: 'about' }),
  header: async (_p: {}) => ({ title: 'hi' }),
});
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
        {
          path: '/product/:id',
          attr: {
            render: 'streaming',
            meta: {},
            data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })),
            // Same method via data AND head, on one route: dedupe must yield one row (ruling 3).
            head: { data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) },
          },
        },
        { path: '/quote', attr: { render: 'streaming', meta: {}, deferred: { quote: serviceData('pricing', 'getQuote') } } },
        // ONLY declaration is attr.head.data — nothing else uses content.header.
        { path: '/head-only', attr: { render: 'ssr', head: { data: serviceData('content', 'header') } } },
        { path: '/ghosted', attr: { render: 'ssr', data: serviceDataWide('phantom', 'boo') } },
        { path: '/gone', attr: { render: 'ssr', data: serviceDataWide('content', 'gone') } },
        { path: '/legacy', attr: { render: 'ssr', data: async () => ({ legacy: true }) } },
        { path: '/admin', attr: { render: 'ssr', middleware: { auth: {} } } },
      ],
    },
  ],
};

let root: string;
let toolByName: Map<string, (args: any) => ToolResult>;
let observationsDoc: ObservationsDocument;

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
  observationsDoc = dev.getObservations();
  await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(observationsDoc, null, 2));

  // No dev.json → stale mode: structural tools must work cold and cite staleness.
  toolByName = new Map(allTools(root).map((t) => [t.name, t.handler]));
});

const call = (name: string, args: Record<string, unknown> = {}): any => {
  const handler = toolByName.get(name);
  if (!handler) throw new Error(`unknown tool ${name}`);
  return handler(args);
};

// Same, against another root: cells that build their own fixture call the tool directly.
const callAt = (root: string, name: string, args: Record<string, unknown> = {}): any => {
  const handler = allTools(root).find((t) => t.name === name)?.handler as ((a: Record<string, unknown>) => ToolResult) | undefined;
  if (!handler) throw new Error(`unknown tool ${name}`);
  return handler(args);
};

describe('structural tools (cold/stale mode)', () => {
  it('taujs_overview summarises the graph, states its boundary and declared coverage, and cites staleness', () => {
    const result = call('taujs_overview');

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('stale');
    expect(result.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(result.routeCount).toBe(8);
    expect(result.fallthrough.reachable).toBe(true);
    // The boundary, stated at the point of use: the graph covers what taujs owns, and absence
    // from it never means absence from the application.
    expect(result.scope).toContain('Routes registered directly on the Fastify instance');
    expect(result.scope).toContain('never means absence from the application');
    // Coverage: pricing counts as covered through its deferred-only edge (usedBy parity); content
    // gains header, covered ONLY through its head edge (decisions.md 2026-08-27).
    expect(result.services).toEqual([
      { name: 'catalog', methodCount: 1, withDeclaredEdges: 1, methods: ['getProduct'] },
      { name: 'content', methodCount: 3, withDeclaredEdges: 2, methods: ['about', 'header', 'home'] },
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
    expect(result.routes.total).toBe(8);
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
    // /product/:id declares catalog.getProduct via BOTH data and head: dedupe still yields one
    // declared row, labelled by the first source (data), per ruling 3.
    expect(result.edges.filter((e: { source: string }) => e.source === 'declared')).toHaveLength(1);
    const declared = result.edges.find((e: { source: string }) => e.source === 'declared');
    expect(declared.declaredVia).toBe('serviceData');
    const observed = result.edges.find((e: { source: string }) => e.source === 'observed');
    expect(observed.methodCallCount).toBe(1);
    expect(observed.routeCallCount).toBe(1);
    expect(observed.count).toBeUndefined();
    expect(result.note).toContain('seen in dev traffic');
    // Observations are emitted by a different event than the graph: their own freshness, not the
    // graph's, describes when they were recorded.
    expect(result.observedStaleness).toContain(observationsDoc.bootId);
    expect(result.observedStaleness).toContain(observationsDoc.updatedAt);
  });

  it('taujs_who_calls_service reaches head-only edges, labelled declaredVia "head"', () => {
    const result = call('taujs_who_calls_service', { service: 'content', method: 'header' });

    expect(result.ok).toBe(true);
    expect(result.edges).toEqual([
      {
        source: 'declared',
        service: 'content',
        method: 'header',
        declaredVia: 'head',
        routeId: 'playground-react:/head-only',
        appId: 'playground-react',
        path: '/head-only',
      },
    ]);
    // The note defines "declared"; it must not contradict a returned declaredVia: 'head'.
    expect(result.note).toContain('a head edge');
  });

  it('taujs_who_calls_service without a registry lists a service seen ONLY through a head edge', async () => {
    const headOnlyRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-head-noreg-'));
    const headOnlyConfig: CoreTaujsConfig = {
      apps: [{ appId: 'web', entryPoint: '', routes: [{ path: '/masthead', attr: { render: 'ssr', head: { data: serviceDataWide('phantom', 'boo') } } }] }],
    };
    // No serviceRegistry: services is null, so existence cannot be checked and the discovery
    // list is what the caller gets instead.
    const graph = createRequestGraph(headOnlyConfig, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z' });
    await writeTaujsArtifact(path.join(headOnlyRoot, 'node_modules', '.taujs'), 'graph.json', JSON.stringify(graph));
    const tools = new Map(allTools(headOnlyRoot).map((t) => [t.name, t.handler]));

    const result = tools.get('taujs_who_calls_service')!({ service: 'nothing' } as never) as any;

    expect(result.ok).toBe(true);
    expect(result.servicesSeenOnRouteEdges.items).toEqual(['phantom']);
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
    // Error responses cite staleness too: against a stale graph, "unknown" describes the last boot.
    expect(ghost.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(ghost.knownServices.items).toEqual(['catalog', 'content', 'pricing']);
    expect(ghost.danglingEdges).toBeUndefined();

    const badMethod = call('taujs_who_calls_service', { service: 'content', method: 'nope' });
    expect(badMethod.ok).toBe(false);
    expect(badMethod.reason).toBe('unknown_method');
    expect(badMethod.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(badMethod.knownMethods.items).toEqual(['about', 'header', 'home']);

    // A known method with zero edges is a successful empty query, not an error — agents branch
    // hard on `ok`, and this is "the answer is none", not "I asked wrong".
    const edgeless = call('taujs_who_calls_service', { service: 'content', method: 'about' });
    expect(edgeless.ok).toBe(true);
    expect(edgeless.edges).toEqual([]);
    expect(edgeless.note).toContain('Observed edges only exist for traffic seen this boot');
    // Zero edges for THIS service doesn't mean no observations document exists - its freshness is
    // still cited.
    expect(edgeless.observedStaleness).toContain(observationsDoc.bootId);
    expect(edgeless.observedStaleness).toContain(observationsDoc.updatedAt);
  });

  it('taujs_who_calls_service returns dangling edges on unresolved identifiers instead of hiding them', () => {
    // Routes and registry are emitted independently: /ghosted declares phantom.boo but the
    // registry has no phantom. `ok: false` (identifier does not resolve) AND the real config
    // that references it — hiding either half would mislead.
    const phantom = call('taujs_who_calls_service', { service: 'phantom' });
    expect(phantom.ok).toBe(false);
    expect(phantom.reason).toBe('unknown_service');
    // The dangling edges are last-boot facts too; the citation covers them.
    expect(phantom.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(phantom.observedStaleness).toContain(observationsDoc.bootId);
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
    expect(gone.observedStaleness).toContain(observationsDoc.bootId);
    expect(gone.knownMethods.items).toEqual(['about', 'header', 'home']);
    expect(gone.danglingEdges).toHaveLength(1);
    expect(gone.danglingEdges[0]).toMatchObject({ source: 'declared', routeId: 'playground-react:/gone', method: 'gone' });
  });

  it('observed edges cite the observations document, not the graph', async () => {
    const t1Root = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-t1-'));
    const dir = path.join(t1Root, 'node_modules', '.taujs');
    const graph = createRequestGraph(config, { source: 'build', emittedAt: '2026-07-10T10:00:00.000Z', serviceRegistry: registry });
    await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(graph));
    await writeTaujsArtifact(
      dir,
      'observations.json',
      JSON.stringify({
        schemaVersion: 1,
        bootId: 'boot-t1',
        updatedAt: '2026-07-09T09:00:00.000Z',
        edges: [
          {
            service: 'catalog',
            method: 'getProduct',
            routes: [{ routeId: 'playground-react:/product/:id', appId: 'playground-react', path: '/product/:id', count: 1 }],
            count: 1,
            lastObservedAt: '2026-07-09T09:00:00.000Z',
            sampleRequestIds: ['obs-t1'],
          },
        ],
        shapes: [],
      }),
    );
    const result = callAt(t1Root, 'taujs_who_calls_service', { service: 'catalog' });

    expect(result.staleness).toContain('build');
    expect(result.staleness).toContain('2026-07-10T10:00:00.000Z');
    expect(result.observedStaleness).toContain('boot-t1');
    expect(result.observedStaleness).toContain('2026-07-09T09:00:00.000Z');
  });

  it('observedStaleness is never fabricated', async () => {
    // Missing observations.json: readObservations fails, so there is no document to cite.
    const noObsRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-noobs-'));
    await writeTaujsArtifact(
      path.join(noObsRoot, 'node_modules', '.taujs'),
      'graph.json',
      JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z', serviceRegistry: registry })),
    );
    const noObsResult = callAt(noObsRoot, 'taujs_who_calls_service', { service: 'catalog' });
    expect(noObsResult.observedStaleness).toBeUndefined();

    // Unreadable observations.json: readObservations fails, so there is still no document to cite.
    const badObsRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-badobs-'));
    const badObsDir = path.join(badObsRoot, 'node_modules', '.taujs');
    await writeTaujsArtifact(
      badObsDir,
      'graph.json',
      JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z', serviceRegistry: registry })),
    );
    await writeTaujsArtifact(badObsDir, 'observations.json', 'not json');
    const badObsResult = callAt(badObsRoot, 'taujs_who_calls_service', { service: 'catalog' });
    expect(badObsResult.observedStaleness).toBeUndefined();

    // An active boot: observations are readable, but the graph itself is not stale, so neither
    // staleness citation applies.
    const activeRoot = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-active-'));
    const activeDir = path.join(activeRoot, 'node_modules', '.taujs');
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: 'obs-active-1', url: '/product/9', method: 'GET' });
    dev.recorder.routeMatched({ requestId: 'obs-active-1', path: '/product/:id', appId: 'playground-react', render: 'streaming' });
    dev.recorder.serviceCall({ requestId: 'obs-active-1', service: 'catalog', method: 'getProduct', ms: 4, ok: true });
    dev.recorder.sent({ requestId: 'obs-active-1', status: 200, mode: 'streaming' });
    await writeTaujsArtifact(
      activeDir,
      'graph.json',
      JSON.stringify(createRequestGraph(config, { source: 'boot', emittedAt: '2026-07-10T10:00:00.000Z', serviceRegistry: registry })),
    );
    // Same bootId as dev.json: readObservations must not mask it as a foreign boot.
    await writeTaujsArtifact(activeDir, 'observations.json', JSON.stringify(dev.getObservations()));
    const devJson: DevJson = {
      bootId: dev.bootId,
      token: 'tok',
      pid: process.pid,
      startedAt: '2026-07-10T10:00:00.000Z',
      host: '127.0.0.1',
      port: 5173,
      graph: path.join(activeDir, 'graph.json'),
      episodes: path.join(activeDir, 'episodes.ndjson'),
      logs: path.join(activeDir, 'logs.ndjson'),
      observations: path.join(activeDir, 'observations.json'),
    };
    await writeTaujsArtifact(activeDir, 'dev.json', JSON.stringify(devJson));
    const activeResult = callAt(activeRoot, 'taujs_who_calls_service', { service: 'catalog' });

    expect(activeResult.observedStaleness).toBeUndefined();
    expect(activeResult.staleness).toBeUndefined();
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
    // head edge, mirrors data (decisions.md 2026-08-27): the route's declared head edge shows.
    expect(explanation.head).toEqual({ data: { kind: 'service', service: 'catalog', method: 'getProduct' } });
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
    expect(payload.routeCount).toBe(8);
    expect(result.structuredContent).toEqual(payload);

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

  // The SDK validates arguments against the zod inputSchema before calling the handler. On a
  // failure it resolves normally with `isError: true` and an "Input validation error" text block -
  // it does not reject the call or raise a JSON-RPC error - so the tell that the handler never ran
  // is the absent `structuredContent` (every taujs envelope sets it) plus `withGraph` never being
  // called.
  it('rejects malformed tool arguments before the handler runs (SDK-side schema validation)', async () => {
    const server = createTaujsMcpServer(root);
    const client = new Client({ name: 'malformed-args-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    vi.mocked(withGraph).mockClear();

    // Malformed: `limit` must be a number.
    const badLimit = await client.callTool({ name: 'taujs_list_routes', arguments: { limit: 'bad' } });
    expect(badLimit.isError).toBe(true);
    expect(badLimit.structuredContent).toBeUndefined();
    expect((badLimit.content as { text: string }[])[0]!.text).toMatch(/^Input validation error: Invalid arguments for tool taujs_list_routes/);
    expect(withGraph).not.toHaveBeenCalled();

    // Control: a valid call reaches the handler.
    vi.mocked(withGraph).mockClear();
    const validLimit = await client.callTool({ name: 'taujs_list_routes', arguments: { limit: 1 } });
    expect(validLimit.isError).toBeUndefined();
    expect((validLimit.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(withGraph).toHaveBeenCalledTimes(1);

    // Second malformed case: a required field missing entirely (taujs_get_episode's requestId).
    vi.mocked(withGraph).mockClear();
    const missingRequired = await client.callTool({ name: 'taujs_get_episode', arguments: {} });
    expect(missingRequired.isError).toBe(true);
    expect(missingRequired.structuredContent).toBeUndefined();
    expect((missingRequired.content as { text: string }[])[0]!.text).toMatch(/^Input validation error: Invalid arguments for tool taujs_get_episode/);
    expect(withGraph).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });
});
