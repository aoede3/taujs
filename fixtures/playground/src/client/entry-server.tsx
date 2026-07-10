import { createRenderer } from '@taujs/react';
import { App } from './App';

export const { renderSSR, renderStream } = createRenderer({
  appComponent: () => <App />,
  headContent: ({ meta }) => `
    <title>${(meta as { title?: string } | undefined)?.title ?? 'τjs playground'}</title>
  `,
  enableDebug: process.env.NODE_ENV === 'development',
});
