import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { PluginOption } from 'vite';

import type { Config as CoreConfig, ProcessedConfig as CoreProcessedConfig, Route, PathToRegExpParams } from './core/config/types';
import type { DebugConfig, Logs } from './core/logging/types';
import type { ServiceRegistry } from './core/services/DataServices';
import type { RequestContext } from './core/telemetry/Telemetry';

import type { AppConfig, SecurityConfig } from './Config';
import type { StaticAssetsRegistration } from './utils/StaticAssets';

// Extend only where platform needs to specialise; otherwise re-export core shapes directly for compatibility.
export type Config = CoreConfig<PluginOption>;
export type ProcessedConfig = CoreProcessedConfig<PluginOption>;

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  configs: readonly AppConfig[];
  routes: Route<PathToRegExpParams>[];
  serviceRegistry?: ServiceRegistry;
  security?: SecurityConfig;
  staticAssets?: StaticAssetsRegistration;
  debug?: DebugConfig;
  devNet?: { host: string; hmrPort: number };
};

export type GenericPlugin = FastifyPluginCallback<Record<string, unknown>> | FastifyPluginAsync<Record<string, unknown>>;

export type RequestServiceContextWithRequest<L extends Logs> = import('./core/config/types').RequestServiceContext<L> & RequestContext<L>;

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}
