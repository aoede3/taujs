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
import type { TaujsViteOverride } from './ViteConfig';

export type SecurityConfig = CoreSecurityConfig & {
  csp?: {
    defaultMode?: 'merge' | 'replace';
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
  TypedServiceContext,
} from './core/services/DataServices';

export { createServiceData, getServiceDataMetadata } from './core/services/ServiceData';

export type { ServiceDataMetadata } from './core/services/ServiceData';

export type RouteContext = CoreRouteContext<TaujsConfig>;
export type RouteData<C extends TaujsConfig = TaujsConfig, P extends string = string> = CoreRouteData<C, P>;

// RFC 0004 (H1): the config-side head-data surface. `HeadDataOf<R>` infers what `headContent`
// receives as `headData` for a route (the phantom-branded service result for `serviceData()`
// loaders); `ServiceDataHandler` is `serviceData()`'s branded return type.
export type { HeadAttributes, HeadDataOf, ServiceDataHandler } from './core/config/types';

// RFC 0005 (VS2): the public, allowlisted Vite surface. Exported here (the `./config` entry,
// alongside `defineConfig`/`TaujsConfig`) so the `vite.shared.ts satisfies TaujsViteConfig` recipe
// resolves from the same place users import `defineConfig`.
export type { TaujsOptimizeDeps, TaujsViteConfig, TaujsViteContext, TaujsViteOverride } from './ViteConfig';

export { AppError } from './core/errors/AppError';

export function defineConfig<const C extends TaujsConfig>(config: C): C {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');
  return config;
}
