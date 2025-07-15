/**
 * taujs [ τjs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License — attribution appreciated.
 * Part of the taujs [ τjs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

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
            data: async (params, ctx) => {
              const res = await fetch(`http://localhost:5173/api/initial/${params.id}`, {
                headers: ctx.headers,
              });
              const data = await res.json();

              return data;
            },
            render: 'ssr',
          },
        },
        {
          path: '/:id/:another',
          attr: {
            data: async (params) => ({
              args: params,
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
            data: async (params, ctx) => {
              const res = await fetch(`http://localhost:5173/api/initial/${params.id}`, {
                headers: ctx.headers,
              });
              const data = await res.json();

              return data;
            },
            render: 'ssr',
          },
        },
      ],
    },
  ],
};
