import { defineService } from '@taujs/server/config';

export const contentService = defineService({
  // Broad ({}-shaped) params: this is what makes the mapper-omitted
  // serviceData('content', 'home') form compile (04-design-servicedata.md §Typing honesty).
  home: async (_params: {}) => ({
    heading: 'τjs playground',
    blurb: 'One small bootable app the introspection effort drives against.',
  }),
});
