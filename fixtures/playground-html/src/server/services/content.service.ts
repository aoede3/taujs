import { defineService } from '@taujs/server/config';

export const contentService = defineService({
  // Critical data: cheap by design, resolved on the server before the first byte / shell.
  home: async (_params: {}) => ({
    message: 'Hello from τjs - framework-free HTML SSR, resolved on the server before the first byte.',
    timestamp: new Date().toISOString(),
  }),

  // A deliberate delay so the streaming route visibly blocks the shell on the critical data.
  greet: async (params: { name: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      message: `Hello, ${params.name} - streamed once the server resolved this.`,
      timestamp: new Date().toISOString(),
    };
  },

  // A deferred entry that settles well within the fixture's 500ms deferredTimeoutMs.
  reviews: async (_params: {}) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { count: 3, top: 'a genuinely deferred review' };
  },

  // A deferred entry that never settles, deliberately - the deadline must abandon it. `Promise<never>`
  // is assignable to any resolved-value type, so this needs no cast to satisfy the JSON return shape.
  neverResolves: async (_params: {}) => new Promise<never>(() => {}),
});
