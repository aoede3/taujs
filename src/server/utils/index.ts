import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), !isDevelopment ? './' : '..');
