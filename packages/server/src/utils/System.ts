import { dirname, join } from 'node:path';
import path from 'node:path'; /* separated import due to Istanbul coverage bug */
import { fileURLToPath } from 'node:url';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), !isDevelopment ? './' : '..');

// RFC1918 ranges
export const isPrivateIPv4 = (addr: string): boolean => {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
  const [a, b, c, d] = addr.split('.').map(Number) as [number, number, number, number];

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12

  return false;
};
