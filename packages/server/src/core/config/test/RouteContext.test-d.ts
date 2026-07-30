// Followup ruling (2026-07-29) - HARD GATE: `RouteContext<C>` must mirror the runtime value
// HandleRender constructs - `{ appId, path, attr, params }` - with `data` ABSENT (route data
// reaches the renderer store, never routeContext) and `params` typed as the broad `RouteParams`
// every data handler receives. `RoutesData`/`RouteData` must keep deriving the same data unions
// they derived before the ruling, now from route declarations rather than the context.
//
// Type-level test in the HeadDataOf.test-d.ts idiom: enforced by `pnpm --filter @taujs/server
// typecheck` (tsc); the `.test-d.ts` suffix is outside vitest's test glob so it never runs as a
// spec. Uses invariant-Equal (not mere assignability) so width-subtyping cannot fake a pass.
import type { EmptyRouteData, RouteContext, RouteData, RouteParams, RoutesData } from '../types';

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

// --- 5. RouteDataOf brand arm (2026-07-30): a `serviceData()` route resolves the SELECTED
// METHOD's result - never the descriptor the handler honestly returns at runtime - following
// HeadDataOf's arms exactly. Uses the real helper so the brand seam itself is exercised. ---
import { createServiceData } from '../../services/ServiceData';

type Sku = { sku: string; price: number };

type Registry = Readonly<{
  catalog: Readonly<{
    getSku: (params: { id: string }, ctx: any) => Promise<Sku>;
  }>;
}>;

const serviceData = createServiceData<Registry>();

const svcConfig = {
  apps: [
    {
      appId: 'svc',
      entryPoint: '',
      routes: [
        {
          path: '/sku/:id',
          attr: { render: 'ssr', data: serviceData('catalog', 'getSku', (p) => ({ id: String(p.id) })) },
        },
      ],
    },
  ],
} as const;

type _SvcRouteData = Expect<Equal<RouteData<typeof svcConfig, '/sku/:id'>, Sku>>;
type _SvcRoutesData = Expect<Equal<RoutesData<typeof svcConfig>, Sku>>;

// --- 6. The other two RouteDataOf arms the changeset promises (matching HeadDataOf's gate):
// a PURE hand-built descriptor collapses to Record<string, unknown> (the dispatch result is
// untyped), a MIXED object-or-descriptor return distributes to ObjectType | Record<string,
// unknown> (the descriptor member must never be silently dropped), and no `attr.data` resolves
// to EmptyRouteData (the ruling section 7 proves app-wide). ---
import type { ServiceDescriptor } from '../../services/DataServices';

const descriptorConfig = {
  apps: [
    {
      appId: 'desc',
      entryPoint: '',
      routes: [
        {
          path: '/pure',
          attr: {
            render: 'ssr',
            data: async () => ({ serviceName: 'catalog', serviceMethod: 'getSku', args: {} }) as ServiceDescriptor,
          },
        },
        {
          path: '/mixed',
          attr: {
            render: 'ssr',
            data: async (params: { premium?: string }) =>
              params.premium ? { title: 'direct' } : ({ serviceName: 'catalog', serviceMethod: 'getSku', args: {} } as ServiceDescriptor),
          },
        },
        { path: '/nodata', attr: { render: 'ssr' } },
      ],
    },
  ],
} as const;

type _PureDescriptor = Expect<Equal<RouteData<typeof descriptorConfig, '/pure'>, Record<string, unknown>>>;
type _MixedReturn = Expect<Equal<RouteData<typeof descriptorConfig, '/mixed'>, { title: string } | Record<string, unknown>>>;
type _NoDataArm = Expect<Equal<RouteData<typeof descriptorConfig, '/nodata'>, EmptyRouteData>>;

// --- 7. REVISED ruling (review, 2026-07-30): a concrete no-data route resolves to
// `EmptyRouteData` (`Record<string, undefined>` - the runtime supplies `{}`), NOT `unknown`.
// The app-wide union therefore stays USABLE when a CSR-style no-data route participates:
// `data.field` reads as `T | undefined`, forcing code to account for the no-data route without
// destroying the whole union. ---
const mixedAppConfig = {
  apps: [
    {
      appId: 'mixed-app',
      entryPoint: '',
      routes: [
        {
          path: '/data',
          attr: { render: 'ssr', data: serviceData('catalog', 'getSku', (p) => ({ id: String(p.id) })) },
        },
        { path: '/csr' },
      ],
    },
  ],
} as const;

type _MixedAppUnion = Expect<Equal<RouteData<typeof mixedAppConfig, string>, Sku | EmptyRouteData>>;
