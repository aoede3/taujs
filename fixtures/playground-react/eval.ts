// Killer-demo eval (P1-04, Gate 1 acceptance + launch demo): boot the playground, break
// /product/999, and drive the MCP toolset to the diagnosis — the exact flow the
// taujs_skill_diagnose_broken_route skill teaches. Run with:
//   pnpm -r build && pnpm --filter playground-react eval
// NODE_ENV=development is set by the npm script (the structural dev gate is import-time).

import assert from 'node:assert/strict';

const transcript: string[] = [];
const step = (label: string, detail: string) => {
  transcript.push(`\n■ ${label}\n${detail}`);
  console.log(`\n■ ${label}\n${detail}`);
};

const Fastify = (await import('fastify')).default;
const { createServer } = await import('@taujs/server');
const config = (await import('./taujs.config.ts')).default;
const { serviceRegistry } = await import('./src/server/services/registry.ts');

// --- boot the playground on an ephemeral port ---
const app = Fastify({ logger: false });
app.decorate('authenticate', async () => {});
const { net } = await createServer({ config, serviceRegistry, fastify: app });
void net;
await app.listen({ host: '127.0.0.1', port: 0 });
const { port } = app.server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;
step('Boot', `playground listening on ${base} (NODE_ENV=${process.env.NODE_ENV})`);

// --- traffic: two healthy requests and the deterministic failure ---
for (const path of ['/', '/product/123', '/product/999', '/spa/anything']) {
  const res = await fetch(`${base}${path}`);
  transcript.push(`GET ${path} → ${res.status} (x-trace-id: ${res.headers.get('x-trace-id')})`);
  await res.text();
}
step('Traffic', 'requested /, /product/123, /product/999 (the broken one), /spa/anything');

// ring mirrors flush on a 500ms poll
await new Promise((r) => setTimeout(r, 1500));

// --- connect an MCP client to the real adapter over the real files ---
const { createTaujsMcpServer } = await import('@taujs/mcp');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const server = createTaujsMcpServer(process.cwd());
const client = new Client({ name: 'killer-demo-eval', version: '0.0.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as { text: string }[])[0]!.text);
};

// 1. Doctor sees the failure
const doctor = await call('taujs_doctor');
assert.equal(doctor.ok, true);
assert.equal(doctor.mode, 'active');
assert.equal(doctor.failedTraces.items.length, 1);
assert.match(doctor.failedTraces.items[0].error.message, /999/);
step('taujs_doctor', `mode=active; failed traces: ${doctor.failedTraces.items.length} — ${doctor.failedTraces.items[0].pathname}`);

// 2. Recent failed traces → the traceId
const failed = await call('taujs_get_recent_traces', { outcome: 'failed' });
assert.equal(failed.traces.items.length, 1);
const { traceId } = failed.traces.items[0];
// Head data (catalog.getProductHead) resolves before the shell, so it can precede the failing
// main-data call; assert the FAILED getProduct edge is present rather than assuming its position.
const failedServiceCall = failed.traces.items[0].serviceCalls.find((c: string) => /^catalog\.getProduct FAILED [\d.]+ms$/.test(c));
assert.ok(failedServiceCall, 'expected a catalog.getProduct FAILED entry in serviceCalls');
step('taujs_get_recent_traces {outcome:"failed"}', `traceId=${traceId}; serviceCalls=${JSON.stringify(failed.traces.items[0].serviceCalls)}`);

// 3. The full trace: exact failing edge + honest URL hygiene
const trace = await call('taujs_get_trace', { traceId });
assert.equal(trace.trace.outcome, 'failed');
assert.equal(trace.trace.route, '/product/:id');
assert.match(trace.trace.error.message, /Product 999 does not exist/);
const productCall = trace.trace.serviceCalls.find((c: { service: string; method: string }) => c.service === 'catalog' && c.method === 'getProduct');
assert.ok(productCall, 'expected a catalog.getProduct service call on the trace');
assert.equal(productCall.ok, false);
step('taujs_get_trace', `route=${trace.trace.route}; error=[${trace.trace.error.kind}] ${trace.trace.error.message}`);

// 4. Logs on demand (never embedded)
const logs = await call('taujs_get_trace_logs', { traceId });
assert.equal(logs.ok, true);
assert.ok(logs.logs.length >= 1, 'expected warn+ annex lines for the failed request');
step('taujs_get_trace_logs', `${logs.logs.length} warn+ line(s); first: "${logs.logs[0].msg}"`);

// 5. The declared edge behind the route
const explain = await call('taujs_explain_route', { routeId: 'playground-react:/product/:id' });
assert.equal(explain.explanations[0].data.service, 'catalog');
assert.equal(explain.explanations[0].data.method, 'getProduct');
assert.equal(explain.explanations[0].data.schema.params.kind, 'parse');
step('taujs_explain_route', `declared edge: catalog.getProduct (params schema: parse); render=${explain.explanations[0].render.strategy}`);

// 6. Blast radius, sources labelled
const who = await call('taujs_who_calls_service', { service: 'catalog', method: 'getProduct' });
const sources = new Set(who.edges.map((e: { source: string }) => e.source));
assert.ok(sources.has('declared') && sources.has('observed'), 'expected both declared and observed edges');
step(
  'taujs_who_calls_service',
  `${who.edges.length} edge(s); sources=${[...sources].join('+')} — diagnosis: catalog.getProduct throws for id "999" (PRODUCT_NOT_FOUND); only playground-react:/product/:id is affected.`,
);

await client.close();
await server.close();
await app.close();

console.log('\n✅ killer-demo eval passed: trace → edge → diagnosis, all from the substrate.');
process.exit(0);
