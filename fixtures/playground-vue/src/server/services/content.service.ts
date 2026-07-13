import { defineService } from '@taujs/server/config';

export const contentService = defineService({
  // Broad ({}-shaped) params so the mapper-omitted serviceData('content', 'home') form compiles.
  home: async (_params: {}) => ({
    message: 'Hello from τjs — Vue SSR, resolved on the server before the first byte.',
    timestamp: new Date().toISOString(),
  }),

  // RFC 0004 (H6): the head-critical slice for the streaming route's attr.head - cheap by
  // design (the head loader blocks the head build; default deadline 3000ms).
  greetHead: async (params: { name: string }) => ({
    ogTitle: `Hello ${params.name} | τjs Vue playground`,
    ogDescription: `Live head data for ${params.name}`,
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
