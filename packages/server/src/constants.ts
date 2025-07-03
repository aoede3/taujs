import type { CSPDirectives } from './security/csp';

export const RENDERTYPE = {
  ssr: 'ssr',
  streaming: 'streaming',
};

export const SSRTAG = {
  ssrHead: '<!--ssr-head-->',
  ssrHtml: '<!--ssr-html-->',
};

export const TEMPLATE = {
  defaultEntryClient: 'entry-client',
  defaultEntryServer: 'entry-server',
  defaultHtmlTemplate: 'index.html',
};

export const DEV_CSP_DIRECTIVES: CSPDirectives = {
  'default-src': ["'self'"],
  'connect-src': ["'self'", 'ws:', 'http:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
};
