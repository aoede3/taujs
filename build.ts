import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { taujsBuild } from '@taujs/server/build';

import { configs } from './buildConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await taujsBuild({
  clientBaseDir: path.resolve(__dirname, 'src/client'),
  configs,
  projectRoot: __dirname,
});
