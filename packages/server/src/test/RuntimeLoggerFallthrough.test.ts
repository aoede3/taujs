// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RESULT_PREFIX = 'TAUJS_FALLTHROUGH_LOGGER_RESULT=';

describe('runtime logger fallthrough (real development server)', () => {
  it('sends a successful unmatched-page record through the selected request logger', () => {
    const fixtureRoot = fileURLToPath(new URL('../../../../fixtures/playground-react/', import.meta.url));
    const childScript = fileURLToPath(new URL('./support/RuntimeLoggerFallthrough.child.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', childScript], {
      cwd: fixtureRoot,
      env: { ...process.env, NODE_ENV: 'development' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(
      {
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      'the real createServer() development child must complete cleanly',
    ).toMatchObject({ status: 0, signal: null, error: undefined });

    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(RESULT_PREFIX));
    expect(line, 'the child must emit its structured result').toBeTruthy();

    const evidence = JSON.parse(line!.slice(RESULT_PREFIX.length));
    expect(evidence).toMatchObject({
      status: 200,
      // SC-09: the caller's genReqId ignored the inbound header, so the host req.id is the
      // identity everywhere - τjs neither adopts nor echoes the header on the host's behalf.
      responseRequestId: 'fallthrough-fastify-request',
      recordCount: 1,
      record: {
        level: 'debug',
        bindings: {
          reqId: 'fallthrough-fastify-request',
          url: '/',
          method: 'GET',
        },
        meta: { category: 'ssr' },
        message: 'ssr requested',
      },
      // RFC 0010 (Q5/Q6) delta: the child supplies its own Fastify, so an unmatched URL belongs to
      // the caller. It previously received a τjs 200 shell and a τjs response header; it now falls
      // to the caller's own not-found policy and opens no τjs episode.
      unmatchedStatus: 404,
    });
    expect(evidence.record.bindings.requestId).toBeUndefined();
    expect(evidence.unmatchedRequestId).toBeUndefined();
  });
});
