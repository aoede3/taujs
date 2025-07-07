import { pluginReact } from '@taujs/react/plugin';

import type { TaujsConfig } from '@taujs/server/config';

export const taujsConfig: TaujsConfig = {
  apps: [
    {
      appId: 'root',
      entryPoint: '',
      plugins: [pluginReact()],
      routes: [
        {
          path: '/:id',
          attr: {
            fetch: async (params) => ({
              url: `http://localhost:5173/api/initial/${params.id}`,
              options: { method: 'GET' },
            }),
            render: 'ssr',
          },
        },
        {
          path: '/:id/:another',
          attr: {
            fetch: async (params) => ({
              options: { params },
              serviceMethod: 'exampleMethod',
              serviceName: 'ServiceExample',
            }),
            meta: {
              title: 'taujs [ τjs ] - streaming',
              description: 'Streaming page description from route meta',
            },
            render: 'streaming',
          },
        },
      ],
    },
    {
      appId: 'mfe',
      entryPoint: '@admin',
      plugins: [pluginReact()],
      routes: [
        {
          path: '/mfe/:id',
          attr: {
            fetch: async (params) => ({
              url: `http://localhost:5173/api/initial/${params.id}`,
              options: { method: 'GET' },
            }),
            render: 'ssr',
          },
        },
      ],
    },
  ],
};
