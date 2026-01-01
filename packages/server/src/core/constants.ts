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

export const REGEX = {
  SAFE_TRACE: /^[a-zA-Z0-9-_:.]{1,128}$/,
} as const satisfies Readonly<Record<string, RegExp>>;

export const ENTRY_EXTENSIONS = ['.ts', '.tsx'] as const;
