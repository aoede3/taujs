// @vitest-environment node
// The built bin, launched as a real child process: everything before this ran the tool handlers
// directly or through an InMemory transport, which proves the protocol wiring but never proves the
// BUILT artefact (workspace build output at dist/bin.js) serves stdio, writes only JSON-RPC to
// stdout, or exits when asked to. This is the one suite that spawns `dist/bin.js` itself.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';

import { generateMcpJson } from '../../../create-taujs/src/mcp';
import { createDevIntrospection } from '../../../server/src/core/introspection/DevIntrospection';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { defineService, defineServiceRegistry } from '../../../server/src/core/services/DataServices';
import { createServiceData } from '../../../server/src/core/services/ServiceData';

import mcpPkg from '../../package.json';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClientOptions } from '@modelcontextprotocol/client';
import type { CoreTaujsConfig } from '../../../server/src/core/config/types';

// The workspace gates build before testing (see the top-level gate order), so a missing dist is a
// setup mistake, not a reason to quietly skip the one suite that exercises the built dist/bin.js.
const BIN = path.resolve(__dirname, '../../dist/bin.js');

const TOOL_NAMES = [
  'taujs_doctor',
  'taujs_explain_route',
  'taujs_get_episode',
  'taujs_get_episode_logs',
  'taujs_get_recent_episodes',
  'taujs_get_route',
  'taujs_list_routes',
  'taujs_overview',
  'taujs_who_calls_service',
];

const PROMPT_NAMES = ['taujs_skill_add_streamed_route', 'taujs_skill_diagnose_broken_route', 'taujs_skill_hydration_mismatch'];

const catalog = defineService({
  getProduct: {
    handler: async (p: { id: string }) => ({ product: { id: p.id } }),
    params: { parse: (u: unknown) => u as { id: string } },
  },
});
const registry = defineServiceRegistry({ catalog });
const serviceData = createServiceData<typeof registry>();

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'stdio-app',
      entryPoint: '',
      routes: [{ path: '/product/:id', attr: { render: 'ssr', data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) } }],
    },
  ],
};

let root: string;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error('dist/bin.js not found - run pnpm --filter @taujs/mcp build first');

  root = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-stdio-'));
  const dir = path.join(root, 'node_modules', '.taujs');

  const graph = createRequestGraph(config, { source: 'boot', emittedAt: '2026-08-28T10:00:00.000Z', serviceRegistry: registry });
  await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(graph, null, 2));

  // Written via the real emitter, exactly as StructuralTools.test.ts does - no dev.json, so
  // structural tools answer cold/stale (taujs_overview does not need a live boot).
  const dev = createDevIntrospection();
  await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(dev.getObservations(), null, 2));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// Every client/transport and every raw child spawned by a cell is tracked here so a failed
// assertion can never leak a live process into the next test.
const clients: Client[] = [];
const rawChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  for (const child of rawChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

const connect = async (options?: ClientOptions): Promise<Client> => {
  const client = new Client({ name: 'stdio-test-client', version: '0.0.0' }, options);
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: root, stderr: 'pipe' });
  await client.connect(transport);
  return client;
};

// Shared by S1/S2/S3: the same three assertions over whichever era the client negotiated. The
// point of these cells is that a working transport looks IDENTICAL from here regardless of era.
const assertServesTools = async (client: Client) => {
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);

  const prompts = await client.listPrompts();
  expect(prompts.prompts.map((p) => p.name).sort()).toEqual(PROMPT_NAMES);

  const result = await client.callTool({ name: 'taujs_overview', arguments: {} });
  const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(parsed.ok).toBe(true);
  expect(result.structuredContent).toEqual(parsed);
};

describe('the built bin over stdio', () => {
  it('S1 default legacy client (no version negotiation) is served exactly as today', async () => {
    const client = await connect();
    await assertServesTools(client);
  }, 15_000);

  it('S2 modern client pinned to 2026-07-28 negotiates that revision and is served the same way', async () => {
    const client = await connect({ versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await assertServesTools(client);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
  }, 15_000);

  it('S3 modern client in auto mode probes the bin with server/discover and negotiates 2026-07-28 (a silent legacy fallback is a failure)', async () => {
    const client = await connect({ versionNegotiation: { mode: 'auto' } });
    await assertServesTools(client);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
  }, 15_000);

  it('S4 writes only JSON-RPC to stdout, and S5 exits 0 with no signal once stdin ends', async () => {
    const child = spawn(process.execPath, [BIN], { cwd: root }) as ChildProcessWithoutNullStreams;
    rawChildren.push(child);

    // Response-driven, not time-driven: a line buffer feeding a small pub-sub so a cell can
    // await the specific reply it just provoked instead of sleeping for an arbitrary window.
    let carry = '';
    const collectedLines: string[] = [];
    const waiters: { predicate: (message: unknown) => boolean; resolve: (message: unknown) => void }[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      carry += chunk.toString();
      let newlineAt: number;
      while ((newlineAt = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newlineAt);
        carry = carry.slice(newlineAt + 1);
        if (line.trim().length === 0) continue;
        collectedLines.push(line);

        const message: unknown = JSON.parse(line); // a parse failure here fails the cell loudly, as intended
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.predicate(message)) {
            const [waiter] = waiters.splice(i, 1);
            waiter!.resolve(message);
          }
        }
      }
    });

    const nextLine = (predicate: (message: unknown) => boolean, timeoutMs = 5_000): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`nextLine timed out after ${timeoutMs}ms waiting for a matching line`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });

    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

    const initializeReplied = nextLine((m) => (m as { id?: number }).id === 1);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-client', version: '0.0.0' } },
    });
    await initializeReplied;

    const toolsListReplied = nextLine((m) => (m as { id?: number }).id === 2);
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await toolsListReplied;

    // S4: everything written to stdout across the whole exchange is JSON-RPC 2.0.
    expect(collectedLines.length).toBeGreaterThan(0);
    for (const line of collectedLines) {
      const message = JSON.parse(line);
      expect(message.jsonrpc).toBe('2.0');
    }

    // S5: the process exits cleanly - code 0, no signal - within 5 s of stdin ending.
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('process did not exit within 5s of stdin.end()')), 5_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.stdin.end();
    });

    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  }, 15_000);
});

describe('.mcp.json compatibility', () => {
  // Static check only: that the generated command actually launches @taujs/mcp from the PACKED
  // tarball (not just src) is proven by create-taujs's lifecycle stage, not here.
  it('S6 generateMcpJson names the declared bin', () => {
    const binName = 'taujs-mcp';
    expect(mcpPkg.bin).toEqual({ [binName]: './dist/bin.js' });

    for (const packageManager of ['pnpm', 'npm', 'yarn'] as const) {
      const generated = generateMcpJson(packageManager);
      expect(generated.mcpServers.taujs.args).toContain(binName);
    }
  });
});
