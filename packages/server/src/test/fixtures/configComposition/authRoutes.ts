// Fragment module for PublicConfigComposition.test-d.ts, cell (a): a `defineRoutes` fragment
// authored with NO `as const` anywhere - the helper's own const generic is the only thing
// preserving the literal path and loader-result types across this module boundary.
import { defineRoutes } from '../../../Config';

export type Session = { id: string };

export const authRoutes = defineRoutes([
  {
    path: '/login',
    attr: { render: 'ssr', data: async (): Promise<Session> => ({ id: 's1' }) },
  },
]);
