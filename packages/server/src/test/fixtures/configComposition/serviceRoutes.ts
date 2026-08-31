// Fragment module for PublicConfigComposition.test-d.ts, cell (d): a `defineRoutes` fragment
// whose route data comes from a service registry via `serviceData()` (registry setup mirrors
// `core/services/test/ServiceData.typecheck.ts`). Proves `RouteData` resolves to the method's
// branded result, not the descriptor, when the route is authored through the helper.
import { createServiceData, defineRoutes, defineService, defineServiceRegistry } from '../../../Config';

export type Product = { sku: string; title: string };

const catalogService = defineService({
  getProduct: async (params: { id: string }): Promise<Product> => ({ sku: params.id, title: 'x' }),
});

const serviceRegistry = defineServiceRegistry({
  catalog: catalogService,
});

const serviceData = createServiceData<typeof serviceRegistry>();

export const serviceRoutes = defineRoutes([
  {
    path: '/product/:id',
    attr: {
      render: 'ssr',
      data: serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) })),
    },
  },
]);
