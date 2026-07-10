import { defineService } from '@taujs/server/config';

export const contentService = defineService({
  // Broad ({}-shaped) params so the mapper-omitted serviceData('content', 'home') form compiles.
  home: async (_params: {}) => ({
    message: 'Hello from τjs — Vue SSR, resolved on the server before the first byte.',
    timestamp: new Date().toISOString(),
  }),

  greet: async (params: { name: string }) => {
    // A deliberate delay so the streaming route visibly blocks at the async boundary.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      message: `Hello, ${params.name} — streamed once the server resolved this.`,
      timestamp: new Date().toISOString(),
    };
  },
});
