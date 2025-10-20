import { defineService } from '@taujs/server/config';

export const ServiceExample = defineService({
  exampleMethod: {
    handler: async (params: { id: string; another?: string }): Promise<{ data: string }> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ data: `internal service response with id: ${params.id} and another: ${params.another}` });
        }, 5000);
      });
    },
  },
});
