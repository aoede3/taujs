// @vitest-environment node
//
// RFC 0014 §5/§5.3/§5.4/§6, mutation standard: every cell here fails if its mechanism is
// reverted. Real `net.Socket`/`http.Server` throughout - never Fastify's `inject()`, which fakes
// the whole request/response and would prove nothing about a real socket's destroy/writable
// state. The happy-path and near-miss predicate cells drive a REAL listening `http.Server` with
// genuine HTTP Upgrade requests, so `req` is authentic; the structurally-unreachable parsing
// edges (missing/malformed URL - no real HTTP parser can produce them) pair a hand-built `req`
// with a REAL connected `net.Socket`, so `.destroyed`/`.destroy()` still exercise real teardown.

import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMediatedHmr } from '../utils/MediatedHmr';

import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logs } from '../core/logging/types';

const HMR_BASE = '/app/';

const makeLogger = (): { logger: Logs; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error,
    child: vi.fn(() => logger),
    isDebugEnabled: vi.fn(() => false),
  } as unknown as Logs;

  return { logger, warn, error };
};

/** A real listening `http.Server` standing in for the caller's own root. */
const listenRoot = async (): Promise<{ root: http.Server; port: number }> => {
  const root = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => root.listen(0, '127.0.0.1', resolve));

  return { root, port: (root.address() as AddressInfo).port };
};

/** A real connected client/server `net.Socket` pair, for the parsing edges no real HTTP request can produce. */
const connectedSocketPair = async (): Promise<{ serverSocket: net.Socket; clientSocket: net.Socket; close: () => void }> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const clientSocket = net.connect(port, '127.0.0.1');
  clientSocket.on('error', () => {});

  const [serverSocket] = await Promise.all([
    new Promise<net.Socket>((resolve) => server.once('connection', resolve)),
    new Promise<void>((resolve) => clientSocket.once('connect', () => resolve())),
  ]);

  return {
    serverSocket,
    clientSocket,
    close: () => {
      server.close();
      serverSocket.destroy();
      clientSocket.destroy();
    },
  };
};

const RAW_HANDSHAKE_HEADERS = (path: string, opts: { protocol?: string; omitProtocol?: boolean } = {}): string => {
  const lines = [
    `GET ${path} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  ];
  if (!opts.omitProtocol) lines.push(`Sec-WebSocket-Protocol: ${opts.protocol ?? 'vite-hmr'}`);

  return lines.join('\r\n') + '\r\n\r\n';
};

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const pending = closers.splice(0);
  await Promise.all(pending.map((close) => close()));
  vi.useRealTimers();
});

describe('MediatedHmr (RFC 0014) - the semantics table, real listeners throughout', () => {
  it('matches pathname + vite-hmr protocol: true, exactly one emit on source, delivered to the counted listener', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    let sourceEmits = 0;
    controller.source!.on('upgrade', (_req, socket) => {
      sourceEmits += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Handled-By: source\r\n\r\n');
    });

    let fallbackCount = 0;
    const upgraded = new Promise<{ result: boolean; req: IncomingMessage; socket: Duplex; head: Buffer }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        const result = controller.capability.tryHandleUpgrade(req, socket, head);
        if (!result) {
          fallbackCount += 1;
          socket.destroy();
        }
        resolve({ result, req, socket, head });
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    let responseBytes = '';
    client.on('data', (chunk) => (responseBytes += chunk.toString('utf8')));
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));

    const { result } = await upgraded;
    await vi.waitFor(() => expect(responseBytes).toContain('X-Handled-By: source'));

    expect(result).toBe(true);
    expect(sourceEmits).toBe(1);
    expect(fallbackCount).toBe(0);
  });

  it('a repeat offer of the same (now claimed) socket: true, ZERO additional emits', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    let sourceEmits = 0;
    controller.source!.on('upgrade', (_req, socket) => {
      sourceEmits += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });

    const captured = new Promise<{ req: IncomingMessage; socket: Duplex; head: Buffer }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        controller.capability.tryHandleUpgrade(req, socket, head);
        resolve({ req, socket, head });
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));

    const { req, socket, head } = await captured;
    await vi.waitFor(() => expect(sourceEmits).toBe(1));

    const second = controller.capability.tryHandleUpgrade(req, socket, head);
    const third = controller.capability.tryHandleUpgrade(req, socket, head);

    expect(second).toBe(true);
    expect(third).toBe(true);
    expect(sourceEmits).toBe(1);
  });

  it.each([
    ['pathname near-miss (/app for /app/)', HMR_BASE.slice(0, -1), { protocol: 'vite-hmr' }],
    ['protocol near-miss (vite-hmr2)', HMR_BASE, { protocol: 'vite-hmr2' }],
    ['missing sec-websocket-protocol', HMR_BASE, { omitProtocol: true }],
  ] as const)('%s: false, socket untouched, reaches the counted fallback', async (_label, path, opts) => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    let sourceEmits = 0;
    controller.source!.on('upgrade', (_req, socket) => {
      sourceEmits += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });

    let fallbackCount = 0;
    const outcome = new Promise<{ result: boolean; socket: Duplex }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        const result = controller.capability.tryHandleUpgrade(req, socket, head);
        resolve({ result, socket });

        if (!result) {
          fallbackCount += 1;
          // Proves the socket was left untouched: τjs never wrote to or destroyed it.
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Handled-By: fallback\r\n\r\n');
        }
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    let responseBytes = '';
    client.on('data', (chunk) => (responseBytes += chunk.toString('utf8')));
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(path, opts)));

    const { result, socket } = await outcome;

    expect(result).toBe(false);
    expect(sourceEmits).toBe(0);
    expect(socket.destroyed).toBe(false);
    expect(socket.writable).toBe(true);
    await vi.waitFor(() => expect(responseBytes).toContain('X-Handled-By: fallback'));
    expect(fallbackCount).toBe(1);
  });

  it('missing req.url: false, socket untouched', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { serverSocket, close } = await connectedSocketPair();
    closers.push(close);

    const req = { url: undefined, headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    const result = controller.capability.tryHandleUpgrade(req, serverSocket, Buffer.alloc(0));

    expect(result).toBe(false);
    expect(serverSocket.destroyed).toBe(false);
  });

  it('malformed req.url (URL parse failure): false, socket untouched', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { serverSocket, close } = await connectedSocketPair();
    closers.push(close);

    // `new URL('http://x' + rawUrl)` throws for a raw URL carrying an unescaped space.
    const req = { url: '/app/ not a url', headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    const result = controller.capability.tryHandleUpgrade(req, serverSocket, Buffer.alloc(0));

    expect(result).toBe(false);
    expect(serverSocket.destroyed).toBe(false);
  });

  it('unclaimed + destroyed socket: false (even with a matching path/protocol - destroyed is checked before parsing)', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { serverSocket, close } = await connectedSocketPair();
    closers.push(close);

    serverSocket.destroy();
    const req = { url: HMR_BASE, headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    const result = controller.capability.tryHandleUpgrade(req, serverSocket, Buffer.alloc(0));

    expect(result).toBe(false);
  });

  it('§5.3 containment: a synchronous throw in the source listener is logged, the claimed socket is destroyed, true is returned, and the caller sees no exception', async () => {
    const { logger, error } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    controller.source!.on('upgrade', () => {
      throw new Error('boom - vite listener failure');
    });

    let thrownToCaller: unknown;
    const outcome = new Promise<{ result: boolean; socket: Duplex }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        let result = false;
        try {
          result = controller.capability.tryHandleUpgrade(req, socket, head);
        } catch (err) {
          thrownToCaller = err;
        }
        resolve({ result, socket });
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));
    client.on('error', () => {});

    const { result, socket } = await outcome;

    expect(thrownToCaller).toBeUndefined();
    expect(result).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ component: 'mediated-hmr' }), expect.stringContaining('failed to hand a claimed upgrade'));
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it('§5.3 containment: source.emit returning false (no listener) is an invariant failure - logged, claimed socket destroyed, true returned', async () => {
    const { logger, error } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });
    // Deliberately NO listener on controller.source - the lifecycle-ordering invariant this
    // containment path exists for, even though correct wiring makes it unreachable in product use.

    const outcome = new Promise<{ result: boolean; socket: Duplex }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        const result = controller.capability.tryHandleUpgrade(req, socket, head);
        resolve({ result, socket });
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));
    client.on('error', () => {});

    const { result, socket } = await outcome;

    expect(result).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ component: 'mediated-hmr' }), expect.stringContaining('invariant failure'));
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it('§5.3 containment: a logger that throws during containment still returns true and still destroys the socket', async () => {
    const throwingLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger is broken');
      }),
      error: vi.fn(() => {
        throw new Error('logger is broken');
      }),
      child: vi.fn(),
      isDebugEnabled: vi.fn(() => false),
    } as unknown as Logs;
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger: throwingLogger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    controller.source!.on('upgrade', () => {
      throw new Error('boom');
    });

    let thrownToCaller: unknown;
    const outcome = new Promise<{ result: boolean; socket: Duplex }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        let result = false;
        try {
          result = controller.capability.tryHandleUpgrade(req, socket, head);
        } catch (err) {
          thrownToCaller = err;
        }
        resolve({ result, socket });
      });
    });

    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    closers.push(() => {
      client.destroy();
    });
    client.on('connect', () => client.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));
    client.on('error', () => {});

    const { result, socket } = await outcome;

    expect(thrownToCaller).toBeUndefined();
    expect(result).toBe(true);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it('closing semantics: unclaimed -> false after beginClosing(); a previously claimed socket still -> true, no emit', async () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });
    const { root, port } = await listenRoot();
    closers.push(() => {
      root.close();
    });

    let sourceEmits = 0;
    controller.source!.on('upgrade', (_req, socket) => {
      sourceEmits += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });

    // First: a real claim, before closing.
    const claimed = new Promise<{ req: IncomingMessage; socket: Duplex; head: Buffer }>((resolve) => {
      root.once('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        controller.capability.tryHandleUpgrade(req, socket, head);
        resolve({ req, socket, head });
      });
    });
    const claimant = net.connect(port, '127.0.0.1');
    claimant.on('error', () => {});
    closers.push(() => {
      claimant.destroy();
    });
    claimant.on('connect', () => claimant.write(RAW_HANDSHAKE_HEADERS(HMR_BASE)));
    const { req: claimedReq, socket: claimedSocket, head: claimedHead } = await claimed;
    await vi.waitFor(() => expect(sourceEmits).toBe(1));

    controller.beginClosing();

    // An UNCLAIMED offer after closing: false, regardless of predicate match.
    const { serverSocket: unclaimedSocket, close } = await connectedSocketPair();
    closers.push(close);
    const freshReq = { url: HMR_BASE, headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    expect(controller.capability.tryHandleUpgrade(freshReq, unclaimedSocket, Buffer.alloc(0))).toBe(false);
    expect(sourceEmits).toBe(1);

    // The already-claimed socket: still true, no re-emission.
    expect(controller.capability.tryHandleUpgrade(claimedReq, claimedSocket, claimedHead)).toBe(true);
    expect(sourceEmits).toBe(1);
  });
});

describe('MediatedHmr (RFC 0014) - inert configuration allocates no live resource', () => {
  it('inert: capability returns false, no source, noteClientServed/beginClosing are no-ops, no timer is ever created', () => {
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: false, hmrBase: HMR_BASE, logger });

    expect(controller.source).toBeUndefined();
    expect(controller.capability.tryHandleUpgrade({} as IncomingMessage, {} as any, Buffer.alloc(0))).toBe(false);

    const handlesBefore = (process as any)._getActiveHandles().length;
    controller.noteClientServed();
    controller.beginClosing();
    controller.noteClientServed();
    const handlesAfter = (process as any)._getActiveHandles().length;

    expect(handlesAfter).toBe(handlesBefore);
  });
});

describe('MediatedHmr (RFC 0014) §6 - never-wired visibility', () => {
  it('noteClientServed() then a matching claim before the deadline: the warning is cancelled, never fires', async () => {
    vi.useFakeTimers();
    const { logger, warn } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });

    controller.source!.on('upgrade', (_req, socket) => socket.destroy());
    controller.noteClientServed();

    vi.advanceTimersByTime(2000);
    const socket = { destroyed: false, destroy: vi.fn() } as unknown as net.Socket;
    const req = { url: HMR_BASE, headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    expect(controller.capability.tryHandleUpgrade(req, socket, Buffer.alloc(0))).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('noteClientServed() then only a NON-matching offer before the deadline: the warning still fires (an offer is not a claim)', async () => {
    vi.useFakeTimers();
    const { logger, warn } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });

    controller.noteClientServed();

    const socket = { destroyed: false, destroy: vi.fn() } as unknown as net.Socket;
    const req = { url: '/not-hmr', headers: { 'sec-websocket-protocol': 'vite-hmr' } } as unknown as IncomingMessage;
    expect(controller.capability.tryHandleUpgrade(req, socket, Buffer.alloc(0))).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('dev.hmr.tryHandleUpgrade');
  });

  it('noteClientServed() with no offer at all: fires exactly once at the 5s deadline', async () => {
    vi.useFakeTimers();
    const { logger, warn } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });

    controller.noteClientServed();
    vi.advanceTimersByTime(4999);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // A second call is a no-op: no second warning, ever.
    controller.noteClientServed();
    vi.advanceTimersByTime(10_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('beginClosing() before the deadline: no warning, no active timer remains', async () => {
    vi.useFakeTimers();
    const { logger, warn } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });

    controller.noteClientServed();
    vi.advanceTimersByTime(1000);
    controller.beginClosing();

    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the warning timer is unref()-ed so it never holds the process open', () => {
    vi.useRealTimers();
    const { logger } = makeLogger();
    const controller = createMediatedHmr({ active: true, hmrBase: HMR_BASE, logger });

    const realSetTimeout = global.setTimeout;
    let captured: NodeJS.Timeout | undefined;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number) => {
      captured = realSetTimeout(fn, ms);
      return captured;
    }) as unknown as typeof setTimeout);

    controller.noteClientServed();
    spy.mockRestore();

    expect(captured).toBeDefined();
    expect(captured!.hasRef()).toBe(false);

    controller.beginClosing();
  });
});
