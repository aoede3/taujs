import * as fs from 'node:fs';
import path from 'node:path';

import { ENTRY_EXTENSIONS } from '../constants';

// A directory named like an entry (`entry-client.ts/`) must not resolve: existsSync is true for it.
const isRegularFile = (absPath: string): boolean => {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
};

export function resolveEntryFile(clientRoot: string, stem: string, exists: (absPath: string) => boolean = isRegularFile): string {
  for (const ext of ENTRY_EXTENSIONS) {
    const filename = `${stem}${ext}`;
    if (exists(path.join(clientRoot, filename))) return filename;
  }

  throw new Error(`Entry file "${stem}" not found in ${clientRoot}. Tried: ${ENTRY_EXTENSIONS.map((e) => stem + e).join(', ')}`);
}
