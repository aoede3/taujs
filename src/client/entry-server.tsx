import { ServerResponse } from 'node:http';

import React from 'react';
import { createSSRStore, SSRStoreProvider } from '@taujs/server/data-store';
import { createStreamRenderer } from '@taujs/server/render';

import AppBootstrap from '@client/AppBootstrap';

import type { RenderCallbacks } from '@taujs/server';

export const streamRender = (
  serverResponse: ServerResponse,
  { onHead, onFinish, onError }: RenderCallbacks,
  initialDataPromise: Promise<Record<string, unknown>>,
  bootstrapModules: string,
) => {
  const store = createSSRStore(initialDataPromise);

  const headContent = `
    <meta name="description" content="taujs [ τjs ]">
    <link rel="icon" type="image/svg+xml" href="/taujs.svg" />
    <title>taujs [ τjs ]</title>
  `;

  createStreamRenderer(
    serverResponse,
    { onHead, onFinish, onError },
    {
      appElement: (
        <SSRStoreProvider store={store}>
          <AppBootstrap />
        </SSRStoreProvider>
      ),
      bootstrapModules,
      getStoreSnapshot: store.getSnapshot,
      headContent,
    },
  );
};
