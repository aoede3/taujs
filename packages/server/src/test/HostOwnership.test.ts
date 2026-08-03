// @vitest-environment node
//
// RFC 0010 permanent ownership regressions.
//
// > Bring your own Fastify and τjs respects it. Let τjs create Fastify and it provides the complete
// > experience.
//
// Every case drives the real public `createServer` path. These replace the disposable P0 and
// candidate proof matrices; the Fastify mechanics they rest on are pinned separately in
// `FastifyOwnershipArrangement.test.ts`.
//
// Deliberately not protected here: development Vite delegation and introspection, which need a real
// Vite server and are covered by the development suites; and cancellation, which RFC 0010 does not
// touch and whose existing matrices run unchanged.

import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from '../CreateServer';
import { AppError } from '../core/errors/AppError';
import {
  CALLER_ASSET,
  CALLER_ASSET_PATH,
  CALLER_CSP,
  CALLER_REQUEST_ID,
  NUMERIC_REQUEST_ID,
  OWNER,
  PATHS,
  TAUJS_ASSET_PATH,
  captureConsole,
  captureLogger,
  closeAll,
  createCreatedHost,
  createDefaultNotFoundHost,
  createEmbeddedHost,
  createExplicitLoggerHost,
  createNumericRequestIdHost,
  createStaticCoexistenceHost,
  createStrictHost,
  observe,
  taujsConfig,
} from './support/hostOwnership';

afterEach(async () => {
  await closeAll();
});

describe('RFC 0010 - caller-owned host', () => {
  it('leaves caller responses, errors and not-found exactly as the caller declared them', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    // Registered before and after τjs: ownership must not depend on registration order.
    const before = observe(await host.app.inject(PATHS.callerBefore));
    const after = observe(await host.app.inject(PATHS.callerAfter));
    const beforeError = observe(await host.app.inject(PATHS.callerBeforeError));
    const afterError = observe(await host.app.inject(PATHS.callerAfterError));
    const missing = observe(await host.app.inject('/rfc0010-missing'));

    expect(JSON.parse(before.body)).toEqual({ owner: OWNER.callerBefore });
    expect(JSON.parse(after.body)).toEqual({ owner: OWNER.callerAfter });
    expect({ status: before.status, type: before.type }).toEqual({ status: after.status, type: after.type });

    for (const errored of [beforeError, afterError]) {
      expect(errored.status).toBe(599);
      expect(JSON.parse(errored.body).owner).toBe(OWNER.callerError);
    }

    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).owner).toBe(OWNER.callerNotFound);
  });

  it('gives caller responses no τjs CSP and no τjs correlation header', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    for (const url of [PATHS.callerBefore, PATHS.callerAfter, '/rfc0010-missing']) {
      const response = observe(await host.app.inject(url));

      expect(response.csp).toBe(CALLER_CSP);
      expect(response.requestId).toBeUndefined();
    }
  });

  it('owns its own page responses: render, CSP, episode and error conversion', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject(PATHS.taujsPage));
    const failure = observe(await host.app.inject(PATHS.taujsFailure));

    expect(page.status).toBe(200);
    expect(page.body).toContain(`${OWNER.taujsPage}:${PATHS.taujsPage}`);
    expect(page.csp).toContain("default-src 'rfc0010-taujs'");
    expect(page.requestId).toBe(CALLER_REQUEST_ID);

    // τjs converts its own failures; the caller's 599 handler is not reached.
    expect(failure.status).toBe(500);
    expect(JSON.parse(failure.body).owner).toBeUndefined();
  });

  it('does not install an implicit shell: unmatched, API-like and unsupported-method requests stay the caller´s', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    const cases = [
      await host.app.inject({ method: 'GET', url: '/rfc0010-missing', headers: { accept: 'text/html' } }),
      await host.app.inject({ method: 'GET', url: '/api/rfc0010-missing', headers: { accept: 'application/json' } }),
      await host.app.inject({ method: 'POST', url: PATHS.taujsPage }),
    ];

    for (const response of cases.map(observe)) {
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body).owner).toBe(OWNER.callerNotFound);
    }
  });

  it('never becomes the not-found owner when the caller declared none', async () => {
    // The silent failure mode: Fastify keys not-found handlers by prefix, so a τjs scope registering
    // one would answer every unmatched URL on the caller's server.
    const host = await createDefaultNotFoundHost();
    await host.activate(createServer);

    const missing = observe(await host.app.inject('/rfc0010-missing'));

    expect(missing.status).toBe(404);
    expect(missing.type).toContain('application/json');
    expect(JSON.parse(missing.body)).toMatchObject({ error: 'Not Found', statusCode: 404 });
    expect(missing.body).not.toContain(OWNER.taujsPage);
    expect(missing.csp).toBeUndefined();
    expect(missing.requestId).toBeUndefined();
  });

  it('renders an explicitly declared terminal wildcard as an ordinary τjs page', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer, taujsConfig({ wildcard: true }));

    for (const url of ['/rfc0010-document', '/api/rfc0010', '/rfc0010-logo.png']) {
      const response = observe(await host.app.inject(url));

      expect(response.status).toBe(200);
      expect(response.body).toContain(`${OWNER.taujsPage}:${url}`);
    }
  });

  it('boots under allowErrorHandlerOverride: false without replacing the caller handler', async () => {
    const host = await createStrictHost();

    await expect(host.activate(createServer)).resolves.toBeTruthy();

    expect(JSON.parse(observe(await host.app.inject(PATHS.callerBeforeError)).body).owner).toBe(OWNER.callerError);
    expect(observe(await host.app.inject(PATHS.taujsFailure)).status).toBe(500);
  });

  it('writes no presentation to stdout and prefers an explicit logger', async () => {
    const host = await createExplicitLoggerHost();
    const output = captureConsole();

    try {
      await host.activate(createServer);
    } finally {
      output.restore();
    }

    expect(output.records).toEqual([]);
    expect(host.logs.length).toBeGreaterThan(0);
  });

  it('appears in the caller´s plugin tree: registration is visible, policy is not', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);
    await host.app.ready();

    expect(host.app.printPlugins()).toContain('τjs-ssr-server');
    // ...while owning nothing of the caller's lifecycle.
    expect(Object.prototype.hasOwnProperty.call(host.app, 'taujsIntrospection')).toBe(false);
  });

  it('fails at boot on an exact page collision rather than silently taking the route', async () => {
    const host = await createEmbeddedHost();
    host.app.get(PATHS.taujsPage, async () => ({ owner: OWNER.callerBefore }));

    await expect(host.activate(createServer)).rejects.toMatchObject({ code: 'FST_ERR_DUPLICATED_ROUTE' });
  });

  it('boots alongside a caller that already registered @fastify/static, and both facilities keep working', async () => {
    // P0's headline failure: τjs decorated `sendFile` on the caller root and this combination could
    // not boot at all. Encapsulation fixes it, but that is proved here rather than inferred.
    const host = await createStaticCoexistenceHost();

    await expect(host.activate(createServer)).resolves.toBeTruthy();

    const callerAsset = observe(await host.app.inject(CALLER_ASSET_PATH));
    const taujsAsset = observe(await host.app.inject(TAUJS_ASSET_PATH));
    const page = observe(await host.app.inject(PATHS.taujsPage));

    expect(callerAsset.status).toBe(200);
    expect(callerAsset.body).toContain(CALLER_ASSET);

    expect(taujsAsset.status).toBe(200);
    expect(taujsAsset.body).toContain(OWNER.taujsPage);

    expect(page.status).toBe(200);
    expect(page.body).toContain(`${OWNER.taujsPage}:${PATHS.taujsPage}`);
  });

  it('still fails at boot when caller static and a declared τjs wildcard claim the same route', async () => {
    // Kept separate and expected: `@fastify/static` defaults `wildcard` to true, claiming `GET /*`
    // on the caller root. A declared τjs `/*` page is then a genuine exact route collision, and
    // Fastify's router is global so encapsulation does not and should not hide it. The fix is
    // `wildcard: false` on the caller mount or non-overlapping patterns, never registration order.
    const host = await createStaticCoexistenceHost({ wildcard: true });

    await expect(host.activate(createServer, taujsConfig({ wildcard: true }))).rejects.toMatchObject({ code: 'FST_ERR_DUPLICATED_ROUTE' });
  });

  it('adopts the host request identity, including a numeric genReqId', async () => {
    // Correlation is the point: a caller's own records bind `reqId` and τjs echoes the same textual value as
    // `requestId`, so the two sides join. A counter-based `genReqId` returns a number, and a
    // string-only guard silently substituted a random UUID here.
    const host = await createNumericRequestIdHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject(PATHS.taujsPage));

    // Correlation is asserted after the failure leg because that record exists in every runtime
    // mode: a successful render only emits request-scoped DEBUG records, and since the single
    // runtime-mode derivation `NODE_ENV=test` runs as production, where the runtime logger sits at
    // minLevel `info`.
    observe(await host.app.inject(PATHS.taujsFailure));

    expect(page.requestId).toBe(String(NUMERIC_REQUEST_ID));
    expect(page.requestId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(JSON.stringify(host.logs)).toContain(String(NUMERIC_REQUEST_ID));
  });

  it('logs a real service-dispatch data failure once at the response boundary', async () => {
    const host = await createExplicitLoggerHost();
    const baseConfig = taujsConfig();
    const baseApp = baseConfig.apps[0]!;
    const route = '/rfc0010-service-failure';
    const config = {
      ...baseConfig,
      apps: [
        {
          ...baseApp,
          routes: [
            ...(baseApp.routes ?? []),
            {
              path: route,
              attr: { render: 'ssr' as const, data: async () => ({ serviceName: 'catalogue', serviceMethod: 'load', args: {} }) },
            },
          ],
        },
      ],
    };
    const logger = captureLogger(host.logs);

    await createServer({
      config,
      fastify: host.app,
      clientRoot: host.clientRoot,
      logger,
      debug: ['ssr'],
      serviceRegistry: {
        catalogue: {
          load: async () => {
            throw AppError.notFound('catalogue missing', undefined, 'E_CATALOGUE');
          },
        },
      } as any,
    });

    const response = observe(await host.app.inject(route));
    const requestRecords = host.logs.filter((record) => record.level === 'warn' || record.level === 'error');

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'catalogue missing', code: 'E_CATALOGUE', statusText: 'Not Found' });

    const serviceRecords = requestRecords.filter((record) => record.message === 'Service method failed');
    const responseRecords = requestRecords.filter((record) => (record.meta as any).component === 'fetch-initial-data');

    expect(serviceRecords).toHaveLength(1);
    expect(responseRecords).toHaveLength(1);
    expect(responseRecords[0]).toMatchObject({
      level: 'warn',
      meta: expect.objectContaining({ kind: 'domain', httpStatus: 404, code: 'E_CATALOGUE' }),
    });
    expect((responseRecords[0]!.meta as Record<string, unknown>).stack).toBeUndefined();
    expect(requestRecords).toHaveLength(2);
    expect(requestRecords.map((record) => record.message)).not.toContain('Critical rendering error during stream');
  });

  it('keeps route payloads out of the selected logger', async () => {
    const host = await createExplicitLoggerHost();
    await host.activate(createServer);

    const secret = observe(await host.app.inject(PATHS.taujsSecret));

    expect(secret.body).toContain(OWNER.taujsSecret);
    expect(JSON.stringify(host.logs)).not.toContain(OWNER.taujsSecret);
  });
});

describe('RFC 0010 - τjs-created host', () => {
  it('returns an app that is not yet listening and keeps the whole-server experience', async () => {
    const host = await createCreatedHost();
    const output = captureConsole();
    let result: { app?: unknown };

    try {
      result = await host.activate(createServer);
    } finally {
      output.restore();
    }

    const app = host.app()!;

    expect(result.app).toBe(app);
    expect(app.server.listening).toBe(false);
    // Presentation is a created-host convenience and stays.
    expect(output.records.some((record) => record.args.join(' ').includes('configured in'))).toBe(true);

    const page = observe(await app.inject(PATHS.taujsPage));
    const hostRoute = observe(await app.inject(PATHS.createdHost));

    expect(page.body).toContain(OWNER.taujsPage);
    // Routes the caller adds to the instance τjs created inherit whole-server CSP and episode.
    expect(hostRoute.csp).toContain("default-src 'rfc0010-taujs'");
    expect(hostRoute.requestId).toBeTruthy();
  });

  it('retains the implicit application shell for unmatched URLs', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);

    const missing = observe(await host.app()!.inject({ method: 'GET', url: '/rfc0010-missing', headers: { accept: 'text/html' } }));

    expect(missing.status).toBe(200);
    expect(missing.type).toContain('text/html');
  });
});
