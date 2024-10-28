import React from 'react';
import { createRenderer } from '@taujs/server/data';

import AppBootstrap from '@client/AppBootstrap';

const headContent = (meta: Record<string, unknown> = {}) => `
  <meta name="description" content="${meta.description || 'Default description'}">
  <link rel="icon" type="image/svg+xml" href="${meta.iconPath || '/default-icon.svg'}" />
  <title>${meta.title || 'Default title'}</title>
`;

export const { renderSSR, renderStream } = createRenderer({
  appComponent: <AppBootstrap />,
  headContent,
});
