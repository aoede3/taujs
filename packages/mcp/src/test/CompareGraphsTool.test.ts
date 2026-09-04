// @vitest-environment node
// Tool-level evidence for taujs_compare_graphs: baseline refusals against a REAL filesystem
// (SubstrateReader.test.ts's own style - the files on disk are the contract), truncation, the
// "baseline equals current" sanity case, and one real protocol call. The pure comparison table
// (every included facet, ignored fields, determinism) lives in GraphCompare.test.ts.
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';

import { allTools, createTaujsMcpServer } from '../server';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { ToolResult } from '../toolkit';

const smallConfig: CoreTaujsConfig = {
  apps: [
    {
      appId: 'web',
      entryPoint: 'web',
      routes: [
        { path: '/', attr: { render: 'ssr' } },
        { path: '/extra', attr: { render: 'ssr' } },
      ],
    },
  ],
};

// One parent for every fixture root this file creates, removed whole in afterAll.
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-compare-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// A fresh project root with a "current" graph already on disk (cold/stale mode, no dev.json -
// StructuralTools.test.ts's own convention: structural tools must work without a live boot).
const mkProject = async (config: CoreTaujsConfig, opts?: { emittedAt?: string; source?: 'boot' | 'build' }) => {
  const root = await mkdtemp(path.join(scratch, 'root-'));
  const graph = createRequestGraph(config, { source: opts?.source ?? 'boot', emittedAt: opts?.emittedAt ?? '2026-09-01T10:00:00.000Z' });
  await writeTaujsArtifact(path.join(root, 'node_modules', '.taujs'), 'graph.json', JSON.stringify(graph, null, 2));
  const handler = allTools(root).find((t) => t.name === 'taujs_compare_graphs')!.handler as (a: Record<string, unknown>) => ToolResult;
  return { root, graph, call: (args: Record<string, unknown>): any => handler(args) };
};

const writeFileAt = async (root: string, relPath: string, content: string) => {
  const full = path.join(root, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return full;
};

describe('taujs_compare_graphs — baseline refusals', () => {
  it('refuses an absolute baselinePath', async () => {
    const { call, root } = await mkProject(smallConfig);

    const result = call({ baselinePath: path.join(root, 'baseline.json') });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_baseline_path' });
  });

  it('refuses a ../ traversal path, even when it resolves to a real file', async () => {
    const { call, root } = await mkProject(smallConfig);
    await writeFile(path.join(path.dirname(root), 'outside.json'), '{}', 'utf8');

    const result = call({ baselinePath: '../outside.json' });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_baseline_path' });
  });

  it('refuses a symlink that resolves outside the project root', async () => {
    const { call, root } = await mkProject(smallConfig);
    const outsideTarget = path.join(scratch, 'secret-baseline.json');
    await writeFile(outsideTarget, JSON.stringify(createRequestGraph(smallConfig, { source: 'boot', emittedAt: '2026-01-01T00:00:00.000Z' })), 'utf8');
    await symlink(outsideTarget, path.join(root, 'escape.json'));

    const result = call({ baselinePath: 'escape.json' });

    expect(result).toMatchObject({ ok: false, reason: 'baseline_not_found' });
  });

  it('refuses unreadable (unparsable) JSON', async () => {
    const { call, root } = await mkProject(smallConfig);
    await writeFileAt(root, 'baseline-bad.json', '{not json');

    const result = call({ baselinePath: 'baseline-bad.json' });

    expect(result).toMatchObject({ ok: false, reason: 'baseline_unreadable' });
  });

  it('refuses schema skew, explicitly', async () => {
    const { call, root } = await mkProject(smallConfig);
    await writeFileAt(root, 'baseline-skew.json', JSON.stringify({ schemaVersion: 1 }));

    const result = call({ baselinePath: 'baseline-skew.json' });

    expect(result).toMatchObject({ ok: false, reason: 'schema_skew' });
    expect(result.message).toContain('v1');
    expect(result.message).toContain('v2');
  });

  it('refuses a partial-but-nonthrowing schema-v2 baseline (missing source/emittedAt/security/fallthrough and route facets)', async () => {
    const { call, root } = await mkProject(smallConfig);
    // Every dereference this document survives - nothing throws - yet comparing it would emit
    // incomplete metadata and malformed change rows. It must refuse as a baseline problem.
    await writeFileAt(root, 'baseline-partial.json', JSON.stringify({ schemaVersion: 2, taujs: { server: 'x' }, apps: [], routes: [] }));

    const result = call({ baselinePath: 'baseline-partial.json' });

    expect(result).toMatchObject({ ok: false, reason: 'baseline_unreadable' });
    expect(result.message).toContain('shape');
  });

  it('refuses parseable JSON with schemaVersion 2 but an invalid graph shape, cleanly - never a generic tool_failure', async () => {
    const { call, root } = await mkProject(smallConfig);
    await writeFileAt(root, 'baseline-malformed.json', JSON.stringify({ schemaVersion: 2, apps: [], routes: 'nope' }));

    // A direct handler call: a throw here would escape as an exception (the server wraps it into
    // tool_failure), so reaching an ok:false envelope IS the proof of a clean refusal.
    const result = call({ baselinePath: 'baseline-malformed.json' });

    expect(result).toMatchObject({ ok: false, reason: 'baseline_unreadable' });
    expect(result.message).toContain('shape');
  });
});

describe('taujs_compare_graphs — detection precedes the display cap', () => {
  it('values identical through character 500 but different afterwards produce a change (rows display capped)', async () => {
    const sharedPrefix = 'a'.repeat(500);
    const longConfig: CoreTaujsConfig = {
      apps: [{ appId: 'web', entryPoint: `${sharedPrefix}CURRENT-TAIL`, routes: [{ path: '/', attr: { render: 'ssr' } }] }],
    };
    const { call, root, graph } = await mkProject(longConfig);
    const baseline = JSON.parse(JSON.stringify(graph));
    baseline.apps[0].entryPoint = `${sharedPrefix}BASELINE-TAIL`;
    await writeFileAt(root, 'baseline.json', JSON.stringify(baseline));

    const result = call({ baselinePath: 'baseline.json' });

    expect(result.ok).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.summary).toEqual({ added: 0, removed: 0, changed: 1, total: 1 });
    expect(result.changes.items[0]).toMatchObject({ kind: 'app', change: 'changed', id: 'web', field: 'entryPoint' });
    // The DISPLAYED values are capped - after the cap both sides read as the shared prefix, which
    // is exactly why detection has to happen first.
    expect(result.changes.items[0].baseline).toBe(sharedPrefix);
    expect(result.changes.items[0].current).toBe(sharedPrefix);
  });
});

describe('taujs_compare_graphs — truncation', () => {
  it('limit smaller than the row count: summary and changes.total carry the FULL counts, truncated true, items bounded', async () => {
    const manyRoutesConfig: CoreTaujsConfig = {
      apps: [{ appId: 'web', entryPoint: 'web', routes: Array.from({ length: 60 }, (_, i) => ({ path: `/r${i}`, attr: { render: 'ssr' as const } })) }],
    };
    const { call, root, graph } = await mkProject(manyRoutesConfig);
    // Baseline declares none of the 60 routes - every route is 'added' relative to it.
    const emptyBaseline = { ...graph, routes: [] };
    await writeFileAt(root, 'baseline.json', JSON.stringify(emptyBaseline));

    const result = call({ baselinePath: 'baseline.json', limit: 10 });

    expect(result.ok).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.summary).toEqual({ added: 60, removed: 0, changed: 0, total: 60 });
    expect(result.changes.total).toBe(60);
    expect(result.changes.truncated).toBe(true);
    expect(result.changes.items).toHaveLength(10);
  });
});

describe('taujs_compare_graphs — sanity and envelope shape', () => {
  it('baseline path equal to the current graph’s own file: identical true, full metadata reported on both sides', async () => {
    const { call, root, graph } = await mkProject(smallConfig, { emittedAt: '2026-09-01T11:00:00.000Z' });

    const result = call({ baselinePath: 'node_modules/.taujs/graph.json' });

    expect(result).toMatchObject({
      ok: true,
      identical: true,
      summary: { added: 0, removed: 0, changed: 0, total: 0 },
      changes: { items: [], total: 0, truncated: false },
    });
    expect(result.baseline).toEqual({
      path: 'node_modules/.taujs/graph.json',
      source: graph.source,
      emittedAt: graph.emittedAt,
      taujsServer: graph.taujs.server,
      schemaVersion: graph.schemaVersion,
    });
    expect(result.current).toEqual({ source: graph.source, emittedAt: graph.emittedAt, taujsServer: graph.taujs.server, schemaVersion: graph.schemaVersion });
    expect(typeof result.scope).toBe('string');
    expect(result.scope).toContain('services');
    // Cold/stale mode (no dev.json): the shared staleness line is carried exactly as every other
    // structural tool carries it.
    expect(result.staleness).toContain(graph.emittedAt);
  });

  it('a genuine difference is reported with the id and field an agent can act on', async () => {
    const { call, root, graph } = await mkProject(smallConfig);
    const baseline = JSON.parse(JSON.stringify(graph));
    baseline.apps[0].entryPoint = 'web-OLD';
    await writeFileAt(root, 'baseline.json', JSON.stringify(baseline));

    const result = call({ baselinePath: 'baseline.json' });

    expect(result.ok).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.changes.items).toEqual([{ kind: 'app', change: 'changed', id: 'web', field: 'entryPoint', baseline: 'web-OLD', current: 'web' }]);
  });
});

describe('taujs_compare_graphs — tool registration and protocol output', () => {
  it('is registered in allTools and answers a real call through the MCP protocol with structuredContent', async () => {
    const root = await mkdtemp(path.join(scratch, 'proto-'));
    const graph = createRequestGraph(smallConfig, { source: 'boot', emittedAt: '2026-09-01T12:00:00.000Z' });
    await writeTaujsArtifact(path.join(root, 'node_modules', '.taujs'), 'graph.json', JSON.stringify(graph, null, 2));

    expect(allTools(root).map((t) => t.name)).toContain('taujs_compare_graphs');

    const server = createTaujsMcpServer(root);
    const client = new Client({ name: 'compare-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'taujs_compare_graphs', arguments: { baselinePath: 'node_modules/.taujs/graph.json' } });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(payload.ok).toBe(true);
    expect(payload.identical).toBe(true);
    expect(result.structuredContent).toEqual(payload);

    await client.close();
    await server.close();
  });
});
