import { createServiceData, defineServiceRegistry } from '@taujs/server/config';

import { contentService } from './content.service.ts';

export const serviceRegistry = defineServiceRegistry({
  content: contentService,
});

export const serviceData = createServiceData<typeof serviceRegistry>();

export type ServiceRegistry = typeof serviceRegistry;
