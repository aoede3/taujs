// RFC 0007 - HARD GATE, mirroring `HeadDataOf.test-d.ts`: `DeferredDataOf<R>` must infer each
// declared key's payload from the route config alone, so a renderer's accessor is typeable from
// `typeof config` without re-declaring a payload shape.
//
// Type-level test: enforced by `pnpm --filter @taujs/server typecheck` (tsc); the `.test-d.ts`
// suffix is outside vitest's test glob so it never runs as a spec. Invariant-Equal (not mere
// assignability) so width-subtyping cannot fake a pass.
import { createServiceData } from '../../services/ServiceData';

import type { DeferredDataOf } from '../types';
import type { ServiceDescriptor } from '../../services/DataServices';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Reviews = { count: number; top: string };
type Stock = { available: boolean };

type Registry = Readonly<{
  reviews: Readonly<{
    forProduct: (params: { id: string }, ctx: any) => Promise<Reviews>;
  }>;
  inventory: Readonly<{
    stock: (params: { id: string }, ctx: any) => Promise<Stock>;
  }>;
}>;

const serviceData = createServiceData<Registry>();

// --- Arm 1: serviceData() sugar infers the SELECTED METHOD's resolved result (the brand),
// per key, including a NON-DEFAULT result type. ---
const productRoute = {
  path: '/product/:id',
  attr: {
    render: 'streaming',
    meta: {},
    data: serviceData('reviews', 'forProduct', (p) => ({ id: String(p.id) })),
    deferred: {
      reviews: serviceData('reviews', 'forProduct', (p) => ({ id: String(p.id) })),
      stock: serviceData('inventory', 'stock', (p) => ({ id: String(p.id) })),
    },
  },
} as const;

type _ServiceArm = Expect<Equal<DeferredDataOf<typeof productRoute>, { readonly reviews: Reviews; readonly stock: Stock }>>;

// And explicitly NOT the descriptor (the callable's honest runtime return):
// @ts-expect-error - a deferred entry is the dispatched result, never the ServiceDescriptor
const _neverDescriptor: ServiceDescriptor = {} as DeferredDataOf<typeof productRoute>['reviews'];
void _neverDescriptor;

// --- Arm 2: a closure handler infers its own resolved return type. ---
const closureRoute = {
  path: '/legacy',
  attr: {
    render: 'streaming',
    meta: {},
    deferred: { notes: async () => ({ note: 'hand-written' }) },
  },
} as const;

type _ClosureArm = Expect<Equal<DeferredDataOf<typeof closureRoute>, { readonly notes: { note: string } }>>;

// --- Arm 2b: a MIXED closure return keeps the descriptor branch as Record<string, unknown> -
// the dispatched branch may resolve to any record and must never be narrowed away. ---
const mixedRoute = {
  path: '/mixed',
  attr: {
    render: 'streaming',
    meta: {},
    deferred: {
      notes: async (params: { premium?: string }) =>
        params.premium ? { title: 'direct' } : ({ serviceName: 'reviews', serviceMethod: 'forProduct', args: {} } as ServiceDescriptor),
    },
  },
} as const;

type _MixedArm = Expect<Equal<DeferredDataOf<typeof mixedRoute>, { readonly notes: { title: string } | Record<string, unknown> }>>;

// --- Arm 3: no `attr.deferred` -> undefined. ---
const plainRoute = { path: '/', attr: { render: 'streaming', meta: {} } } as const;

type _NoDeferredArm = Expect<Equal<DeferredDataOf<typeof plainRoute>, undefined>>;

// Keep tsc's noUnusedLocals honest.
export type _Proof = [_ServiceArm, _ClosureArm, _MixedArm, _NoDeferredArm];
