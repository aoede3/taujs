export const REGEX = {
  SAFE_TRACE: /^[a-zA-Z0-9-_:.]{1,128}$/,
} as const satisfies Readonly<Record<string, RegExp>>;

export const ENTRY_EXTENSIONS = ['.ts', '.tsx'] as const;
