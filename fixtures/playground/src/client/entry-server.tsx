import { createRenderer, escapeHtml } from '@taujs/react';
import { App } from './App';

type HeadData = { ogTitle?: string; ogDescription?: string };

export const { renderSSR, renderStream } = createRenderer<Record<string, unknown>, unknown, HeadData>({
  appComponent: () => <App />,
  // RFC 0004: headData is the route's attr.head payload (undefined when a route declares none,
  // or when the head loader degraded) - meta stays the static fallback layer.
  headContent: ({ headData, meta }) => `
    <title>${escapeHtml(headData?.ogTitle ?? (meta as { title?: string } | undefined)?.title ?? 'τjs playground')}</title>
    ${headData?.ogDescription ? `<meta name="description" content="${escapeHtml(headData.ogDescription)}">` : ''}
  `,
  enableDebug: process.env.NODE_ENV === 'development',
});
