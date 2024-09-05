export const ServiceExample = {
  async exampleMethod(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ hello: `world internal service call response with id: ${params.id} and another: ${params.another}` });
      }, 5500);
    });
  },
};
