import { CONTENT } from './constants';

import type { Plugin } from 'vite';
import type { CoreSecurityConfig } from './core/config/types';
import type { ContractReport } from './security/VerifyMiddleware';
import type { DebugCategory, Logger } from './logging/Logger';
import type { Route } from './core/config/types';

export function printConfigSummary(
  logger: Logger,
  apps: { appId: string; routeCount: number }[],
  configsCount: number,
  totalRoutes: number,
  durationMs: number,
  warnings: string[],
) {
  logger.info({}, `${CONTENT.TAG} [config] Loaded ${configsCount} app(s), ${totalRoutes} route(s) in ${durationMs.toFixed(1)}ms`);

  apps.forEach((a) => logger.debug('routes', {}, `• ${a.appId}: ${a.routeCount} route(s)`));

  warnings.forEach((w) => logger.warn({}, `${CONTENT.TAG} [warn] ${w}`));
}

export function printSecuritySummary(logger: Logger, routes: Route[], security: CoreSecurityConfig, hasExplicitCSP: boolean, securityDurationMs: number) {
  const total = routes.length;
  const disabled = routes.filter((r) => r.attr?.middleware?.csp === false).length;
  const custom = routes.filter((r) => {
    const v = r.attr?.middleware?.csp;
    return v !== undefined && v !== false;
  }).length;
  const enabled = total - disabled;

  const hasReporting = !!security.csp?.reporting?.endpoint;
  const mode = security.csp?.defaultMode ?? 'merge';

  let status = 'configured';
  let detail = '';

  if (hasExplicitCSP) {
    detail = `explicit, mode=${mode}`;
    if (hasReporting) detail += ', reporting';
    if (custom > 0) detail += `, ${custom} route override(s)`;
  } else {
    if (process.env.NODE_ENV === 'production') {
      logger.warn({}, '(consider explicit config for production)');
    }
  }

  logger.info({}, `${CONTENT.TAG} [security] CSP ${status} (${enabled}/${total} routes) in ${securityDurationMs.toFixed(1)}ms`);
}

export function printContractReport(logger: Logger, report: ContractReport) {
  for (const r of report.items) {
    const line = `${CONTENT.TAG} [security][${r.key}] ${r.message}`;

    if (r.status === 'error') {
      logger.error({}, line);
    } else if (r.status === 'warning') {
      logger.warn({}, line);
    } else if (r.status === 'skipped') {
      logger.debug(r.key as DebugCategory, {}, line);
    } else {
      logger.info({}, line);
    }
  }
}

export function printVitePluginSummary(logger: Logger, appPlugins: Array<{ appId: string; plugins: string[] }>, merged: Plugin[]) {
  const mergedNames = merged.map((p) => p?.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
  const appsLine = appPlugins.length === 0 ? 'no app plugins' : appPlugins.map((a) => `${a.appId}=[${a.plugins.join(', ') || 'none'}]`).join(' ');

  logger.info(undefined, `${CONTENT.TAG} [vite] Plugins ${appsLine} merged=[${mergedNames.join(', ') || 'none'}]`);
}
