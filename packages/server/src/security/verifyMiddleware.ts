import type { FastifyInstance } from 'fastify';
import type { Route } from '../types';

type MiddlewareContract = {
  errorMessage: string;
  key: string;
  required: (route: Route) => boolean;
  verify: (app: FastifyInstance) => boolean;
};

export type ContractCheck = {
  key: string;
  status: 'verified' | 'skipped' | 'error';
  message: string;
};

// these have to be exported for vitest to pick them up! 0_o
export const isAuthRequired = (route: Route) => Boolean(route.attr?.middleware?.auth);
export const hasAuthenticate = (app: FastifyInstance) => typeof app.authenticate === 'function';
export const isCSPDeclared = (route: Route) => Boolean(route.attr?.middleware?.csp);

export const verifyContracts = (app: FastifyInstance, routes: Route[], contracts: MiddlewareContract[]): ContractCheck[] => {
  const results: ContractCheck[] = [];

  for (const contract of contracts) {
    const isUsed = routes.some(contract.required);

    if (!isUsed) {
      results.push({
        key: contract.key,
        status: 'skipped',
        message: `No routes require "${contract.key}" middleware`,
      });
      continue;
    }

    if (!contract.verify(app)) {
      const msg = `[τjs] ${contract.errorMessage}`;
      results.push({ key: contract.key, status: 'error', message: msg });
      throw new Error(msg);
    }

    results.push({
      key: contract.key,
      status: 'verified',
      message: `Middleware "${contract.key}" verified ✓`,
    });
  }

  return results;
};
