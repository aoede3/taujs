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
import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from '../CreateServer';
import {
  CALLER_REQUEST_ID,
  closeAll,
  createAdoptingHost,
  createCreatedHost,
  createEmbeddedHost,
  createNumericRequestIdHost,
  NUMERIC_REQUEST_ID,
  observe,
  PATHS,
} from './support/hostOwnership';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_INBOUND = 'sc09-inbound-abc-123';
const MALFORMED_INBOUND = '!!not a safe id!!';

afterEach(async () => {
  await closeAll();
});

describe('SC-09 identity matrix - τjs-created host (τjs genReqId)', () => {
  it('absent header: a generated UUID everywhere, unique per request', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);

    const first = observe(await host.app()!.inject(PATHS.taujsPage));
    const second = observe(await host.app()!.inject(PATHS.taujsPage));

    expect(first.requestId).toMatch(UUID);
    expect(second.requestId).toMatch(UUID);
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('valid header: the incoming value everywhere', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);

    const page = observe(await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(page.requestId).toBe(VALID_INBOUND);
  });

  it('malformed header: falls through to a generated UUID without weakening validation', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);

    const page = observe(await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': MALFORMED_INBOUND } }));

    expect(page.requestId).toMatch(UUID);
    expect(page.requestId).not.toBe(MALFORMED_INBOUND);
  });

  it('repeated headers arrive as an array and fail the string guard', async () => {
    const host = await createCreatedHost();
    await host.activate(createServer);

    const page = observe(
      await host.app()!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': [VALID_INBOUND, 'second-value'] as unknown as string } }),
    );

    expect(page.requestId).toMatch(UUID);
    expect(page.requestId).not.toBe(VALID_INBOUND);
  });
});

describe('SC-09 identity matrix - supplied host (caller policy)', () => {
  it('absent header: String(req.id) everywhere', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject(PATHS.taujsPage));

    expect(page.requestId).toBe(CALLER_REQUEST_ID);
  });

  it('valid header, host adopts it at construction: the incoming value everywhere', async () => {
    const host = await createAdoptingHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(page.requestId).toBe(VALID_INBOUND);
  });

  it('valid header, host ignores it: the host req.id everywhere - τjs never selects the header on its behalf', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': VALID_INBOUND } }));

    expect(page.requestId).toBe(CALLER_REQUEST_ID);
    expect(page.requestId).not.toBe(VALID_INBOUND);
  });

  it('malformed header on an adopting host: whatever valid req.id the host produced', async () => {
    const host = await createAdoptingHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': MALFORMED_INBOUND } }));

    expect(page.requestId).toBe(CALLER_REQUEST_ID);
  });

  it('a numeric req.id keeps textual identity across header and logs', async () => {
    const host = await createNumericRequestIdHost();
    await host.activate(createServer);

    const page = observe(await host.app.inject(PATHS.taujsPage));

    // The logger retains `reqId` in its native numeric type; the textual identity still agrees.
    expect(page.requestId).toBe(String(NUMERIC_REQUEST_ID));
    expect(JSON.stringify(host.logs)).toContain(String(NUMERIC_REQUEST_ID));
  });
});
