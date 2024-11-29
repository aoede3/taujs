import path from 'node:path';

import { __dirname } from '@server/utils';

import type { Route, RouteParams } from '@taujs/server';

const clientRoot = path.resolve(__dirname, '../client');

export const routes: Route<RouteParams>[] = [
  {
    path: '/mpa/:id',
    configId: 'mpa',
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
    },
  },
];
