// HARD GATE on the PUBLIC ENTRY: this import comes from '../Config', exercising exactly what
// ships as '@taujs/server/config' - the internal `core/services/DataServices` module exporting
// the type cannot substitute. `ServiceRegistry` is the type `CreateServerOptions.serviceRegistry`
// is declared with (see CreateServer.ts); this pins it as a named export of the public config
// surface (followup: service-registry-type-not-exported).
// Enforced by `pnpm --filter @taujs/server typecheck` (tsc); the `.test-d.ts` suffix is outside
// vitest's test glob so it never runs as a spec.
import { expectTypeOf } from 'vitest';

import { defineService, defineServiceRegistry } from '../Config';

import type { ServiceDataRequestFacts, ServiceRegistry } from '../Config';

// --- (a) A `defineServiceRegistry({...})` value is assignable to the public `ServiceRegistry`. ---
const catalog = defineService({
  getProduct: async (params: { id: string }) => ({ id: params.id, price: 10 }),
});
const registry = defineServiceRegistry({ catalog });

expectTypeOf(registry).toMatchTypeOf<ServiceRegistry>();

// --- (b) A generic helper typed `<R extends ServiceRegistry>(r: R) => R` preserves the concrete
// registry's inferred method types exactly - no widening to the bare `ServiceRegistry` shape. ---
declare const identity: <R extends ServiceRegistry>(r: R) => R;
const roundTripped = identity(registry);

expectTypeOf(roundTripped).toEqualTypeOf<typeof registry>();
expectTypeOf(roundTripped.catalog.getProduct).toEqualTypeOf<typeof registry.catalog.getProduct>();

// --- (c) `ServiceDataRequestFacts` (RULED 2026-09-04) is a named export of the public config
// surface, not just the internal `core/services/ServiceData` module - a `serviceData` mapper's
// second-argument type is importable from '@taujs/server/config'. ---
declare const facts: ServiceDataRequestFacts;

expectTypeOf(facts.url).toEqualTypeOf<string>();
expectTypeOf(facts.headers).toEqualTypeOf<Readonly<Record<string, string>>>();
