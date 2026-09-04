// Type cells for the `serviceData` mapper's second argument, `ServiceDataRequestFacts` (RULED
// 2026-09-04, docs/followups/live/service-data-mapper-lacks-request-context.md): a two-argument
// mapper reads `facts.url` and `facts.headers` while route-param and service-param inference
// stays exact; existing one-argument mappers and mapper-free calls keep compiling unchanged; the
// facts view exposes no service caller and is read-only.
//
// Type-level test: enforced by `pnpm --filter @taujs/server typecheck` (tsc); the `.test-d.ts`
// suffix is outside vitest's test glob so it never runs as a spec.
import { expectTypeOf } from 'vitest';

import { createServiceData } from '../ServiceData';
import { defineService, defineServiceRegistry } from '../DataServices';

const catalogService = defineService({
  // specific params shape: the mapper must narrow route params (and facts) into it
  getProduct: async (params: { id: string }) => ({ product: { id: params.id } }),
  // broad params shape: accepts the route-params object, mapper may be omitted
  listSpecials: async (_params: {}) => ({ items: ['sku_1'] }),
});

const registry = defineServiceRegistry({ catalog: catalogService });
const serviceData = createServiceData<typeof registry>();

// --- (a) a two-argument mapper reads facts.url and facts.headers[...] while route-param and
// service-param inference stays exact. ---
const withFacts = serviceData('catalog', 'getProduct', (params, facts) => {
  expectTypeOf(params.id).toEqualTypeOf<string | string[] | undefined>();
  expectTypeOf(facts.url).toEqualTypeOf<string>();
  expectTypeOf(facts.headers['x-tenant']).toEqualTypeOf<string | undefined>();

  return { id: String(params.id) };
});
expectTypeOf(withFacts).not.toBeNever();

// --- (b) an existing one-argument mapper still type-checks: the extra runtime argument is
// optional in the callback signature, so ignoring it compiles unchanged. ---
const oneArgMapper = serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) }));
expectTypeOf(oneArgMapper).not.toBeNever();

// --- (c) mapper-free calls still type-check for a `{}`-params method, and are still rejected for
// a method whose params need a specific shape. ---
const passthrough = serviceData('catalog', 'listSpecials');
expectTypeOf(passthrough).not.toBeNever();

// @ts-expect-error mapper is required when the method's params need a specific shape
serviceData('catalog', 'getProduct');

// --- (d) NEGATIVE: the facts view has no service caller and is read-only. ---
serviceData('catalog', 'getProduct', (params, facts) => {
  // @ts-expect-error facts must not expose a service caller
  void facts.call;

  // @ts-expect-error facts is a read-only projection - url may not be reassigned
  facts.url = '/x';

  // @ts-expect-error facts is a read-only projection - headers may not be mutated
  facts.headers.host = 'x';

  return { id: String(params.id) };
});
