export const RENDERTYPE = {
  ssr: 'ssr',
  streaming: 'streaming',
} as const;

export const REGEX = {
  SAFE_TRACE: /^[a-zA-Z0-9-_:.]{1,128}$/,
} as const satisfies Readonly<Record<string, RegExp>>;
