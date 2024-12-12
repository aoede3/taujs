import React from 'react';
import { createRenderer } from '@taujs/server/data';

import AppBootstrap from '@client/AppBootstrap';

const headContent = (meta: Record<string, unknown> = {}) => `
  <meta name="description" content="${meta.description || 'taujs [ τjs ] - Default description'}">
  <link rel="icon" type="image/svg+xml" href="${meta.iconPath || '/taujs.svg?client'}" />
  <title>${meta.title || 'taujs [ τjs ] - Default title'}</title>
`;

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <AppBootstrap location={location} />,
  headContent,
});
