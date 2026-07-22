import { createServiceData, defineServiceRegistry } from '@taujs/server/config';

import { catalogService } from './catalog.service.ts';
import { contentService } from './content.service.ts';

export const serviceRegistry = defineServiceRegistry({
  catalog: catalogService,
  content: contentService,
});

export const serviceData = createServiceData<typeof serviceRegistry>();

export type ServiceRegistry = typeof serviceRegistry;
