// @vitest-environment node
//
// Unit 1 of `followups/streaming-response-host-policy.md`: the streamed head is written from ONE
// normalised, lowercase-keyed object, so a header established before the raw handoff is not
// re-added under a second casing and emitted twice.
//
// Scope note: repeated header LINES are legitimate on the wire (`set-cookie` is the obvious case).
// The defect is case-variant duplication of a single-valued header caused by two object keys, so
// the assertions below pin the single-valued headers under test rather than global uniqueness.
//
// This has to be a real listener. `inject()` cannot observe the defect - light-my-request reports
// a single folded header value, while the duplication exists only in Node's raw header
// serialisation, so an inject-based assertion would pass vacuously. `IncomingMessage.rawHeaders`
// preserves repeated header lines, which is real wire evidence without hand-parsing TCP chunks.
//
// The pre-head 500 head is exercised separately through the captured `writeHead` assertions in
// `utils/test/HandleRender.test.ts`: reaching it here would need a renderer failure mid-boot, and
// the captured-object assertions pin the same normalised object.

import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createServer } from '../CreateServer';
import { testRenderer } from './support/renderer';

import type { TaujsConfig } from '../Config';

const TAUJS_CSP_DIRECTIVE = "'taujs-streaming-head'";
const HOST_POLICY_HEADER = 'X-Host-Policy';
const HOST_POLICY_VALUE = 'streaming-head-host-policy';
const STREAM_PATH = '/streamed';

/**
 * A real streaming render module: it calls `onHead` (which commits the head and pipes), writes app
 * bytes, then ends the writable so the host's `finish` terminal emits the data script and closes
 * the response. A stub that never reaches `onHead` would leave the head uncommitted and the wire
 * assertions vacuous.
 */
const RENDER_MODULE = [
  "const tag = Symbol.for('taujs.render-contract/v1');",
  "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
  "export const renderSSR = brand(async () => ({ headContent: '', appHtml: '<main>ssr</main>' }));",
  'export const renderStream = brand((writable, callbacks) => {',
  '  callbacks.onHead(\'<meta name="streaming-head" content="taujs">\');',
  "  writable.write('<main>streamed</main>');",
  '  callbacks.onShellReady?.();',
  "  callbacks.onAllReady?.({ marker: 'streamed-data' });",
  '  writable.end();',
  '  return { abort() {}, done: Promise.resolve() };',
  '});',
].join('\n');

/** A built production application whose SSR entry really streams. */
const streamingFixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-streaming-head-'));
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await mkdir(path.join(ssrRoot, '.vite'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/streaming-client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'streaming-client.js'), 'export const marker = "streaming";\n');
  await writeFile(path.join(ssrRoot, '.vite', 'ssr-manifest.json'), '{}');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return { root, clientRoot };
};

const config: TaujsConfig = {
  apps: [
    {
      appId: 'streaming-head-app',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [{ path: STREAM_PATH, attr: { render: 'streaming', meta: {} } }],
    },
  ],
  security: { csp: { directives: { 'default-src': [TAUJS_CSP_DIRECTIVE], 'script-src': ["'self'"] } } },
};

type Wire = { status: number; names: string[]; values: Map<string, string[]>; body: string };

/** Reads the response off a real socket, keeping repeated header lines distinct. */
const readWire = (port: number, url: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('error', reject);
      response.on('end', () => {
        const names: string[] = [];
        const values = new Map<string, string[]>();

        // rawHeaders is a flat [name, value, name, value, ...] list: one entry per line ON THE
        // WIRE, so a duplicated header survives here where a folded headers object hides it.
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          const name = response.rawHeaders[i]!.toLowerCase();
          names.push(name);
          values.set(name, [...(values.get(name) ?? []), response.rawHeaders[i + 1]!]);
        }

        resolve({ status: response.statusCode ?? 0, names, values, body });
      });
    });

    request.on('error', reject);
  });

describe('streaming head normalisation (real listener)', () => {
  it('does not introduce case-variant duplicates of pre-handoff headers on the wire', async () => {
    const { root, clientRoot } = await streamingFixture();
    const app = fastify({ logger: false });

    try {
      // An ordinary host policy header, established before the raw handoff exactly as the
      // documented recipe requires. τjs's own CSP plugin sets its header the same way.
      app.addHook('onRequest', (_request, reply, done) => {
        reply.header(HOST_POLICY_HEADER, HOST_POLICY_VALUE);
        done();
      });

      await createServer({ config, fastify: app, clientRoot });
      // Ephemeral port: a fixed one would collide with anything else on the machine.
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      const wire = await readWire(port, STREAM_PATH);

      expect(wire.status).toBe(200);

      // The renderer really streamed and the response terminal really ran.
      expect(wire.body).toContain('<main>streamed</main>');
      expect(wire.body).toContain('__INITIAL_DATA__');
      expect(wire.body).toContain('taujs:data-ready');

      // The defect: a CSP established before the handoff was emitted under two casings.
      expect(wire.values.get('content-security-policy')).toHaveLength(1);
      expect(wire.values.get('content-security-policy')?.[0]).toContain(TAUJS_CSP_DIRECTIVE);

      // Each single-valued header the head carries appears once, and its value survives the
      // normalisation. `content-type` is the head-write's own key; `x-host-policy` is the caller's
      // pre-handoff policy; `x-request-id` is τjs's request identity from the request context.
      expect(wire.values.get('content-type')).toHaveLength(1);
      expect(wire.values.get('content-type')?.[0]).toContain('text/html');
      expect(wire.values.get('x-host-policy')).toEqual([HOST_POLICY_VALUE]);
      expect(wire.values.get('x-request-id')).toHaveLength(1);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
