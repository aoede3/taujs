import * as fs from 'node:fs';
import path from 'node:path';

import { ENTRY_EXTENSIONS } from '../constants';

export function resolveEntryFile(clientRoot: string, stem: string, exists: (absPath: string) => boolean = fs.existsSync): string {
  for (const ext of ENTRY_EXTENSIONS) {
    const filename = `${stem}${ext}`;
    if (exists(path.join(clientRoot, filename))) return filename;
  }

  throw new Error(`Entry file "${stem}" not found in ${clientRoot}. Tried: ${ENTRY_EXTENSIONS.map((e) => stem + e).join(', ')}`);
}
