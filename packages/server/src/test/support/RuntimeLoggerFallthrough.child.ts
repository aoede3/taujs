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

  const response = await app.inject({
    method: 'GET',
    url: '/unmatched-page',
    headers: { 'x-trace-id': traceId },
  });
  const record = records.find((candidate) => candidate.message === 'Sending not-found fallback HTML');
  const result = {
    status: response.statusCode,
    responseTraceId: response.headers['x-trace-id'],
    record,
    recordCount: records.filter((candidate) => candidate.message === 'Sending not-found fallback HTML').length,
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
    record.bindings.url === '/unmatched-page' &&
    record.bindings.method === 'GET';

  process.exit(passed ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await app.close().catch(() => undefined);
  process.exit(1);
}
