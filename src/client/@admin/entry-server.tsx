import React from 'react';
import { createRenderer } from '@taujs/react';

import AppBootstrap from './AppBootstrap';

const headContent = (meta: Record<string, unknown> = {}) => `
  <meta name="description" content="${meta.description || 'taujs [ τjs ] - Default MFE description'}">
  <link rel="icon" type="image/svg+xml" href="${meta.iconPath || '/@admin/taujs.svg'}" />
  <title>${meta.title || 'taujs [ τjs ] - Default MFE title'}</title>
`;

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <AppBootstrap location={location} />,
  headContent,
});
