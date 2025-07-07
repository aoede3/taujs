import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBuildConfigs, taujsBuild } from '@taujs/server/build';

import { taujsConfig } from './taujs.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await taujsBuild({
  clientBaseDir: path.resolve(__dirname, 'src/client'),
  configs: extractBuildConfigs(taujsConfig),
  projectRoot: __dirname,
});
