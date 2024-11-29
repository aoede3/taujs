import React from 'react';
import { createRenderer } from '@taujs/server/data';

import AppBootstrap from './AppBootstrap';

const headContent = (meta: Record<string, unknown> = {}) => `
  <meta name="description" content="${meta.description || 'taujs [ τjs ] - Default MPA description'}">
  <link rel="icon" type="image/svg+xml" href="${meta.iconPath || '/taujs.svg'}" />
  <title>${meta.title || 'taujs [ τjs ] - Default MPA title'}</title>
`;

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <AppBootstrap location={location} />,
  headContent,
});
