import { createServiceData, defineConfig, defineService, defineServiceRegistry, getServiceDataMetadata } from '../../../Config';
import { testRenderer } from '../../../test/support/renderer';

import type { ServiceDataMetadata } from '../../../Config';

const catalogService = defineService({
  // specific params shape: the mapper must narrow route params into it
  getProduct: async (params: { id: string }) => ({ product: { id: params.id } }),
  // broad params shape: accepts the route-params object, mapper may be omitted
  listSpecials: async (_params: {}) => ({ items: ['sku_1'] }),
});

const serviceRegistry = defineServiceRegistry({
  catalog: catalogService,
});

const serviceData = createServiceData<typeof serviceRegistry>();

// --- valid forms ---

const withMapper = serviceData('catalog', 'getProduct', (params) => {
  // mapper params are honest: string | string[] | undefined, narrowed here
  const raw: string | string[] | undefined = params.id;

  return { id: String(raw) };
});

const passthrough = serviceData('catalog', 'listSpecials');

const metadata: ServiceDataMetadata | undefined = getServiceDataMetadata(withMapper);
void metadata;

// the returned handler is an ordinary DataHandler, accepted by route config as-is
const config = defineConfig({
  apps: [
    {
      appId: 'storefront',
      entryPoint: 'storefront',
      renderer: testRenderer(),
      routes: [
        { path: '/product/:id', attr: { render: 'ssr', data: withMapper } },
        { path: '/specials', attr: { render: 'streaming', meta: {}, data: passthrough } },
      ],
    },
  ],
});
void config;

// --- invalid forms ---

// @ts-expect-error service names should be narrowed by the registry
serviceData('checkout', 'getProduct', (params) => ({ id: String(params.id) }));

// @ts-expect-error method names should be narrowed by service
serviceData('catalog', 'getInvoice');

// @ts-expect-error mapper return type must match the method's declared params
serviceData('catalog', 'getProduct', () => ({ sku: 'sku_1' }));

// @ts-expect-error mapper return may not omit required params
serviceData('catalog', 'getProduct', () => ({}));

// @ts-expect-error mapper is required when the method's params need a specific shape
serviceData('catalog', 'getProduct');
