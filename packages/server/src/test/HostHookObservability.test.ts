// @vitest-environment node
//
// Unit 2 of `followups/streaming-response-host-policy.md`: which Fastify lifecycle hooks a host can
// use to establish response policy, for SSR and for streaming, in both ownership modes.
//
// Two questions are recorded SEPARATELY, because conflating them would publish a misleading
// "supported hooks" table:
//
//   1. is the hook INVOKED;
//   2. does a header mutation made there SURVIVE to the wire.
//
// τjs streams by handing Fastify a COLD document, so Fastify's send path runs for a streamed
// response exactly as it does for an ordinary one - `onSend` is a usable policy point on both.
//
// `onResponse` is why: it is invoked for both strategies, but it runs after the response has
// completed, so mutation is not available there at all.
//
// Real listener throughout. `inject()` has already been shown to conceal wire behaviour on this
// seam (Unit 1), so the acceptance evidence is read from `IncomingMessage.rawHeaders` off a real
// socket. ONE boot per ownership mode installs all seven hooks and answers every cell.
//
// A plain JSON control route rides the same boot: `preSerialization` is invoked there and its
// mutation survives, which is what makes it PAYLOAD-SHAPE dependent rather than something τjs
// omits. τjs page responses are a string (SSR) or a raw stream (streaming); neither is serialised.

import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../CreateServer';
import { testRenderer } from './support/renderer';

import type { FastifyInstance } from 'fastify';
import type { TaujsConfig } from '../Config';

const HOOKS = ['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onResponse'] as const;

type Hook = (typeof HOOKS)[number];
/** `json` is the payload-shape control, not a τjs render strategy. */
/** The probes the MATRIX table covers. */
type MatrixProbe = 'ssr' | 'streaming' | 'json';
/** Every probe the harness observes, including cases the table cannot express. */
type Probe = MatrixProbe | 'pre-byte-failure';
type HostMode = 'caller-owned' | 'taujs-created';

const PATHS: Record<MatrixProbe, string> = { ssr: '/matrix-ssr', streaming: '/matrix-streamed', json: '/matrix-json' };
/** A streamed route whose renderer fails BEFORE any document byte. */
const PRE_BYTE_FAILURE = '/matrix-streamed-pre-byte-failure';

const probePaths: Record<Probe, string> = { ...PATHS, 'pre-byte-failure': PRE_BYTE_FAILURE };
const MUTATION = 'hook-mutation';

const headerFor = (hook: Hook): string => `x-hook-${hook.toLowerCase()}`;
const probeOf = (url: string | undefined): Probe | undefined => (Object.entries(probePaths) as Array<[Probe, string]>).find(([, value]) => value === url)?.[0];

/** Real SSR and streaming render functions: the streaming one reaches `onHead` and the terminal. */
const RENDER_MODULE = [
  "const tag = Symbol.for('taujs.render-contract/v1');",
  "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
  "export const renderSSR = brand(async () => ({ headContent: '', appHtml: '<main>ssr</main>' }));",
  'export const renderStream = brand((writable, callbacks, _data, url) => {',
  `  if (url === '${PRE_BYTE_FAILURE}') { callbacks.onError(new Error('pre-byte failure')); return { abort() {}, done: Promise.resolve() }; }`,
  '  callbacks.onHead(\'<meta name="matrix" content="taujs">\');',
  "  writable.write('<main>streamed</main>');",
  '  callbacks.onShellReady?.();',
  "  callbacks.onAllReady?.({ marker: 'matrix' });",
  '  writable.end();',
  '  return { abort() {}, done: Promise.resolve() };',
  '});',
].join('\n');

const fixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-hook-matrix-'));
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(ssrRoot, { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/matrix-client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'matrix-client.js'), 'export const marker = "matrix";\n');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return { root, clientRoot };
};

const config: TaujsConfig = {
  apps: [
    {
      appId: 'hook-matrix-app',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [
        { path: PATHS.ssr, attr: { render: 'ssr' } },
        { path: PATHS.streaming, attr: { render: 'streaming', meta: {} } },
        { path: PRE_BYTE_FAILURE, attr: { render: 'streaming', meta: {} } },
      ],
    },
  ],
};

type Observations = {
  invocations: Map<string, number>;
  completions: Array<{ probe: Probe; statusCode: number }>;
  /** What the host was HANDED on each send pass: Fastify runs its send path per payload. */
  sendPasses: Array<'document' | 'error'>;
};

const key = (hook: Hook, probe: Probe | MatrixProbe): string => `${hook}|${probe}`;

/** Installs all seven hooks; each records its invocation and attempts a header mutation. */
const installHooks = (app: FastifyInstance, seen: Observations, options: { replaceOnSend?: boolean } = {}): void => {
  const note = (hook: Hook, url: string | undefined) => {
    const probe = probeOf(url);
    if (!probe) return;
    seen.invocations.set(key(hook, probe), (seen.invocations.get(key(hook, probe)) ?? 0) + 1);
  };

  app.addHook('onRequest', (request, reply, done) => {
    note('onRequest', request.url);
    reply.header(headerFor('onRequest'), MUTATION);
    done();
  });

  app.addHook('preParsing', (request, reply, payload, done) => {
    note('preParsing', request.url);
    reply.header(headerFor('preParsing'), MUTATION);
    done(null, payload);
  });

  app.addHook('preValidation', (request, reply, done) => {
    note('preValidation', request.url);
    reply.header(headerFor('preValidation'), MUTATION);
    done();
  });

  app.addHook('preHandler', (request, reply, done) => {
    note('preHandler', request.url);
    reply.header(headerFor('preHandler'), MUTATION);
    done();
  });

  app.addHook('preSerialization', (request, reply, payload, done) => {
    note('preSerialization', request.url);
    reply.header(headerFor('preSerialization'), MUTATION);
    done(null, payload);
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    note('onSend', request.url);
    reply.header(headerFor('onSend'), MUTATION);

    if (probeOf(request.url)) {
      seen.sendPasses.push(payload && typeof (payload as { pipe?: unknown }).pipe === 'function' ? 'document' : 'error');
    }

    done(null, options.replaceOnSend ? 'REPLACED-BY-HOST' : payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    note('onResponse', request.url);
    const probe = probeOf(request.url);
    if (probe) seen.completions.push({ probe, statusCode: reply.statusCode });
    // Attempted deliberately: the matrix records that a mutation here cannot reach the wire.
    try {
      reply.header(headerFor('onResponse'), MUTATION);
    } catch {
      // Whether Fastify rejects it or accepts it into a dead store, it never reaches the client.
    }
    done();
  });
};

type Wire = { status: number; headers: Map<string, string[]>; body: string };

const readWire = (port: number, url: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Map<string, string[]>();

        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          const name = response.rawHeaders[i]!.toLowerCase();
          headers.set(name, [...(headers.get(name) ?? []), response.rawHeaders[i + 1]!]);
        }

        resolve({ status: response.statusCode ?? 0, headers, body });
      });
    });

    request.on('error', reject);
  });

const open: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  const apps = open.splice(0);
  const dirs = roots.splice(0);

  try {
    // Deliberately unguarded: on a real-host contract test, a teardown failure IS a failure.
    await Promise.all(apps.map((app) => app.close()));
  } finally {
    await Promise.all(dirs.map((root) => rm(root, { recursive: true, force: true })));
  }
});

/**
 * The two documented public flows:
 *
 * - caller-owned: root hooks registered BEFORE the instance is handed to `createServer`;
 * - τjs-created: hooks added to the RETURNED app AFTER `createServer` and BEFORE `listen`, which is
 *   why created mode returns `{ app, net }`.
 */
const boot = async (mode: HostMode, options: { replaceOnSend?: boolean } = {}): Promise<{ app: FastifyInstance; port: number; seen: Observations }> => {
  const { root, clientRoot } = await fixture();
  roots.push(root);

  const seen: Observations = { invocations: new Map(), completions: [], sendPasses: [] };
  let app: FastifyInstance;

  if (mode === 'caller-owned') {
    app = fastify({ logger: false });
    installHooks(app, seen, options);
    app.get(PATHS.json, async () => ({ probe: 'json' }));
    await createServer({ config, fastify: app, clientRoot });
  } else {
    const created = await createServer({ config, clientRoot });
    app = created.app!;
    installHooks(app, seen, options);
    app.get(PATHS.json, async () => ({ probe: 'json' }));
  }

  open.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();

  return { app, port: typeof address === 'object' && address !== null ? address.port : 0, seen };
};

const invocationsOf = (seen: Observations, probe: MatrixProbe): Record<Hook, number> =>
  Object.fromEntries(HOOKS.map((hook) => [hook, seen.invocations.get(key(hook, probe)) ?? 0])) as Record<Hook, number>;

const survivorsOf = (wire: Wire): Record<Hook, string | null> =>
  Object.fromEntries(HOOKS.map((hook) => [hook, wire.headers.get(headerFor(hook))?.[0] ?? null])) as Record<Hook, string | null>;

// The frozen matrix. Same in both ownership modes; any divergence is a finding, not a detail.
const INVOKED: Record<MatrixProbe, Record<Hook, number>> = {
  ssr: { onRequest: 1, preParsing: 1, preValidation: 1, preHandler: 1, preSerialization: 0, onSend: 1, onResponse: 1 },
  streaming: { onRequest: 1, preParsing: 1, preValidation: 1, preHandler: 1, preSerialization: 0, onSend: 1, onResponse: 1 },
  json: { onRequest: 1, preParsing: 1, preValidation: 1, preHandler: 1, preSerialization: 1, onSend: 1, onResponse: 1 },
};

const SURVIVES: Record<MatrixProbe, Record<Hook, string | null>> = {
  ssr: {
    onRequest: MUTATION,
    preParsing: MUTATION,
    preValidation: MUTATION,
    preHandler: MUTATION,
    preSerialization: null, // not invoked: an HTML string is not serialised
    onSend: MUTATION,
    onResponse: null, // invoked, but the response has already completed
  },
  streaming: {
    onRequest: MUTATION,
    preParsing: MUTATION,
    preValidation: MUTATION,
    preHandler: MUTATION,
    preSerialization: null, // not invoked: a raw stream is not serialised
    onSend: MUTATION, // invoked WITH the cold document, and its mutation reaches the client
    onResponse: null, // invoked, but the response has already completed
  },
  json: {
    onRequest: MUTATION,
    preParsing: MUTATION,
    preValidation: MUTATION,
    preHandler: MUTATION,
    preSerialization: MUTATION, // the control: an object payload IS serialised
    onSend: MUTATION,
    onResponse: null,
  },
};

describe('host hook observability: cases the matrix table cannot express', () => {
  it('a PRE-BYTE streamed failure gives the host TWO send passes: the stream attempt, then the error representation', async () => {
    const { port, seen } = await boot('caller-owned');
    const wire = await readWire(port, PRE_BYTE_FAILURE);

    // Fastify runs its send path PER PAYLOAD. The cold document is offered first; when it fails
    // before yielding a byte, Fastify's error path offers the structured error instead. Host hooks
    // must therefore be safe across response attempts and must NOT assume one onSend per request.
    expect(wire.status).toBe(500);
    // `sendPasses` is the load-bearing assertion: this probe never requests the plain streaming
    // route, so an `invocations` lookup keyed on it could only ever be undefined and would prove
    // nothing about the two passes.
    expect(seen.sendPasses).toEqual(['document', 'error']);

    // `onResponse` still describes the request ONCE.
    await vi.waitFor(() => expect(seen.completions.filter((entry) => entry.probe === 'pre-byte-failure')).toHaveLength(1), { timeout: 5000 });
  });

  it('payload replacement: the host replaces the cold document and the renderer never starts', async () => {
    const { port, seen } = await boot('caller-owned', { replaceOnSend: true });
    const wire = await readWire(port, PATHS.streaming);

    expect(wire.status).toBe(200);
    expect(wire.body).toBe('REPLACED-BY-HOST');
    expect(wire.body).not.toContain('<!doctype');
    expect(seen.invocations.get(key('onSend', 'streaming'))).toBe(1);
  });
});

describe.each(['caller-owned', 'taujs-created'] as const)('host hook observability matrix (real listener): %s', (mode) => {
  it('pins invocation, mutation survival and completion for every hook and both render strategies', async () => {
    const { app, port, seen } = await boot(mode);

    const wires: Record<MatrixProbe, Wire> = {
      ssr: await readWire(port, PATHS.ssr),
      streaming: await readWire(port, PATHS.streaming),
      json: await readWire(port, PATHS.json),
    };

    // `onResponse` fires on the raw response's `finish`, which can land after the client has read
    // the last byte, so completion is awaited rather than assumed.
    await vi.waitFor(() => expect(seen.completions).toHaveLength(3), { timeout: 2000 });

    // The responses are real: SSR rendered, streaming reached `onHead` AND its data terminal.
    expect(wires.ssr.status).toBe(200);
    expect(wires.ssr.body).toContain('<main>ssr</main>');
    expect(wires.streaming.status).toBe(200);
    expect(wires.streaming.body).toContain('<meta name="matrix" content="taujs">');
    expect(wires.streaming.body).toContain('<main>streamed</main>');
    expect(wires.streaming.body).toContain('taujs:data-ready');
    expect(wires.json.status).toBe(200);

    for (const probe of ['ssr', 'streaming', 'json'] as const) {
      expect({ probe, invoked: invocationsOf(seen, probe) }).toEqual({ probe, invoked: INVOKED[probe] });
      expect({ probe, survives: survivorsOf(wires[probe]) }).toEqual({ probe, survives: SURVIVES[probe] });
    }

    // Completion is observed exactly once per response, with the real status, on every strategy.
    // Compared by probe, not chronologically: `onResponse` lands after the client has read the
    // final byte, so its relative ordering is scheduling rather than contract.
    expect([...seen.completions].sort((left, right) => left.probe.localeCompare(right.probe))).toEqual([
      { probe: 'json', statusCode: 200 },
      { probe: 'ssr', statusCode: 200 },
      { probe: 'streaming', statusCode: 200 },
    ]);

    // The boundary behind the τjs-created flow: hooks must be installed before the instance boots.
    // Fastify enforces it, so "after createServer and before listen" is a real constraint rather
    // than a stylistic recommendation.
    expect(() => app.addHook('onRequest', (_request, _reply, done) => done())).toThrow();
  });
});
