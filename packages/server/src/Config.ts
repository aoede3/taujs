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
};

export { callServiceMethod, defineService, defineServiceRegistry, withDeadline } from './core/services/DataServices';

export type { RegistryCaller, ServiceContext } from './core/services/DataServices';

export type RouteContext = CoreRouteContext<TaujsConfig>;
export type RouteData<C extends TaujsConfig = TaujsConfig, P extends string = string> = CoreRouteData<C, P>;

export { AppError } from './core/errors/AppError';

export function defineConfig<const C extends TaujsConfig>(config: C): C {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');
  return config;
}
