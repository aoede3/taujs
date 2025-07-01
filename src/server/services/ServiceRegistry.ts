import { ServiceExample } from './ServiceExample';

import type { ServiceRegistry } from '@taujs/server';

export const serviceRegistry: ServiceRegistry = {
  ServiceExample,
} as const satisfies ServiceRegistry;
