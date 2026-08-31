// Const-preserving config composition (followup: const-preserving-config-composition) - a
// SOURCE-LEVEL regression pin on defineRoutes/defineApp and the derived RouteContext/RouteData
// chain: every helper and type here is imported from '../Config' (source), not from the packed
// '@taujs/server/config' package entry. Fragments live in separate modules under
// './fixtures/configComposition/' so the const-generic capture at each `defineRoutes`/`defineApp`
// call site is exercised across a real module boundary, not simulated with local consts. The
// packed public-entry proof lives in PackedConfigComposition.test.ts, not here.
//
// Same idiom as PublicRouteContext.test-d.ts: enforced by `pnpm --filter @taujs/server typecheck`
// (tsc); the `.test-d.ts` suffix is outside vitest's test glob so it never runs as a spec.
// Invariant-Equal (not mere assignability) so width-subtyping cannot fake a pass.
import { defineApp, defineConfig } from '../Config';
import { authRoutes } from './fixtures/configComposition/authRoutes';
import { catalogRoutes, type Product as CatalogProduct } from './fixtures/configComposition/catalogRoutes';
import { degradedApp } from './fixtures/configComposition/degradedApp';
import { serviceRoutes, type Product as ServiceProduct } from './fixtures/configComposition/serviceRoutes';
import { storefrontApp, type Home } from './fixtures/configComposition/storefrontApp';
import { testRenderer } from './support/renderer';

import type { Session } from './fixtures/configComposition/authRoutes';
import type { RouteContext, RouteData } from '../Config';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- (a) `defineRoutes` fragment, no `as const`: exact appId, exact path, exact RouteData. ---
// `authRoutes` is imported already built by `defineRoutes` in its own module; composed here
// directly inside `defineConfig`'s inline `apps:` array, so `appId` is captured by
// `defineConfig`'s own const generic while `routes` is captured by `defineRoutes`'s.
const cellAConfig = defineConfig({
  apps: [
    {
      appId: 'auth',
      entryPoint: 'auth',
      renderer: testRenderer(),
      routes: authRoutes,
    },
  ],
});

type CellACtx = RouteContext<typeof cellAConfig>;
type _CellA_AppId = Expect<Equal<CellACtx['appId'], 'auth'>>;
type _CellA_Path = Expect<Equal<CellACtx['path'], '/login'>>;
type _CellA_RouteData = Expect<Equal<RouteData<typeof cellAConfig, '/login'>, Session>>;

// --- (b) `defineApp` fragment, no `as const`: exact appId, exact path, exact RouteData. ---
// `storefrontApp` is a complete app fragment built entirely by `defineApp` in its own module
// (routes authored inline there, not via `defineRoutes`), composed here only by `defineConfig`.
const cellBConfig = defineConfig({ apps: [storefrontApp] });

type CellBCtx = RouteContext<typeof cellBConfig>;
type _CellB_AppId = Expect<Equal<CellBCtx['appId'], 'storefront'>>;
type _CellB_Path = Expect<Equal<CellBCtx['path'], '/storefront/:id'>>;
type _CellB_RouteData = Expect<Equal<RouteData<typeof cellBConfig, '/storefront/:id'>, Home>>;

// --- (c) Spread concatenation of two `defineRoutes` fragments inside `defineApp`: exact path
// union, both RouteData lookups. `authRoutes` and `catalogRoutes` each come from their own
// fragment module; the spread happens at the `defineApp` call site. ---
const combinedApp = defineApp({
  appId: 'combined',
  entryPoint: 'combined',
  renderer: testRenderer(),
  routes: [...authRoutes, ...catalogRoutes],
});
const cellCConfig = defineConfig({ apps: [combinedApp] });

type CellCCtx = RouteContext<typeof cellCConfig>;
type _CellC_Path = Expect<Equal<CellCCtx['path'], '/login' | '/catalog/:id'>>;
type _CellC_AuthRouteData = Expect<Equal<RouteData<typeof cellCConfig, '/login'>, Session>>;
type _CellC_CatalogRouteData = Expect<Equal<RouteData<typeof cellCConfig, '/catalog/:id'>, CatalogProduct>>;

// --- (d) Service-backed route through `defineRoutes`: RouteData is the service method's resolved
// result (from `serviceRoutes`'s registry, mirroring `ServiceData.typecheck.ts`), never the
// descriptor `serviceData()` honestly returns at runtime. ---
const cellDConfig = defineConfig({
  apps: [
    {
      appId: 'store',
      entryPoint: 'store',
      renderer: testRenderer(),
      routes: serviceRoutes,
    },
  ],
});

type _CellD_RouteData = Expect<Equal<RouteData<typeof cellDConfig, '/product/:id'>, ServiceProduct>>;

// --- (e) Degradation negative, pinned: `degradedApp` composes an upstream variable already
// annotated `NonNullable<AppConfig['routes']>` through `defineApp`. This still compiles - the
// documented behaviour is that `defineApp`'s const generic cannot reconstruct precision an
// upstream declaration already erased - so path is exactly `string` and RouteData is exactly
// `never`, asserted here so this degradation cannot silently change without failing this file. ---
const cellEConfig = defineConfig({ apps: [degradedApp] });

type CellECtx = RouteContext<typeof cellEConfig>;
type _CellE_PathDegradesToString = Expect<Equal<CellECtx['path'], string>>;
type _CellE_RouteDataDegradesToNever = Expect<Equal<RouteData<typeof cellEConfig, '/catalog/:id'>, never>>;
