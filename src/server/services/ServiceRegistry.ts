import { defineServiceRegistry } from '@taujs/server/config';

import { ServiceExample } from './ServiceExample';

export const serviceRegistry = defineServiceRegistry({ ServiceExample });
