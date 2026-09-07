import { createRenderer } from '@taujs/html';

/**
 * @taujs/html provides NO escaping helper: the returned HTML is written to the response VERBATIM,
 * so any value interpolated from `data`/`meta` (services or user input) is the APPLICATION's own
 * responsibility to escape. This three-line escaper is that responsibility, made local and explicit.
 */
const escape = (value: unknown): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type ContentData = { message?: string; timestamp?: string };

export const { renderSSR, renderStream } = createRenderer<ContentData>({
  render: ({ data, meta }) => ({
    headContent: `<title>${escape((meta as { title?: string }).title ?? 'τjs HTML playground')}</title>`,
    appHtml: `<section><p id="message">${escape(data.message ?? '')}</p><p id="timestamp">${escape(data.timestamp ?? '')}</p></section>`,
  }),
  // Factory-only, applies to every streaming call this renderer instance makes (the `/deferred` and
  // `/deferred-no-hydrate` routes' shared budget).
  streamOptions: { deferredTimeoutMs: 500 },
});
