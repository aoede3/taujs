// RFC 0004 (H1) - HARD GATE (ruling 7): `HeadDataOf<R>` must infer the ACTUAL selected service
// method result through `serviceData()` sugar - never the service DESCRIPTOR (the handler's
// honest runtime return), never `DataResult`, never a bare `Record<string, unknown>`.
//
// Type-level test in the vue contract.test-d.ts idiom: enforced by `pnpm --filter @taujs/server
// typecheck` (tsc); the `.test-d.ts` suffix is outside vitest's test glob so it never runs as a
// spec. Uses invariant-Equal (not mere assignability) so width-subtyping cannot fake a pass.
import { createServiceData } from '../../services/ServiceData';

import type { HeadDataOf } from '../types';
import type { ServiceDescriptor } from '../../services/DataServices';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type ProductHead = { sku: string; title: string };

type Registry = Readonly<{
  catalog: Readonly<{
    getProductHead: (params: { id: string }, ctx: any) => Promise<ProductHead>;
  }>;
}>;

const serviceData = createServiceData<Registry>();

// --- Arm 1: serviceData() sugar infers the SELECTED METHOD's resolved result (the brand). ---
const headRoute = {
  path: '/product/:id',
  attr: {
    render: 'streaming',
    meta: { title: 'static' },
    head: { data: serviceData('catalog', 'getProductHead', (p) => ({ id: String(p.id) })), timeoutMs: 3000 },
  },
} as const;

type _ServiceArm = Expect<Equal<HeadDataOf<typeof headRoute>, ProductHead>>;

// And explicitly NOT the descriptor (the callable's honest runtime return):
// @ts-expect-error - headData is the dispatched result, never the ServiceDescriptor
const _neverDescriptor: ServiceDescriptor = {} as HeadDataOf<typeof headRoute>;
void _neverDescriptor;

// --- Arm 2: a closure handler infers its own resolved return type. ---
const closureRoute = {
  path: '/legacy',
  attr: {
    render: 'ssr',
    head: { data: async () => ({ note: 'hand-written' }) },
  },
} as const;

type _ClosureArm = Expect<Equal<HeadDataOf<typeof closureRoute>, { note: string }>>;

// --- Arm 2b (gate-recheck): a MIXED closure return must keep the descriptor branch as
// Record<string, unknown> - never be silently narrowed to the direct-object member alone
// (the dispatched descriptor may resolve to any record). ---
const mixedRoute = {
  path: '/mixed',
  attr: {
    render: 'ssr',
    head: {
      data: async (params: { premium?: string }) =>
        params.premium ? { title: 'direct' } : ({ serviceName: 'catalog', serviceMethod: 'getProductHead', args: {} } as ServiceDescriptor),
    },
  },
} as const;

type _MixedArm = Expect<Equal<HeadDataOf<typeof mixedRoute>, { title: string } | Record<string, unknown>>>;

// And explicitly NOT the direct-object member alone:
type _MixedNotNarrowed = Expect<Equal<HeadDataOf<typeof mixedRoute> extends { title: string } ? true : false, false>>;

// --- Arm 3: no `attr.head` -> undefined. ---
const plainRoute = { path: '/', attr: { render: 'ssr' } } as const;

type _NoHeadArm = Expect<Equal<HeadDataOf<typeof plainRoute>, undefined>>;

// Keep tsc's noUnusedLocals honest.
export type _Proof = [_ServiceArm, _ClosureArm, _MixedArm, _MixedNotNarrowed, _NoHeadArm];
