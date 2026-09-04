// @vitest-environment node
//
// Reproduction and correction for `docs/followups/live/streaming-pre-shell-error-transform.md`: a
// real listener, modelled on `HostHookObservability.test.ts`, with the REAL `@fastify/compress`
// plugin (a devDependency added to this package solely for this file - see the entry's Direction).
//
// A route's `attr.data` throws `AppError.notFound(...)` before the shell byte on both render
// strategies. Streaming hands Fastify a COLD document `Readable`; when `attr.data` rejects,
// τjs's own streaming terminal (`HandleRender.ts`) re-throws the ORIGINAL `AppError` as the
// stream's 'error' - so the object Fastify's send pipeline sees is still the domain 404, until a
// payload transform sits between the document and the wire. `@fastify/compress`, registered with
// its default options exactly as a host would, is one such transform: it hands Fastify a
// zlib output stream in place of the document (`onSend`, `index.js`), and when the source errors,
// `pump` (the package it uses internally) destroys that output stream WITHOUT the original error
// (`pump/index.js`'s `destroyer`, `stream.destroy()` with no argument). Fastify's own `sendStream`
// then observes the zlib stream close before finishing and synthesises a generic
// `Error('premature close')` (`end-of-stream/index.js`), which is what used to reach τjs's error
// handler with the domain identity already gone.
//
// The correction (`docs/followups/live/streaming-pre-shell-error-transform-ruling.md`): a
// request-local, module-private slot records the original pre-commit failure in `failResponse`
// (`HandleRender.ts`); the scope error handler (`SSRServer.ts`) consults it only while
// `!reply.raw.headersSent` and the incoming error is not already an `AppError`, and clears any
// abandoned `content-encoding` before sending the replacement JSON envelope.
//
// SSR is included as a comparison, not because it is expected to reproduce the same failure: on
// this strategy `attr.data` is awaited BEFORE any payload exists (`HandleRender.ts`), so a rejection
// there is a plain promise rejection into Fastify's async-handler path, never a stream handed to
// `onSend` at all.

import http from 'node:http';
import { Transform } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import compress from '@fastify/compress';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from '../CreateServer';
import { AppError } from '../core/errors/AppError';
import { testRenderer } from './support/renderer';

import type { FastifyInstance } from 'fastify';
import type { TaujsConfig } from '../Config';

const STREAMING_PATH = '/notfound-streaming';
const SSR_PATH = '/notfound-ssr';
const OK_STREAMING_PATH = '/ok-streaming';
const UNRELATED_TRANSFORM_PATH = '/unrelated-transform-failure-streaming';

/**
 * Real render module (a written ESM file, loaded like production render modules), not a stubbed
 * function double: the mechanism under test is what τjs's OWN streaming terminal does with a
 * rejected `attr.data`, not a shortcut through it.
 *
 * `renderStream`'s third positional argument is `initialDataInput` - the same thunk
 * `HandleRender.ts` awaits directly for SSR. Real `@taujs/react`/`@taujs/vue` call this thunk and
 * route a rejection through `onError` with the untouched error (`packages/react/src/SSRRender.tsx`,
 * "the ORIGINAL error is the rejection reason"); this module reproduces exactly that contract so the
 * fixture exercises τjs's streaming terminal under the same rejection shape a real renderer produces,
 * without depending on React/Vue being installed in this package.
 */
const RENDER_MODULE = [
  "const tag = Symbol.for('taujs.render-contract/v1');",
  "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
  'export const renderSSR = brand(async () => ({ headContent: "", appHtml: "<main>ssr</main>" }));',
  'export const renderStream = brand((writable, callbacks, initialDataInput) => {',
  '  (async () => {',
  '    try {',
  '      await initialDataInput();',
  '      callbacks.onHead(\'<meta name="probe" content="taujs">\');',
  "      writable.write('<main>streamed</main>');",
  '      callbacks.onShellReady?.();',
  '      callbacks.onAllReady?.({});',
  '      writable.end();',
  '    } catch (err) {',
  '      callbacks.onError(err);',
  '    }',
  '  })();',
  '  return { abort() {}, done: Promise.resolve() };',
  '});',
].join('\n');

const fixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-pre-shell-transform-'));
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(ssrRoot, { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/pre-shell-client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'pre-shell-client.js'), 'export const marker = "pre-shell";\n');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return { root, clientRoot };
};

const config: TaujsConfig = {
  apps: [
    {
      appId: 'pre-shell-transform-app',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [
        {
          path: STREAMING_PATH,
          attr: {
            render: 'streaming',
            meta: {},
            data: () => {
              throw AppError.notFound('probe not found (streaming)');
            },
          },
        },
        {
          path: SSR_PATH,
          attr: {
            render: 'ssr',
            data: () => {
              throw AppError.notFound('probe not found (ssr)');
            },
          },
        },
        {
          // A healthy streaming route: no `attr.data` handler, so the document completes normally.
          // Used to prove (a) an unrelated payload-transform failure still gets its own 500, and
          // (b) a concurrent, unrelated request is never touched by another request's recorded
          // pre-commit failure.
          path: OK_STREAMING_PATH,
          attr: {
            render: 'streaming',
            meta: {},
          },
        },
        {
          path: UNRELATED_TRANSFORM_PATH,
          attr: {
            render: 'streaming',
            meta: {},
          },
        },
      ],
    },
  ],
};

type Wire = { status: number; contentEncoding: string | undefined; body: string };

/** Real socket, real client: decodes the body if `@fastify/compress` encoded it, same as a browser would. */
const readWire = (port: number, url: string, headers: Record<string, string> = {}): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const contentEncoding = response.headers['content-encoding'];
        const raw = Buffer.concat(chunks);
        let body: string;
        try {
          body =
            contentEncoding === 'gzip'
              ? zlib.gunzipSync(raw).toString('utf8')
              : contentEncoding === 'br'
                ? zlib.brotliDecompressSync(raw).toString('utf8')
                : contentEncoding === 'deflate'
                  ? zlib.inflateSync(raw).toString('utf8')
                  : raw.toString('utf8');
        } catch (err) {
          body = `<undecodable body under content-encoding=${String(contentEncoding)}: ${(err as Error).message}>`;
        }
        resolve({ status: response.statusCode ?? 0, contentEncoding, body });
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
    await Promise.all(apps.map((app) => app.close()));
  } finally {
    await Promise.all(dirs.map((root) => rm(root, { recursive: true, force: true })));
  }
});

/**
 * Caller-owned host, `@fastify/compress` registered globally with default options - exactly as
 * Hydrogen registers it. Also carries the `UNRELATED_TRANSFORM_PATH` `onSend` hook: a
 * hand-written payload transform, unrelated to compression, that errors on its first read - no
 * `attr.data` failure is ever involved on that path, so no pre-commit failure is ever recorded for
 * it.
 */
const boot = async (): Promise<{ port: number }> => {
  const { root, clientRoot } = await fixture();
  roots.push(root);

  const app = fastify({ logger: false });
  await app.register(compress);

  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.url !== UNRELATED_TRANSFORM_PATH || !(payload && typeof (payload as { pipe?: unknown }).pipe === 'function')) return payload;

    const failing = new Transform({
      transform(_chunk, _encoding, callback) {
        callback(new Error('unrelated payload transform failure'));
      },
    });

    (payload as NodeJS.ReadableStream).pipe(failing);

    return failing;
  });

  await createServer({ config, fastify: app, clientRoot });

  open.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  return { port: typeof address === 'object' && address !== null ? address.port : 0 };
};

describe('streaming-pre-shell-error-transform: pre-shell AppError.notFound through @fastify/compress', () => {
  it('control (no Accept-Encoding): a streaming route whose attr.data throws AppError.notFound arrives as 404 with the JSON envelope', async () => {
    const { port } = await boot();
    const wire = await readWire(port, STREAMING_PATH);

    expect(wire.contentEncoding).toBeUndefined();
    expect(wire.status).toBe(404);
    expect(JSON.parse(wire.body)).toMatchObject({ statusText: 'Not Found' });
  });

  it('compressed (Accept-Encoding: gzip): the SAME streaming pre-shell AppError.notFound still arrives as 404 with the original envelope and no Content-Encoding header', async () => {
    const { port } = await boot();
    const control = await readWire(port, STREAMING_PATH);
    const wire = await readWire(port, STREAMING_PATH, { 'accept-encoding': 'gzip' });

    // The abandoned `content-encoding: gzip` the compression plugin already declared must not
    // survive onto the replacement JSON body.
    expect(wire.contentEncoding).toBeUndefined();
    expect(wire.status).toBe(404);

    const body = JSON.parse(wire.body);
    expect(body).toEqual(JSON.parse(control.body));
    expect(body).toMatchObject({ statusText: 'Not Found' });
  });

  it('control (no Accept-Encoding): an SSR route whose attr.data throws AppError.notFound arrives as 404 with the JSON envelope', async () => {
    const { port } = await boot();
    const wire = await readWire(port, SSR_PATH);

    expect(wire.contentEncoding).toBeUndefined();
    expect(wire.status).toBe(404);
    expect(JSON.parse(wire.body)).toMatchObject({ statusText: 'Not Found' });
  });

  it('compressed (Accept-Encoding: gzip): the same SSR pre-render AppError.notFound - no stream exists yet, so no payload transform can intervene', async () => {
    const { port } = await boot();
    const wire = await readWire(port, SSR_PATH, { 'accept-encoding': 'gzip' });

    expect(wire.status).toBe(404);
    expect(JSON.parse(wire.body)).toMatchObject({ statusText: 'Not Found' });
  });

  it('an unrelated payload-transform failure (no pre-commit render failure recorded) still yields its own fresh 500, never a recorded error', async () => {
    const { port } = await boot();
    const wire = await readWire(port, UNRELATED_TRANSFORM_PATH);

    expect(wire.status).toBe(500);
    expect(JSON.parse(wire.body)).toMatchObject({ statusText: 'Internal Server Error' });
  });

  it('concurrent requests do not leak a recorded pre-commit failure: one 404 (recorded) and one 200 (unrecorded), both compressed, resolve independently', async () => {
    const { port } = await boot();

    const [failing, healthy] = await Promise.all([
      readWire(port, STREAMING_PATH, { 'accept-encoding': 'gzip' }),
      readWire(port, OK_STREAMING_PATH, { 'accept-encoding': 'gzip' }),
    ]);

    expect(failing.status).toBe(404);
    expect(failing.contentEncoding).toBeUndefined();
    expect(JSON.parse(failing.body)).toMatchObject({ statusText: 'Not Found' });

    // The healthy response is untouched by the other request's recorded failure: it completes as
    // its own normal 200 document, compressed as usual.
    expect(healthy.status).toBe(200);
    expect(healthy.contentEncoding).toBe('gzip');
    expect(healthy.body).toContain('<main>streamed</main>');
  });
});
