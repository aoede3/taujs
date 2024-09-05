import type { Route, RouteParams } from '@taujs/server';

export const routes: Route<RouteParams>[] = [
  {
    path: '/',
    attributes: {
      fetch: async () => {
        return {
          url: 'http://localhost:5173/api/initial',
          options: {
            method: 'GET',
          },
        };
      },
    },
  },
  {
    path: '/:id',
    attributes: {
      fetch: async (params: RouteParams) => {
        return {
          url: `http://localhost:5173/api/initial/${params.id}`,
          options: {
            method: 'GET',
          },
        };
      },
    },
  },
  {
    path: '/:id/:another',
    attributes: {
      fetch: async (params: RouteParams) => {
        return {
          options: { params },
          serviceMethod: 'exampleMethod',
          serviceName: 'ServiceExample',
        };
      },
    },
  },
];
