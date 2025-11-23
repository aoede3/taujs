import React from 'react';
import { createRenderer } from '@taujs/react';

import type { HeadContext } from '@taujs/react';

import AppBootstrap from '@client/AppBootstrap';

const headContent = ({ meta }: HeadContext) => `
  <meta name="description" content="${meta.description || 'τjs [taujs] - Default description'}">
  <link rel="icon" type="image/svg+xml" href="${meta.iconPath || '/taujs.svg?client'}" />
  <title>${meta.title || 'τjs [taujs] - Default title'}</title>
`;

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <AppBootstrap location={location} />,
  headContent,
});
