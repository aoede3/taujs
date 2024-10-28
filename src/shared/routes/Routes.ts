import type { Route, RouteParams } from '@taujs/server';

export const routes: Route<RouteParams>[] = [
  {
    path: '/',
    attr: {
      fetch: async () => {
        return {
          url: 'http://localhost:5173/api/initial',
          options: {
            method: 'GET',
          },
        };
      },
      meta: { title: 'taujs [ τjs ] - title route meta', description: 'Streaming page description from route meta' },
      render: 'streaming',
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
    },
  },
];
