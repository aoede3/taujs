// Followup ruling (2026-07-29) - HARD GATE: `RouteContext<C>` must mirror the runtime value
// HandleRender constructs - `{ appId, path, attr, params }` - with `data` ABSENT (route data
// reaches the renderer store, never routeContext) and `params` typed as the broad `RouteParams`
// every data handler receives. `RoutesData`/`RouteData` must keep deriving the same data unions
// they derived before the ruling, now from route declarations rather than the context.
//
// Type-level test in the HeadDataOf.test-d.ts idiom: enforced by `pnpm --filter @taujs/server
// typecheck` (tsc); the `.test-d.ts` suffix is outside vitest's test glob so it never runs as a
// spec. Uses invariant-Equal (not mere assignability) so width-subtyping cannot fake a pass.
import type { RouteContext, RouteData, RouteParams, RoutesData } from '../types';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Home = { hero: string };
type Product = { sku: string; title: string };

const config = {
  apps: [
    {
      appId: 'storefront',
      entryPoint: '',
      routes: [
        {
          path: '/',
          attr: { render: 'ssr', data: async (): Promise<Home> => ({ hero: 'x' }) },
        },
        {
          path: '/products/:id',
          attr: { render: 'streaming', data: async (): Promise<Product> => ({ sku: 's', title: 't' }) },
        },
      ],
    },
  ],
} as const;

type C = typeof config;
type Ctx = RouteContext<C>;

// --- 1. The context's keys are EXACTLY the runtime keys - no more, no fewer. ---
type _Keys = Expect<Equal<keyof Ctx, 'appId' | 'path' | 'attr' | 'params'>>;

// --- 2. `data` is absent from the context (it was never supplied at runtime). ---
// @ts-expect-error - routeContext does not carry route data; use the renderer store / RouteData
type _NoData = Ctx['data'];

// --- 3. Fields carry the ruled types. ---
type _AppId = Expect<Equal<Ctx['appId'], 'storefront'>>;
type _Paths = Expect<Equal<Ctx['path'], '/' | '/products/:id'>>;
type _Params = Expect<Equal<Ctx['params'], RouteParams>>;

// --- 4. RoutesData/RouteData derive the same unions as before the ruling. ---
type _RoutesData = Expect<Equal<RoutesData<C>, Home | Product>>;
type _RouteData = Expect<Equal<RouteData<C, '/products/:id'>, Product>>;
type _HomeData = Expect<Equal<RouteData<C, '/'>, Home>>;
