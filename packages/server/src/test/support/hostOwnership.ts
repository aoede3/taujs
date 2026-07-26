// RFC 0010 permanent ownership support.
//
// Deliberately smaller than the disposable candidate harness it descends from: named host factories
// rather than a free-form option vector, so a regression cannot quietly change the host it is
// measuring. Everything here drives the real public `createServer` path.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fastify from 'fastify';

import { testRenderer } from './renderer';

import type { FastifyInstance } from 'fastify';
import type { TaujsConfig } from '../../Config';
import type { BaseLogger } from '../../core/logging/types';
import type { createServer } from '../../CreateServer';

export type CreateServerFn = typeof createServer;

/** Fixed markers so a response names its owner rather than merely succeeding. */
export const OWNER = Object.freeze({
  callerBefore: 'RFC0010_CALLER_BEFORE',
  callerAfter: 'RFC0010_CALLER_AFTER',
  callerError: 'RFC0010_CALLER_ERROR',
  callerNotFound: 'RFC0010_CALLER_NOT_FOUND',
  createdHost: 'RFC0010_CREATED_HOST',
  taujsPage: 'RFC0010_TAUJS_PAGE',
  taujsSecret: 'RFC0010_LOG_SECRET',
});

export const PATHS = Object.freeze({
  callerBefore: '/host-before',
  callerAfter: '/host-after',
  callerBeforeError: '/host-before-error',
  callerAfterError: '/host-after-error',
  createdHost: '/created-host',
  taujsPage: '/taujs-page',
  taujsFailure: '/taujs-failure',
  taujsSecret: '/taujs-secret',
  taujsNoCsp: '/taujs-no-csp',
});

export const CALLER_CSP = "default-src 'rfc0010-caller'";
export const TAUJS_CSP_DIRECTIVE = "default-src 'rfc0010-taujs'";
export const CALLER_REQUEST_ID = 'rfc0010-caller-request-id';
/** A numeric request identity, which `genReqId` may legitimately return. */
export const NUMERIC_REQUEST_ID = 4242;

export type Observation = {
  status: number;
  type: string | undefined;
  body: string;
  csp: string | undefined;
  traceId: string | undefined;
};

const header = (value: string | string[] | number | undefined): string | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value.join(', ') : String(value);

const normaliseNonce = (value: string | undefined): string | undefined =>
  value
    ?.replace(/'nonce-[^']+'/g, "'nonce-<normalised>'")
    .replace(/nonce="[^"]+"/g, 'nonce="<normalised>"')
    .replace(/nonce-[A-Za-z0-9+/=]+/g, 'nonce-<normalised>');

export const observe = (response: { statusCode: number; body: string; headers: Record<string, string | string[] | number | undefined> }): Observation => ({
  status: response.statusCode,
  type: header(response.headers['content-type']),
  body: normaliseNonce(response.body) ?? response.body,
  csp: normaliseNonce(header(response.headers['content-security-policy'])),
  traceId: header(response.headers['x-trace-id']),
});

export type CapturedLog = { level: string; meta: unknown; message: string | undefined };

export const captureLogger = (records: CapturedLog[], bindings: Record<string, unknown> = {}): BaseLogger => {
  const logger: BaseLogger = {};

  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logger[level] = (meta?: unknown, message?: string) => {
      const objectMeta = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : { value: meta };

      records.push({ level, meta: { ...bindings, ...objectMeta }, message });
    };
  }
  logger.child = (childBindings) => captureLogger(records, { ...bindings, ...childBindings });

  return logger;
};

export const captureConsole = (): { records: Array<{ level: string; args: unknown[] }>; restore: () => void } => {
  const records: Array<{ level: string; args: unknown[] }> = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  let restored = false;

  console.log = (...args: unknown[]) => records.push({ level: 'log', args });
  console.warn = (...args: unknown[]) => records.push({ level: 'warn', args });
  console.error = (...args: unknown[]) => records.push({ level: 'error', args });

  return {
    records,
    restore: () => {
      if (restored) return;
      restored = true;
      Object.assign(console, original);
    },
  };
};

const RENDER_MODULE = [
  "const tag = Symbol.for('taujs.render-contract/v1');",
  "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
  `export const renderSSR = brand(async (_data, location) => ({ headContent: '<meta name="rfc0010" content="taujs">', appHtml: \`<main>${OWNER.taujsPage}:\${location}</main>\` }));`,
  'export const renderStream = brand(() => ({ abort() {}, done: Promise.resolve() }));',
].join('\n');

const roots: string[] = [];

/** A built production application: manifest, client asset and a branded server entry. */
export const productionFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-rfc0010-'));
  roots.push(root);
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await mkdir(path.join(ssrRoot, '.vite'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/rfc0010-client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'rfc0010-client.js'), `export const marker = ${JSON.stringify(OWNER.taujsPage)};\n`);
  await writeFile(path.join(ssrRoot, '.vite', 'ssr-manifest.json'), '{}');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return clientRoot;
};

/**
 * A development source application: real client and server entries for Vite to transform.
 *
 * Returns the project root as well, because boot-graph emission writes beneath `process.cwd()` and
 * the development proof chdirs here so the artefact is observable and disposable.
 */
export const developmentFixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-rfc0010-dev-'));
  roots.push(root);
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');

  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, 'entry-client.ts'), `export const marker = ${JSON.stringify(OWNER.taujsPage)};\n`);
  await writeFile(path.join(appRoot, 'entry-server.ts'), RENDER_MODULE);

  return { root, clientRoot };
};

export const disposeFixtures = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
};

export const taujsConfig = ({ globalCsp = true, wildcard = false }: { globalCsp?: boolean; wildcard?: boolean } = {}): TaujsConfig => ({
  apps: [
    {
      appId: 'rfc0010-app',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [
        { path: PATHS.taujsPage, attr: { render: 'ssr' } },
        { path: PATHS.taujsSecret, attr: { render: 'ssr', data: async () => ({ token: OWNER.taujsSecret }) } },
        {
          path: PATHS.taujsFailure,
          attr: {
            render: 'ssr',
            data: async () => {
              throw new Error('rfc0010-route-failure');
            },
          },
        },
        { path: PATHS.taujsNoCsp, attr: { render: 'ssr', middleware: { csp: false } } },
        ...(wildcard ? [{ path: '/*', attr: { render: 'ssr' as const } }] : []),
      ],
    },
  ],
  ...(globalCsp ? { security: { csp: { directives: { 'default-src': ["'rfc0010-taujs'"], 'script-src': ["'self'"] } } } } : {}),
});

const openApps = new Set<FastifyInstance>();

/** Teardown backstop: closes anything a test left open, then removes every temporary fixture. */
export const closeAll = async (): Promise<void> => {
  const apps = [...openApps];
  openApps.clear();

  await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
  await disposeFixtures();
};

const track = <T extends FastifyInstance>(app: T): T => {
  openApps.add(app);

  return app;
};

export type CallerHost = {
  app: FastifyInstance;
  clientRoot: string;
  logs: CapturedLog[];
  activate: (register: CreateServerFn, config?: TaujsConfig) => Promise<unknown>;
  close: () => Promise<void>;
};

type CallerHostShape = {
  strictErrorHandler?: boolean;
  callerNotFound?: boolean;
  callerCsp?: boolean;
  explicitLogger?: boolean;
  numericRequestId?: boolean;
};

const buildCallerHost = async (shape: CallerHostShape): Promise<CallerHost> => {
  const clientRoot = await productionFixture();
  const logs: CapturedLog[] = [];
  const app = track(
    fastify({
      logger: false,
      genReqId: shape.numericRequestId ? () => NUMERIC_REQUEST_ID as unknown as string : () => CALLER_REQUEST_ID,
      ...(shape.strictErrorHandler ? { allowErrorHandlerOverride: false } : {}),
    }),
  );

  app.decorate('authenticate', async () => undefined);

  if (shape.callerCsp !== false) {
    app.addHook('onRequest', (_request, reply, done) => {
      reply.header('Content-Security-Policy', CALLER_CSP);
      done();
    });
  }

  app.get(PATHS.callerBefore, async () => ({ owner: OWNER.callerBefore }));
  app.get(PATHS.callerBeforeError, async () => {
    throw new Error(`${OWNER.callerError}:before`);
  });
  app.setErrorHandler(async (error: Error, _request, reply) =>
    reply.status(599).type('application/json').send({ owner: OWNER.callerError, message: error.message }),
  );

  if (shape.callerNotFound !== false) {
    app.setNotFoundHandler(async (_request, reply) => reply.status(404).type('application/json').send({ owner: OWNER.callerNotFound }));
  }

  return {
    app,
    clientRoot,
    logs,
    activate: async (register, config) => {
      const result = await register({
        config: config ?? taujsConfig(),
        fastify: app,
        clientRoot,
        debug: ['ssr'],
        ...(shape.explicitLogger ? { logger: captureLogger(logs) } : {}),
      });

      app.get(PATHS.callerAfter, async () => ({ owner: OWNER.callerAfter }));
      app.get(PATHS.callerAfterError, async () => {
        throw new Error(`${OWNER.callerError}:after`);
      });

      return result;
    },
    close: async () => {
      openApps.delete(app);
      await app.close();
    },
  };
};

/** An ordinary caller-owned host: its own CSP, error handler, not-found handler and routes. */
export const createEmbeddedHost = (): Promise<CallerHost> => buildCallerHost({});

/** A caller-owned host under Fastify's strict error-handler policy. */
export const createStrictHost = (): Promise<CallerHost> => buildCallerHost({ strictErrorHandler: true });

/** A caller-owned host passing an explicit τjs logger, which must win over any Fastify logger. */
export const createExplicitLoggerHost = (): Promise<CallerHost> => buildCallerHost({ explicitLogger: true });

/**
 * A caller-owned host whose `genReqId` returns a number.
 *
 * τjs adopts the host's request identity so both sides' records join on one value. A string-only
 * guard used to fall through to a random UUID here, silently breaking that correlation, which is
 * exactly the case a counter-based `genReqId` produces.
 */
export const createNumericRequestIdHost = (): Promise<CallerHost> => buildCallerHost({ numericRequestId: true, explicitLogger: true });

/**
 * A caller-owned host with NO not-found handler of its own, and no caller static mount.
 *
 * The most common real embedding, and the one silent failure mode in the design: Fastify keys
 * not-found handlers by prefix, so a τjs scope registering one would become the 404 owner for the
 * entire server. Caller static is omitted deliberately - a wildcard-enabled `@fastify/static` would
 * answer unmatched URLs itself and mask what this host exists to measure.
 */
export const createDefaultNotFoundHost = (): Promise<CallerHost> => buildCallerHost({ callerNotFound: false, callerCsp: false });

export const CALLER_ASSET = 'RFC0010_CALLER_ASSET';
export const CALLER_ASSET_PATH = '/caller-asset.txt';
/** τjs's own production static facility serves the client build from the fixture manifest. */
export const TAUJS_ASSET_PATH = '/app/assets/rfc0010-client.js';

/**
 * A caller-owned host that has ALREADY registered real `@fastify/static` before τjs.
 *
 * P0 proved this combination could not boot: τjs decorated `sendFile` on the caller root and
 * collided. The regression exists because that was a headline failure, so architectural inference
 * is not good enough.
 *
 * `wildcard` is the caller's choice and matters: `@fastify/static` defaults it to `true`, which
 * claims `GET /*` on the caller root and will collide with a declared τjs `/*` page.
 */
export const createStaticCoexistenceHost = async ({ wildcard = false }: { wildcard?: boolean } = {}): Promise<CallerHost> => {
  const host = await buildCallerHost({});
  const assetRoot = await mkdtemp(path.join(os.tmpdir(), 'taujs-rfc0010-caller-assets-'));
  roots.push(assetRoot);

  await writeFile(path.join(assetRoot, 'caller-asset.txt'), `${CALLER_ASSET}\n`);

  const fastifyStatic = await import('@fastify/static');
  await host.app.register(fastifyStatic.default, { root: assetRoot, prefix: '/', wildcard, index: false });

  return host;
};

export type CreatedHost = {
  app: () => FastifyInstance | undefined;
  clientRoot: string;
  activate: (register: CreateServerFn, config?: TaujsConfig) => Promise<{ app?: FastifyInstance }>;
  close: () => Promise<void>;
};

/** τjs creates the Fastify instance: the complete experience. */
export const createCreatedHost = async (): Promise<CreatedHost> => {
  const clientRoot = await productionFixture();
  let created: FastifyInstance | undefined;

  return {
    app: () => created,
    clientRoot,
    activate: async (register, config) => {
      const result = await register({ config: config ?? taujsConfig(), clientRoot, debug: ['ssr'] });
      created = result.app;

      if (created) {
        track(created);
        created.get(PATHS.createdHost, async () => ({ owner: OWNER.createdHost }));
      }

      return result;
    },
    close: async () => {
      if (!created) return;
      openApps.delete(created);
      await created.close();
    },
  };
};
