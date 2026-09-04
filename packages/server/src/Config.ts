import type { FastifyRequest } from 'fastify';
import type { PluginOption } from 'vite';
import type {
  CoreAppConfig,
  AppRoute,
  CoreSecurityConfig,
  CoreTaujsConfig,
  RouteContext as CoreRouteContext,
  RouteData as CoreRouteData,
} from './core/config/types';
import type { CSPDirectives } from './security/CSP';
import type { CSPViolationReport } from './security/CSPReporting';
import type { TaujsRendererContribution } from './utils/RendererContract';
import type { TaujsViteOverride } from './ViteConfig';

export type SecurityConfig = CoreSecurityConfig & {
  csp?: {
    directives?: CSPDirectives;
    generateCSP?: (directives: CSPDirectives, nonce: string, req?: FastifyRequest) => string;
    reporting?: {
      endpoint: string;
      onViolation?: (report: CSPViolationReport, req: FastifyRequest) => void;
      reportOnly?: boolean;
    };
  };
};

export type AppConfig = CoreAppConfig & {
  // Renderer v1 (RFC 0006): every app declares a REQUIRED singular `renderer:` - an opaque branded
  // contribution from `reactRenderer()` or `vueRenderer()`. It carries the framework's compiler (scoped
  // JSX ownership for React; a fresh plugin pack for Vue) and the render-module contract the host validates
  // the entry-server against.
  renderer: TaujsRendererContribution;
  // Ordinary user Vite plugins ONLY. Framework compilers no longer ride here - they belong on `renderer:`;
  // a managed/renderer contribution found in `plugins` is a hard configuration error.
  plugins?: PluginOption[];
  routes?: readonly AppRoute[];
};

export type TaujsConfig = CoreTaujsConfig & {
  apps: readonly AppConfig[];
  security?: SecurityConfig;
  // RFC 0005: the allowlisted Vite surface (static object or serve/build-context function),
  // applied to the shared dev server (SSRServer -> resolveDevViteConfig) and every app build
  // (taujsBuild). Vite-typed, so it lives on this extension - mirroring
  // `AppConfig.plugins: PluginOption[]` and keeping `core/config/types.ts` Vite-free.
  vite?: TaujsViteOverride;
};

export { callServiceMethod, defineService, defineServiceRegistry, getServiceMethodMetadata, withDeadline } from './core/services/DataServices';

export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RegistryCaller,
  ServiceContext,
  ServiceMethodMetadata,
  ServiceRegistry,
  TypedServiceContext,
} from './core/services/DataServices';

export { createServiceData, getServiceDataMetadata } from './core/services/ServiceData';

export type { ServiceDataMetadata, ServiceDataRequestFacts } from './core/services/ServiceData';

// RFC 0016 (Phase A): the declared route-policy surface - the top-level `routePolicy` grammar
// and its evidence vocabulary. The evaluator and its result type are deliberately NOT exported
// here: Phase A has no doctor/CI consumer and no application assertions, so only the
// configuration shape is public.
export type { RoutePolicy, RoutePolicyEvidenceName, RoutePolicyRule, RoutePolicySelector } from './core/policy/RoutePolicy';

/**
 * Public-alias repair (2026-07-30): generic with a broad default, mirroring `RouteData` below.
 * Bare `RouteContext` is the broad runtime shape `{ appId, path, attr, params }`; supply your
 * config - `RouteContext<typeof config>` - for per-route precision. The previous non-generic
 * alias collapsed to `never` (optional `routes` failed RoutesOfApp's array test) and was
 * unusable. Pinned by `test/PublicRouteContext.test-d.ts`.
 */
export type RouteContext<C extends TaujsConfig = TaujsConfig> = CoreRouteContext<C>;
export type RouteData<C extends TaujsConfig = TaujsConfig, P extends string = string> = CoreRouteData<C, P>;

// RFC 0004 (H1): the config-side head-data surface. `HeadDataOf<R>` infers what `headContent`
// receives as `headData` for a route (the phantom-branded service result for `serviceData()`
// loaders); `ServiceDataHandler` is `serviceData()`'s branded return type.
export type { EmptyRouteData, HeadAttributes, HeadDataOf, RouteParams, ServiceDataHandler } from './core/config/types';

// RFC 0007 (decision 19): the config-side deferred-data surface, beside `HeadDataOf`.
// `DeferredDataOf<R>` infers what a renderer's deferred accessor receives for a route;
// `DeferredDataAttributes` is the streaming arm's `attr.deferred` record type.
export type { DeferredDataAttributes, DeferredDataOf } from './core/config/types';

// RFC 0005 (VS2): the public, allowlisted Vite surface. Exported here (the `./config` entry,
// alongside `defineConfig`/`TaujsConfig`) so the `vite.shared.ts satisfies TaujsViteConfig` recipe
// resolves from the same place users import `defineConfig`.
export type { TaujsOptimizeDeps, TaujsViteConfig, TaujsViteContext, TaujsViteOverride } from './ViteConfig';

// Renderer v1: the ONE new public application concept - the opaque renderer contribution declared on
// `AppConfig.renderer`. The renderer-AUTHOR contract (the internal shapes the first-party renderer
// packages implement - CompilerImpl/PreparedPlan/ManagedContributionShape/the brands) lives on the
// separate `@taujs/server/renderer` entry, NOT here; application code only ever sees this opaque type.
export type { TaujsRendererContribution } from './utils/RendererContract';

export { AppError } from './core/errors/AppError';

export function defineConfig<const C extends TaujsConfig>(config: C): C {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');
  return config;
}

/**
 * Const-preserving capture point for a route array authored outside `taujs.config.ts`. Identity
 * at runtime; preserves the literal types that `RouteContext`/`RouteData` derive from. Fragments
 * compose by spreading: `routes: [...authRoutes, ...catalogRoutes]`.
 */
export function defineRoutes<const R extends NonNullable<AppConfig['routes']>>(routes: R): R {
  return routes;
}

/**
 * Const-preserving capture point for a whole app configuration authored outside `taujs.config.ts`.
 * Identity at runtime; preserves the literal types that `RouteContext`/`RouteData` derive from.
 */
export function defineApp<const A extends AppConfig>(app: A): A {
  return app;
}
