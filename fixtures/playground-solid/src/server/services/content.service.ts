import { defineService } from '@taujs/server/config';

export const contentService = defineService({
  // Broad ({}-shaped) params so the mapper-omitted serviceData('content', 'home') form compiles.
  home: async (_params: {}) => ({
    title: 'τjs Solid playground',
    message: 'Hello from τjs - Solid SSR, resolved on the server before the first byte.',
    items: ['snapshot data bridge', 'fixed-identity error sanitiser', 'nonced hydration bootstrap'],
  }),

  streaming: async (_params: {}) => {
    // A deliberate delay so the streaming route visibly blocks at the async boundary. Under the
    // snapshot bridge the adapter gates the render on route readiness, so this delays the SHELL -
    // that is the documented trade (design 3), not a defect.
    await new Promise((resolve) => setTimeout(resolve, 400));

    return {
      title: 'τjs Solid playground - streaming',
      message: 'Streamed once the server resolved this.',
      items: ['two-latch onAllReady', 'terminal guard', 'detachable holders'],
    };
  },
});
