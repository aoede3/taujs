import { __dirname } from '@server/utils';

import type { Route, RouteParams } from '@taujs/server';

export const routes: Route<RouteParams>[] = [
  {
    appId: 'mfe',
    path: '/mfe/:id',
    attr: {
      fetch: async (params: RouteParams) => {
        return {
          url: `http://localhost:5173/api/initial/${params.id}`,
          options: {
            method: 'GET',
          },
        };
      },
      render: 'ssr',
    },
  },
  {
    path: '/:id',
    attr: {
      fetch: async (params: RouteParams) => {
        return {
          url: `http://localhost:5173/api/initial/${params.id}`,
          options: {
            method: 'GET',
          },
        };
      },
      render: 'ssr',
    },
  },
  {
    path: '/:id/:another',
    attr: {
      fetch: async (params: RouteParams) => {
        return {
          options: { params },
          serviceMethod: 'exampleMethod',
          serviceName: 'ServiceExample',
        };
      },
      meta: { title: 'taujs [ τjs ] - streaming', description: 'Streaming page description from route meta' },
      render: 'streaming',
    },
  },
];
