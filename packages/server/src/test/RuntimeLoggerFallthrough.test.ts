// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RESULT_PREFIX = 'TAUJS_FALLTHROUGH_LOGGER_RESULT=';

// Layered deadlines from a measured budget (2026-08-03): the child (real dev-server boot: Vite +
// compiler plugin + one request) completes in ~2.5s alone and ~5.1s worst-observed under the fully
// parallel suite's worker contention. The CHILD watchdog is the operative deadline at ~2x that
// worst case; the Vitest cap sits above it only so the child's ETIMEDOUT report - not a worker
// interrupt - is what a failure shows. spawnSync blocks the worker, so a Vitest cap below the child
// timeout could not fire reliably anyway.
const CHILD_TIMEOUT_MS = 10_000;
const VITEST_TIMEOUT_MS = 12_000;

describe('runtime logger fallthrough (real development server)', () => {
  it('sends a successful unmatched-page record through the selected request logger', { timeout: VITEST_TIMEOUT_MS }, () => {
    const fixtureRoot = fileURLToPath(new URL('../../../../fixtures/playground-react/', import.meta.url));
    const childScript = fileURLToPath(new URL('./support/RuntimeLoggerFallthrough.child.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', childScript], {
      cwd: fixtureRoot,
      env: { ...process.env, NODE_ENV: 'development' },
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    });

    const childTimedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    expect(
      childTimedOut,
      `the development child exceeded its ${CHILD_TIMEOUT_MS / 1000}s watchdog (measured budget: ~2.5s alone, ~5.1s under full-suite contention) - ` +
        `stderr tail: ${result.stderr?.slice(-500) ?? '(none)'}`,
    ).toBe(false);

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
