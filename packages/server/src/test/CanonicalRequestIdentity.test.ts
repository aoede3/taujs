// @vitest-environment node
//
// SC-09 frozen identity matrix. Fastify `req.id` is the canonical request-correlation identity in
// both host modes; τjs adopts `String(req.id)` everywhere it names a request and never
// reinterprets an inbound `x-request-id` after Fastify has created the request. Header adoption is
// a construction-time decision: τjs's own validating `genReqId` on a created host, the caller's
// policy on a supplied one. Every row drives the real public `createServer` path.
//
// | Host     | Incoming header        | Fastify policy | Expected identity                        |
// | Created  | absent                 | τjs genReqId   | generated UUID everywhere                |
// | Created  | valid                  | τjs genReqId   | incoming value everywhere                |
// | Created  | malformed              | τjs genReqId   | generated UUID everywhere                |
// | Supplied | absent                 | caller policy  | String(req.id) everywhere                |
// | Supplied | valid, host adopts it  | caller policy  | incoming value everywhere                |
// | Supplied | valid, host ignores it | caller policy  | host req.id everywhere                   |
// | Supplied | malformed              | caller policy  | whatever valid req.id the host produced  |
//
// What THIS file proves, exactly: for every row, the three-way textual equality
// `String(req.id)` = request-context `requestId` = response `x-request-id` (both server-side
// values captured per request by a root onSend hook), plus the `reqId` log binding for
// representative string and numeric supplied legs, plus the negative migration legs (inbound
// `x-trace-id` ignored, no `x-trace-id` response header). These hosts are production fixtures, so
// the development-only recorder is absent here BY DESIGN: the recorder-key legs (an episode keyed
// by the same canonical identity on real development boots, created and supplied) live in
// `HostOwnershipDevelopment.test.ts`, and the beacon and log-annex keying in the introspection
// suites.
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../core/errors/AppError';
import { createServer } from '../CreateServer';
import {
  CALLER_REQUEST_ID,
  captureLogger,
  closeAll,
  createAdoptingHost,
  createCreatedHost,
  createEmbeddedHost,
  createExplicitLoggerHost,
  createNumericRequestIdHost,
  NUMERIC_REQUEST_ID,
  observe,
  PATHS,
  taujsConfig,
} from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_INBOUND = 'sc09-inbound-abc-123';
const MALFORMED_INBOUND = '!!not a safe id!!';

type IdentityCapture = { fastifyId: unknown; contextRequestId: string | undefined };

// Root-level capture of the two server-side identities every row must join on. onSend observes
// τjs responses in both host modes, and the request decoration is visible from the root because
// Fastify shares the request object across scopes.
const captureIdentities = (app: FastifyInstance): IdentityCapture[] => {
  const captured: IdentityCapture[] = [];

  app.addHook('onSend', (req, _reply, payload, done) => {
    captured.push({
      fastifyId: req.id,
      contextRequestId: (req as { taujsRequestContext?: { requestId?: string } }).taujsRequestContext?.requestId,
    });
    done(null, payload);
  });

  return captured;
};

// The row invariant: one textual identity end to end.
const expectOneIdentity = (page: { requestId: string | undefined }, captured: IdentityCapture[]) => {
  expect(captured).toHaveLength(1);
  const seen = captured[0]!;

  expect(String(seen.fastifyId)).toBe(page.requestId);
  expect(seen.contextRequestId).toBe(page.requestId);

  return page.requestId!;
};

afterEach(async () => {
  await closeAll();
});

describe('SC-09 identity matrix - τjs-created host (τjs genReqId)', () => {
  it('absent header: a generated UUID everywhere, unique per request', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app()!);

    const first = observe(await host.app()!.inject(PATHS.taujsPage));
    const second = observe(await host.app()!.inject(PATHS.taujsPage));

    expect(first.requestId).toMatch(UUID);
    expect(second.requestId).toMatch(UUID);
    expect(first.requestId).not.toBe(second.requestId);
    expect(captured).toHaveLength(2);
    expect(String(captured[0]!.fastifyId)).toBe(first.requestId);
    expect(captured[0]!.contextRequestId).toBe(first.requestId);
    expect(String(captured[1]!.fastifyId)).toBe(second.requestId);
    expect(captured[1]!.contextRequestId).toBe(second.requestId);
  });

  it('valid header: the incoming value everywhere', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app()!);

    const page = observe(await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(expectOneIdentity(page, captured)).toBe(VALID_INBOUND);
  });

  it('malformed header: falls through to a generated UUID without weakening validation', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app()!);

    const page = observe(await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': MALFORMED_INBOUND } }));

    expect(page.requestId).toMatch(UUID);
    expect(page.requestId).not.toBe(MALFORMED_INBOUND);
    expectOneIdentity(page, captured);
  });

  it('repeated headers arrive as an array and fail the string guard', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app()!);

    const page = observe(
      await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': [VALID_INBOUND, 'second-value'] as unknown as string } }),
    );

    expect(page.requestId).toMatch(UUID);
    expect(page.requestId).not.toBe(VALID_INBOUND);
    expectOneIdentity(page, captured);
  });

  it('legacy x-trace-id is neither adopted nor emitted (removal leg)', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app()!);

    const response = await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-trace-id': 'legacy-correlation-1' } });
    const page = observe(response);

    expect(page.requestId).toMatch(UUID);
    expect(page.requestId).not.toBe('legacy-correlation-1');
    expect(response.headers['x-trace-id']).toBeUndefined();
    expectOneIdentity(page, captured);
  });
});

describe('SC-09 identity matrix - supplied host (caller policy)', () => {
  it('absent header: String(req.id) everywhere', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject(PATHS.taujsPage));

    expect(expectOneIdentity(page, captured)).toBe(CALLER_REQUEST_ID);
  });

  it('valid header, host adopts it at construction: the incoming value everywhere', async () => {
    const host = await createAdoptingHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(expectOneIdentity(page, captured)).toBe(VALID_INBOUND);
  });

  it('valid header, host ignores it: the host req.id everywhere - τjs never selects the header on its behalf', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(page.requestId).not.toBe(VALID_INBOUND);
    expect(expectOneIdentity(page, captured)).toBe(CALLER_REQUEST_ID);
  });

  it('malformed header on an adopting host: whatever valid req.id the host produced', async () => {
    const host = await createAdoptingHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': MALFORMED_INBOUND } }));

    expect(expectOneIdentity(page, captured)).toBe(CALLER_REQUEST_ID);
  });

  it('legacy x-trace-id is neither adopted nor emitted (removal leg)', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const response = await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-trace-id': 'legacy-correlation-2' } });
    const page = observe(response);

    expect(response.headers['x-trace-id']).toBeUndefined();
    expect(expectOneIdentity(page, captured)).toBe(CALLER_REQUEST_ID);
  });

  it('a string req.id reaches the log binding as the Fastify-native reqId', async () => {
    const host = await createExplicitLoggerHost();
    await host.activate(createServer);
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject(PATHS.taujsPage));

    expect(expectOneIdentity(page, captured)).toBe(CALLER_REQUEST_ID);

    // The binding is proven on a record that exists in EVERY runtime mode. A successful render
    // emits only request-scoped debug records, and debug is a development facility: since the
    // single runtime-mode derivation, `NODE_ENV=test` runs as production, so the runtime logger
    // sits at minLevel `info`. The failure leg emits at error level through the same
    // request-scoped logger, which is where correlation actually earns its keep - and it matches
    // the numeric leg below, which has always proven the binding this way.
    observe(await host.app.inject(PATHS.taujsFailure));

    expect(host.logs.some((record) => (record.meta as Record<string, unknown>).reqId === CALLER_REQUEST_ID)).toBe(true);
  });

  it('a numeric req.id keeps its native type in EVERY identity-bearing record, service dispatch included', async () => {
    const host = await createNumericRequestIdHost();
    const baseConfig = taujsConfig();
    const baseApp = baseConfig.apps[0]!;
    const route = '/sc09-numeric-service';
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

    await createServer({
      config,
      fastify: host.app,
      clientRoot: host.clientRoot,
      logger: captureLogger(host.logs),
      debug: ['ssr'],
      // The failure path logs through the service-dispatch child at warn, so a service-call
      // record reliably reaches the sink regardless of debug admission.
      serviceRegistry: {
        catalogue: {
          load: async () => {
            throw AppError.notFound('catalogue missing', undefined, 'E_CATALOGUE');
          },
        },
      } as any,
    });
    const captured = captureIdentities(host.app);

    const page = observe(await host.app.inject(route));

    expect(page.status).toBe(404);
    expect(expectOneIdentity(page, captured)).toBe(String(NUMERIC_REQUEST_ID));

    // `reqId` has ONE meaning and ONE representation: every record that carries it holds the
    // number the host generated - `logs.some` would let a single correct record mask a stringified
    // sibling, so every identity-bearing record is checked, and the service-dispatch child must be
    // among them (identity inherited through lineage, never rebound).
    const identityRecords = host.logs.filter((record) => 'reqId' in (record.meta as Record<string, unknown>));
    expect(identityRecords.length).toBeGreaterThan(0);
    for (const record of identityRecords) {
      expect((record.meta as Record<string, unknown>).reqId).toBe(NUMERIC_REQUEST_ID);
    }
    expect(identityRecords.some((record) => (record.meta as Record<string, unknown>).component === 'service-call')).toBe(true);

    // And no log record smuggles the identity under the episode-record field name.
    for (const record of host.logs) {
      expect(record.meta as Record<string, unknown>).not.toHaveProperty('requestId');
    }
  });
});
