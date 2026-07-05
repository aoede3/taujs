import type { FastifyInstance } from 'fastify';
import type { CoreSecurityConfig, Route } from '../core/config/types';

export type ContractItem = {
  key: string;
  status: 'verified' | 'skipped' | 'error' | 'warning';
  message: string;
};

export type ContractReport = {
  items: ContractItem[];
};

export const isAuthRequired = (route: Route): boolean => Boolean(route.attr?.middleware?.auth);
export const hasAuthenticate = (app: FastifyInstance): boolean => typeof (app as any).authenticate === 'function';

type MiddlewareContract = {
  key: string;
  errorMessage: string;
  required: (routes: Route[], security?: CoreSecurityConfig) => boolean;
  verify: (app: FastifyInstance) => boolean;
};

export function formatCspLoadedMsg(hasGlobal: boolean, custom: number, prodNoGlobal = false) {
  if (hasGlobal) {
    return custom > 0 ? `Loaded global config with ${custom} route override(s)` : 'Loaded global config';
  }
  if (prodNoGlobal) {
    return custom > 0 ? `No global CSP configured; ${custom} route override(s) only` : 'No global CSP configured';
  }
  return custom > 0 ? `Loaded development defaults with ${custom} route override(s)` : 'Loaded development defaults';
}

export const verifyContracts = (app: FastifyInstance, routes: Route[], contracts: MiddlewareContract[], security?: CoreSecurityConfig): ContractReport => {
  const items: ContractItem[] = [];

  for (const contract of contracts) {
    const isRequired = contract.required(routes, security);

    if (!isRequired) {
      items.push({
        key: contract.key,
        status: 'skipped',
        message: `No routes require "${contract.key}"`,
      });

      continue;
    }

    if (!contract.verify(app)) {
      const msg = `[τjs] ${contract.errorMessage}`;
      items.push({ key: contract.key, status: 'error', message: msg });

      throw new Error(msg);
    }

    if (contract.key === 'csp') {
      const total = routes.length;
      const disabled = routes.filter((r) => r.attr?.middleware?.csp === false).length;
      const custom = routes.filter((r) => {
        const v = r.attr?.middleware?.csp;

        return v !== undefined && v !== false;
      }).length;
      const enabled = total - disabled;
      const hasGlobal = !!security?.csp;

      const prodNoGlobal = !hasGlobal && process.env.NODE_ENV === 'production';

      let status: ContractItem['status'] = 'verified';
      let tail = '';

      if (prodNoGlobal) {
        status = 'warning';
        tail = ' (no global CSP header is sent in production without security.csp)';
      }

      const baseMsg = formatCspLoadedMsg(hasGlobal, custom, prodNoGlobal);
      items.push({
        key: 'csp',
        status,
        message: baseMsg + tail,
      });

      items.push({
        key: 'csp',
        status,
        message: `✓ Verified (${enabled} enabled, ${disabled} disabled, ${total} total).`,
      });
    } else {
      const count = routes.filter((r) => contract.required([r], security)).length;
      items.push({
        key: contract.key,
        status: 'verified',
        message: `✓ ${count} route(s)`,
      });
    }
  }

  return { items };
};
