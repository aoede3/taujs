/**
 * τjs [taujs] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License — attribution appreciated.
 * Part of the τjs [taujs] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import { pluginReact } from '@taujs/react/plugin';
import { defineConfig } from '@taujs/server/config';

export default defineConfig({
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
            middleware: {
              csp: {
                directives: ({ params }) => {
                  const userId = params.id as string;

                  return {
                    'script-src': ["'self'", `https://user-${userId}.example.com`],
                  };
                },
              },
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
              title: 'τjs [taujs] - streaming',
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
});
