import { dirname, join } from 'node:path';
import path from 'node:path'; /* separated import due to Istanbul coverage bug */
import { fileURLToPath } from 'node:url';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);

const DIR_SUFFIX = isDevelopment ? '..' : './';
export const __dirname = join(dirname(__filename), DIR_SUFFIX);
