import path from 'node:path';
import { taujsBuild } from '@taujs/server';
import config from './taujs.config.ts';

await taujsBuild({
  clientBaseDir: path.resolve(process.cwd(), 'src/client'),
  config,
  projectRoot: process.cwd(),
});
