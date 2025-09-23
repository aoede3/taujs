import pc from 'picocolors';

import type { CSPDirectives } from './security/csp';

export const RENDERTYPE = {
  ssr: 'ssr',
  streaming: 'streaming',
} as const;

export const SSRTAG = {
  ssrHead: '<!--ssr-head-->',
  ssrHtml: '<!--ssr-html-->',
} as const;

export const TEMPLATE = {
  defaultEntryClient: 'entry-client',
  defaultEntryServer: 'entry-server',
  defaultHtmlTemplate: 'index.html',
} as const;

export const DEV_CSP_DIRECTIVES: CSPDirectives = {
  'default-src': ["'self'"],
  'connect-src': ["'self'", 'ws:', 'http:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
} as const;

export const CONTENT = {
  TAG: 'τjs',
} as const;

export const DEBUG = {
  auth: { label: 'auth', colour: pc.blue },
  errors: { label: 'errors', colour: pc.red },
  routes: { label: 'routes', colour: pc.cyan },
  trx: { label: 'trx', colour: pc.magenta },
  vite: { label: 'vite', colour: pc.yellow },
} as const;
