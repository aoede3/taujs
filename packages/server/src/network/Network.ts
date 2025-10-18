import pc from 'picocolors';
import { networkInterfaces } from 'node:os';

import { CONTENT } from '../constants';
import { createLogger } from '../logging/Logger';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { DebugConfig } from '../logging/Logger';

type BannerPluginOpts = {
  debug?: DebugConfig;
  hmr?: { host: string; port: number };
};

// RFC1918 ranges
const isPrivateIPv4 = (addr: string): boolean => {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
  const [a, b, _c, _d] = addr.split('.').map(Number) as [number, number, number, number];

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12

  return false;
};

export const bannerPlugin: FastifyPluginAsync<BannerPluginOpts> = async (fastify, options) => {
  const logger = createLogger({ debug: options.debug });
  const dbgNetwork = logger.isDebugEnabled('network');

  fastify.decorate('showBanner', function showBanner(this: FastifyInstance) {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return;

    const { address, port } = addr;
    const boundHost = address === '::1' ? 'localhost' : address === '::' ? '::' : address === '0.0.0.0' ? '0.0.0.0' : address;

    console.log(`┃ Local    ${pc.bold(`http://localhost:${port}/`)}`);

    if (boundHost === 'localhost' || boundHost === '127.0.0.1') {
      console.log('┃ Network  use --host to expose\n');

      return;
    }

    const nets = networkInterfaces();
    let networkAddress: string | null = null;

    for (const ifaces of Object.values(nets)) {
      if (!ifaces) continue;

      for (const iface of ifaces) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        if (isPrivateIPv4(iface.address)) {
          networkAddress = iface.address;
          break;
        }
        if (!networkAddress) networkAddress = iface.address;
      }
      if (networkAddress && isPrivateIPv4(networkAddress)) break;
    }

    if (networkAddress) {
      console.log(`┃ Network  http://${networkAddress}:${port}/\n`);
      if (dbgNetwork) logger.warn(pc.yellow(`${CONTENT.TAG} [network] Dev server exposed on network - for local testing only.`));
    }

    logger.info(pc.green(`${CONTENT.TAG} [network] Bound to host: ${boundHost}`));
  });

  fastify.addHook('onReady', async function () {
    if (this.server.listening) {
      this.showBanner();
      return;
    }
    this.server.once('listening', () => this.showBanner());
  });
};
