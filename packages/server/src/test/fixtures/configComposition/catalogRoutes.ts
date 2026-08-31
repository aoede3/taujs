// Fragment module for PublicConfigComposition.test-d.ts, cell (c): a second `defineRoutes`
// fragment (no `as const`) spread alongside `authRoutes` inside a `defineApp` fragment.
import { defineRoutes } from '../../../Config';

export type Product = { sku: string };

export const catalogRoutes = defineRoutes([
  {
    path: '/catalog/:id',
    attr: { render: 'ssr', data: async (): Promise<Product> => ({ sku: 'x' }) },
  },
]);
