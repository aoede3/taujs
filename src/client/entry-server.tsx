import React from 'react';
import { createStreamRenderer } from '@taujs/server/data';

import type { StreamRender } from '@taujs/server';
import AppBootstrap from '@client/AppBootstrap';

export const streamRender: StreamRender = (serverResponse, { onHead, onFinish, onError }, initialDataPromise, bootstrapModules) => {
  const headContent = `
    <meta name="description" content="taujs [ τjs ]">
    <link rel="icon" type="image/svg+xml" href="/taujs.svg" />
    <title>taujs [ τjs ]</title>
  `;

  createStreamRenderer(
    serverResponse,
    { onHead, onFinish, onError },
    {
      appComponent: <AppBootstrap />,
      initialDataPromise,
      bootstrapModules,
      headContent,
    },
  );
};
