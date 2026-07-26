import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import config from '../../../../../fixtures/playground-react/taujs.config.ts';
import { serviceRegistry } from '../../../../../fixtures/playground-react/src/server/services/registry.ts';
import { createServer } from '../../CreateServer.ts';

import type { TaujsConfig } from '../../Config.ts';
import type { BaseLogger } from '../../core/logging/types.ts';

const RESULT_PREFIX = 'TAUJS_FALLTHROUGH_LOGGER_RESULT=';
const fixtureRoot = fileURLToPath(new URL('../../../../../fixtures/playground-react/', import.meta.url));
process.chdir(fixtureRoot);

const records: Array<{
  level: string;
  bindings: Record<string, unknown>;
  meta: Record<string, unknown>;
  message: string;
}> = [];

const captureLogger = (bindings: Record<string, unknown> = {}): BaseLogger => ({
  debug(meta, message) {
    records.push({ level: 'debug', bindings, meta: meta as Record<string, unknown>, message: message ?? '' });
  },
  info(meta, message) {
    records.push({ level: 'info', bindings, meta: meta as Record<string, unknown>, message: message ?? '' });
  },
  warn(meta, message) {
    records.push({ level: 'warn', bindings, meta: meta as Record<string, unknown>, message: message ?? '' });
  },
  error(meta, message) {
    records.push({ level: 'error', bindings, meta: meta as Record<string, unknown>, message: message ?? '' });
  },
  child(childBindings) {
    return captureLogger({ ...bindings, ...childBindings });
  },
});

const traceId = 'fallthrough-selected-logger-trace';
const app = Fastify({ logger: false, genReqId: () => 'fallthrough-fastify-request' });
app.decorate('authenticate', async () => undefined);

try {
  await createServer({
    // The external fixture carries the packed @taujs/server renderer brand; this source-package
    // test intentionally crosses that built/source boundary while exercising the same runtime value.
    config: config as unknown as TaujsConfig,
    serviceRegistry,
    fastify: app,
    logger: captureLogger(),
    debug: ['ssr'],
    projectRoot: fixtureRoot,
  });

  // RFC 0010: this child supplies its own Fastify, so τjs owns only its declared page routes. The
  // logger-lineage evidence therefore rides a τjs-owned response rather than the implicit shell,
  // which a caller-owned host no longer installs.
  const response = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-trace-id': traceId },
  });
  const record = records.find((candidate) => candidate.message === 'ssr requested');

  // The same request matrix now also proves the ruled ownership delta: an unmatched URL is the
  // caller's, gets no τjs shell and opens no τjs trace episode.
  const unmatched = await app.inject({ method: 'GET', url: '/unmatched-page', headers: { 'x-trace-id': traceId } });

  const result = {
    status: response.statusCode,
    responseTraceId: response.headers['x-trace-id'],
    record,
    recordCount: records.filter((candidate) => candidate.message === 'ssr requested').length,
    unmatchedStatus: unmatched.statusCode,
    unmatchedTraceId: unmatched.headers['x-trace-id'],
  };

  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  await app.close();

  const passed =
    result.status === 200 &&
    result.responseTraceId === traceId &&
    result.recordCount === 1 &&
    record?.level === 'debug' &&
    record.bindings.traceId === traceId &&
    record.bindings.reqId === 'fallthrough-fastify-request' &&
    record.bindings.url === '/' &&
    record.bindings.method === 'GET' &&
    result.unmatchedStatus === 404 &&
    result.unmatchedTraceId === undefined;

  process.exit(passed ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await app.close().catch(() => undefined);
  process.exit(1);
}
