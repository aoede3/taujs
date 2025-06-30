import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginReact } from '@taujs/react/plugin';
import { taujsBuild } from '@taujs/server/build';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = [
  { appId: 'root', entryPoint: '', plugins: [pluginReact()] },
  { appId: 'mfe', entryPoint: '@admin', plugins: [pluginReact()] },
];

await taujsBuild({
  config,
  projectRoot: __dirname,
  clientBaseDir: path.resolve(__dirname, 'src/client'),
});
