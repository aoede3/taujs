import pc from 'picocolors';

import { createLogger, debugLog } from '../utils/Logger';

import type { FastifyInstance } from 'fastify';
import type { DebugConfig } from '../utils/Logger';
import type { Route } from '../types';

type MiddlewareContract = {
  errorMessage: string;
  key: string;
  required: (route: Route) => boolean;
  verify: (app: FastifyInstance) => boolean;
};

// these have to be extracted and exported for vitest to pick them up! 0_o
export const isAuthRequired = (route: Route) => route.attr?.middleware?.auth?.required === true;
export const hasAuthenticate = (app: FastifyInstance) => typeof app.authenticate === 'function';

export const verifyContracts = (app: FastifyInstance, routes: Route[], contracts: MiddlewareContract[], isDebug: DebugConfig) => {
  const logger = createLogger(Boolean(isDebug));

  for (const contract of contracts) {
    const isUsed = routes.some(contract.required);

    if (!isUsed) {
      debugLog(logger, 'auth', pc.cyan(`No routes require "${contract.key}" middleware, skipping verification`), isDebug);
      continue;
    }

    if (!contract.verify(app)) {
      const error = new Error(`[τjs] ${contract.errorMessage}`);
      logger.error(error.message);
      throw error;
    }

    debugLog(logger, 'auth', `Middleware "${contract.key}" verified ✓`, isDebug);
  }
};
