import { AppError, defineService } from '@taujs/server/config';

// getProduct carries a parse-style params schema and a bare-function result validator —
// together they exercise both honest `kind` values ('parse' | 'function') in the graph.
const parseProductParams = {
  parse: (u: unknown): { id: string } => {
    const id = (u as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('catalog.getProduct requires { id: string }');
    return { id };
  },
};

const validateProductResult = (u: unknown) => u as { product: { id: string; title: string; price: number } };

export const catalogService = defineService({
  getProduct: {
    handler: async (params: { id: string }) => {
      // The killer-demo route's deterministic failure: /product/999 always breaks.
      if (params.id === '999') {
        throw AppError.notFound(`Product ${params.id} does not exist`, undefined, 'PRODUCT_NOT_FOUND');
      }

      return { product: { id: params.id, title: `Product ${params.id}`, price: 42 } };
    },
    params: parseProductParams,
    result: validateProductResult,
  },
});
