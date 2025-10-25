import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { taujsBuild } from '@taujs/server';

import config from './taujs.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await taujsBuild({
  clientBaseDir: path.resolve(__dirname, 'src/client'),
  config,
  projectRoot: __dirname,
});
