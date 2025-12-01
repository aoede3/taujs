/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import type { FastifyRequest } from 'fastify';
import type { PluginOption } from 'vite';
import type { CSPDirectives } from './security/CSP';
import type { PathToRegExpParams, Route, RouteAttributes } from './types';

import type { CSPViolationReport } from './security/CSPReporting';

export type SecurityConfig = {
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

export type AppRoute = Omit<Route<PathToRegExpParams>, 'appId'> & {
  attr?: RouteAttributes<PathToRegExpParams>;
};

export type AppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: PluginOption[];
  routes?: readonly AppRoute[];
};

export type TaujsConfig = {
  apps: readonly AppConfig[];
  security?: SecurityConfig;
  server?: {
    host?: string;
    port?: number;
    hmrPort?: number;
  };
};

export { callServiceMethod, defineService, defineServiceRegistry, withDeadline } from './utils/DataServices';

export type { RegistryCaller, ServiceContext } from './utils/DataServices';

export type { RouteContext, RouteData } from './types';

export { AppError } from './logging/AppError';

export function defineConfig<const C>(config: C & TaujsConfig): C {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');
  return config;
}
