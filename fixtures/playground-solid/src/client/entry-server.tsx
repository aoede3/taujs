import { createRenderer, escapeHtml } from '@taujs/solid';

import { App, type RouteData } from './App';
import { RENDER_ID } from './renderId';

type HeadData = { ogTitle?: string; ogDescription?: string };

export const { renderSSR, renderStream } = createRenderer<RouteData, unknown, HeadData>({
  appComponent: ({ location }) => <App location={location} />,
  renderId: RENDER_ID,
  // `headContent` returns RAW head HTML, so every interpolated value is escaped. The renderer
  // appends Solid's hydration bootstrap to this result itself (design 4) - the app does not.
  headContent: ({ data, headData, meta }) => `
    <title>${escapeHtml(headData?.ogTitle ?? data?.title ?? (meta as { title?: string } | undefined)?.title ?? 'τjs Solid playground')}</title>
    ${headData?.ogDescription ? `<meta name="description" content="${escapeHtml(headData.ogDescription)}">` : ''}
  `,
});
