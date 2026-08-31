// Fragment module for PublicConfigComposition.test-d.ts, cell (e): the documented degradation.
// `rs` is declared with the broad `NonNullable<AppConfig['routes']>` annotation BEFORE it reaches
// `defineApp` - an already-widened reference, not a fresh literal expression, so the helper's own
// const generic has nothing left to capture. This compiles with zero diagnostics; the composed
// config's path widens to `string` and `RouteData` collapses to `never` (asserted in the main
// test file). This pins the ruling document's predicted degradation through the helper form.
import { defineApp } from '../../../Config';
import { testRenderer } from '../../support/renderer';

import type { AppConfig } from '../../../Config';

export type Product = { sku: string };

const rs: NonNullable<AppConfig['routes']> = [
  {
    path: '/catalog/:id',
    attr: { render: 'ssr', data: async (): Promise<Product> => ({ sku: 'x' }) },
  },
];

export const degradedApp = defineApp({
  appId: 'degraded',
  entryPoint: 'degraded',
  renderer: testRenderer(),
  routes: rs,
});
