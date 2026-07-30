// Public-alias repair (2026-07-30) - HARD GATE on the PUBLIC ENTRY: these imports come from
// '../Config', exercising exactly what ships as '@taujs/server/config'. The internal derivation
// gate (core/config/test/RouteContext.test-d.ts) cannot substitute for this file - the previous
// non-generic alias collapsed to `never` while every internal assertion stayed green.
//
// Proves: bare `RouteContext` is the usable broad runtime shape; `RouteContext<typeof config>`
// is per-route precise; required/optional/absent `attr` arms are honest; `data` is absent;
// public `RouteData` stays precise on a concrete config and non-degenerate bare.
// Same idiom as HeadDataOf.test-d.ts: enforced by `pnpm --filter @taujs/server typecheck` (tsc);
// invariant-Equal so width-subtyping cannot fake a pass.
import type { AppConfig, RouteContext, RouteData, RouteParams, TaujsConfig } from '../Config';
import type { RouteAttributes } from '../core/config/types';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Home = { hero: string };
type Product = { sku: string; title: string };

// A concrete configuration in TYPE space: `declare` keeps it value-free (the branded renderer
// has no constructible test value); the literal members mirror an `as const` defineConfig call.
// Four routes cover the attr arms: required attr (x2), absent attr, optional attr.
declare const config: {
  apps: readonly [
    {
      appId: 'storefront';
      entryPoint: '';
      renderer: AppConfig['renderer'];
      routes: readonly [
        { path: '/'; attr: { render: 'ssr'; data: () => Promise<Home> } },
        { path: '/products/:id'; attr: { render: 'streaming'; meta: Record<string, unknown>; data: () => Promise<Product> } },
        { path: '/bare' },
        { path: '/opt'; attr?: { render: 'ssr' } },
      ];
    },
  ];
};

// The sample must remain a real TaujsConfig, or the precise-form assertions test nothing.
type _ConfigIsTaujsConfig = Expect<typeof config extends TaujsConfig ? true : false>;

// --- 1. The bare alias is usable (the repaired defect: it used to be `never`). ---
type _BareNotNever = Expect<Equal<[RouteContext] extends [never] ? true : false, false>>;

// --- 2. Bare keys are exactly the four runtime keys. ---
type _BareKeys = Expect<Equal<keyof RouteContext, 'appId' | 'path' | 'attr' | 'params'>>;

// --- 3. Bare field types: the broad runtime shape. ---
type _BareAppId = Expect<Equal<RouteContext['appId'], string>>;
type _BarePath = Expect<Equal<RouteContext['path'], string>>;
type _BareAttr = Expect<Equal<RouteContext['attr'], RouteAttributes<RouteParams> | undefined>>;
type _BareParams = Expect<Equal<RouteContext['params'], RouteParams>>;

// --- 4. `data` is absent from the public context. ---
// @ts-expect-error - routeContext does not carry route data; use the renderer store / RouteData
type _NoData = RouteContext['data'];

// --- 5. The precise form preserves route-specific appId, path and attr. ---
type PreciseCtx = RouteContext<typeof config>;

type _PreciseAppId = Expect<Equal<PreciseCtx['appId'], 'storefront'>>;
type _PrecisePaths = Expect<Equal<PreciseCtx['path'], '/' | '/products/:id' | '/bare' | '/opt'>>;
type _PreciseParams = Expect<Equal<PreciseCtx['params'], RouteParams>>;

// attr arms, member by member:
type _AttrRequired = Expect<Equal<Extract<PreciseCtx, { path: '/' }>['attr'], { render: 'ssr'; data: () => Promise<Home> }>>;
type _AttrAbsent = Expect<Equal<Extract<PreciseCtx, { path: '/bare' }>['attr'], undefined>>;
type _AttrOptional = Expect<Equal<Extract<PreciseCtx, { path: '/opt' }>['attr'], { render: 'ssr' } | undefined>>;

// --- 6. Public RouteData: precise on a concrete config (`/typo` against a concrete config
// stays `never` - typo detection), non-degenerate bare, and the broad + literal-path form is
// RULED unsupported (stays `never`): TaujsConfig contains no evidence about '/x', and we decline
// the extra conditional machinery that could return `unknown` for that case. Path-specific
// lookup requires the concrete configuration type. ---
type _RouteDataPrecise = Expect<Equal<RouteData<typeof config, '/products/:id'>, Product>>;
type _RouteDataHome = Expect<Equal<RouteData<typeof config, '/'>, Home>>;
type _RouteDataTypo = Expect<Equal<RouteData<typeof config, '/typo'>, never>>;
type _RouteDataBareNotNever = Expect<Equal<[RouteData] extends [never] ? true : false, false>>;
type _RouteDataBroadLiteralPath = Expect<Equal<RouteData<TaujsConfig, '/x'>, never>>;
