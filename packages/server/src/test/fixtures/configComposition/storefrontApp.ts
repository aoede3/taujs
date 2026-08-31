// Fragment module for PublicConfigComposition.test-d.ts, cell (b): a `defineApp` fragment
// authored with NO `as const` anywhere - the helper's own const generic is the only thing
// preserving `appId`, the literal path and the loader-result type across this module boundary.
import { defineApp } from '../../../Config';
import { testRenderer } from '../../support/renderer';

export type Home = { hero: string };

export const storefrontApp = defineApp({
  appId: 'storefront',
  entryPoint: 'storefront',
  renderer: testRenderer(),
  routes: [
    {
      path: '/storefront/:id',
      attr: { render: 'ssr', data: async (): Promise<Home> => ({ hero: 'h' }) },
    },
  ],
});
