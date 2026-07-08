// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  netsMock: vi.fn(),
  createLoggerMock: vi.fn(),
}));

vi.mock('picocolors', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
  },
}));

vi.mock('node:os', () => ({
  networkInterfaces: hoisted.netsMock,
}));
vi.mock('../../constants', () => ({
  CONTENT: { TAG: 'τjs' },
}));
vi.mock('../../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
}));

import { bannerPlugin } from '../Network';

const { netsMock, createLoggerMock } = hoisted;

describe('bannerPlugin', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    netsMock.mockReset();
    createLoggerMock.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function makeFastify(server: { address: () => any; listening: boolean; once?: (event: string, cb: () => void) => void }) {
    const hooks: Record<string, Function> = {};
    const f = {
      server,
      decorate(name: string, fn: any) {
        this[name] = fn;
      },
      addHook(name: string, fn: Function) {
        hooks[name] = fn;
      },
      _hooks: hooks,
    } as any;
    return f;
  }

  function makeLogger({ dbgNetwork }: { dbgNetwork: boolean }) {
    const info = vi.fn();
    const warn = vi.fn();
    createLoggerMock.mockReturnValue({
      isDebugEnabled: vi.fn().mockReturnValue(dbgNetwork),
      info,
      warn,
    });
    return { info, warn };
  }

  it('early-return when server.address() is falsy or a string', async () => {
    makeLogger({ dbgNetwork: false });
    netsMock.mockReturnValue({});

    const f1 = makeFastify({
      address: () => undefined,
      listening: true,
    });
    await bannerPlugin(f1 as any, {});
    f1.showBanner();
    expect(console.log).not.toHaveBeenCalled();

    makeLogger({ dbgNetwork: false });
    const f2 = makeFastify({
      address: () => '/tmp/socket',
      listening: true,
    });
    await bannerPlugin(f2 as any, {});
    f2.showBanner();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('boundHost maps ::1 -> localhost and returns after "use --host"', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: true });
    netsMock.mockReturnValue({});

    const f = makeFastify({
      address: () => ({ address: '::1', port: 5173 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    expect(console.log).toHaveBeenCalledTimes(2);
    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:5173/');
    expect((console.log as any).mock.calls[1][0]).toBe('┃ Network  use --host to expose\n');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('non-local host (0.0.0.0) with PRIVATE IPv4 found -> prints Network URL, warn if dbg on, info bound host', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: true });

    netsMock.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '8.8.8.8', family: 'IPv4', internal: false },
        { address: '192.168.1.42', family: 'IPv4', internal: false },
      ],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 3000 }),
      listening: true,
    });

    await bannerPlugin(f as any, { debug: true });
    f.showBanner();

    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:3000/');
    const netCall = (console.log as any).mock.calls.find((c: any[]) => String(c[0]).startsWith('┃ Network  http://'))!;
    expect(netCall[0]).toBe('┃ Network  http://192.168.1.42:3000/\n');

    expect(warn).toHaveBeenCalledTimes(1); // dbgNetwork = true
    expect(info).toHaveBeenCalledTimes(1);
    expect((info as any).mock.calls[0][1]).toContain('[network] Bound to host: 0.0.0.0');
  });

  it('non-local host, NO private IPv4 -> use first IPv4, no warn if dbg off, still info', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: false });

    netsMock.mockReturnValue({
      en0: [
        { address: 'abc', family: 'IPv4', internal: false }, // first IPv4 (kept if no private later)
        { address: '172.15.0.1', family: 'IPv4', internal: false }, // not private (below 16)
        { address: '8.8.4.4', family: 'IPv4', internal: false }, // later IPv4, but first was kept
      ],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 4000 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:4000/');
    const netLine = (console.log as any).mock.calls.find((c: any[]) => String(c[0]).includes('┃ Network'))!;
    expect(netLine[0]).toBe('┃ Network  http://abc:4000/\n');

    expect(warn).not.toHaveBeenCalled(); // dbgNetwork = false
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('non-local host but NO external IPv4 at all -> no Network line, still info', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: true });

    netsMock.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      enX: [{ address: 'fe80::abcd', family: 'IPv6', internal: false }],
    });

    const f = makeFastify({
      address: () => ({ address: '::', port: 1234 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:1234/');
    const anyNetworkLine = (console.log as any).mock.calls.some((c: any[]) => String(c[0]).startsWith('┃ Network'));
    expect(anyNetworkLine).toBe(false);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect((info as any).mock.calls[0][1]).toContain('Bound to host: ::');
  });

  it('onReady: calls showBanner immediately when already listening', async () => {
    makeLogger({ dbgNetwork: false });
    netsMock.mockReturnValue({});

    const f = makeFastify({
      address: () => ({ address: '::1', port: 7000 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    // Trigger onReady
    await f._hooks.onReady.call(f);

    // ::1 path prints two lines then returns
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  it('onReady: attaches once("listening") and triggers later when not listening', async () => {
    makeLogger({ dbgNetwork: false });
    netsMock.mockReturnValue({});

    let onceHandler: (() => void) | undefined;
    const f = makeFastify({
      address: () => ({ address: '::1', port: 7100 }),
      listening: false,
      once: (_event: string, cb: () => void) => {
        onceHandler = cb;
      },
    });

    await bannerPlugin(f as any, {});
    expect(console.log).not.toHaveBeenCalled();

    // Install handler via onReady, THEN fire the event
    await f._hooks.onReady.call(f);
    onceHandler?.();

    expect(console.log).toHaveBeenCalledTimes(2);
    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:7100/');
    expect((console.log as any).mock.calls[1][0]).toBe('┃ Network  use --host to expose\n');
  });

  it('prefers private 10.x.x.x network address', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: false });

    netsMock.mockReturnValue({
      en0: [
        { address: '8.8.8.8', family: 'IPv4', internal: false },
        { address: '10.23.45.67', family: 'IPv4', internal: false }, // <- private /8
      ],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 5050 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    const netLine = (console.log as any).mock.calls.find((c: any[]) => String(c[0]).startsWith('┃ Network'));
    expect(netLine?.[0]).toBe('┃ Network  http://10.23.45.67:5050/\n'); // hits 10/8 branch
    expect(info).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('detects private 172.16-31.x.x (172.16.0.0/12)', async () => {
    makeLogger({ dbgNetwork: false });

    netsMock.mockReturnValue({
      en0: [
        { address: '172.16.8.9', family: 'IPv4', internal: false }, // <- private /12
        { address: '8.8.4.4', family: 'IPv4', internal: false },
      ],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 6060 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    const netLine = (console.log as any).mock.calls.find((c: any[]) => String(c[0]).startsWith('┃ Network'));
    expect(netLine?.[0]).toBe('┃ Network  http://172.16.8.9:6060/\n'); // hits 172.16-31 branch
  });

  it('skips falsy interface lists (ifaces) via continue and still prints first IPv4 later', async () => {
    makeLogger({ dbgNetwork: false });

    netsMock.mockReturnValue({
      lo: null, // <- triggers "if (!ifaces) continue"
      enDummy: undefined, // <- triggers "continue" again
      en1: [
        { address: '203.0.113.5', family: 'IPv4', internal: false }, // first usable IPv4
      ],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 7070 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    // @ts-ignore
    f.showBanner();

    const netLine = (console.log as any).mock.calls.find((c: any[]) => String(c[0]).startsWith('┃ Network'));
    expect(netLine?.[0]).toBe('┃ Network  http://203.0.113.5:7070/\n'); // loop visited the falsy lists
  });

  it('boundHost maps "0.0.0.0" → "0.0.0.0" (no external IPv4 found)', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: false });

    // No usable external IPv4s → no "Network" line
    netsMock.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      enX: [{ address: 'fe80::abcd', family: 'IPv6', internal: false }],
    });

    const f = makeFastify({
      address: () => ({ address: '0.0.0.0', port: 9090 }),
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    // Local line always prints
    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:9090/');

    // No Network line printed
    const anyNetworkLine = (console.log as any).mock.calls.some((c: any[]) => String(c[0]).startsWith('┃ Network'));
    expect(anyNetworkLine).toBe(false);

    // Critically: info includes the mapped boundHost "0.0.0.0" (hits the specific ternary arm)
    expect(info).toHaveBeenCalledTimes(1);
    expect((info as any).mock.calls[0][1]).toContain('[network] Bound to host: 0.0.0.0');

    // No dbg warn
    expect(warn).not.toHaveBeenCalled();
  });

  it('boundHost falls through to raw address when not ::1/::/0.0.0.0 (hits ": address")', async () => {
    const { info, warn } = makeLogger({ dbgNetwork: false });

    // Interfaces can be anything; not relevant to ternary, but include one IPv4 so a Network line prints
    netsMock.mockReturnValue({
      en0: [{ address: '203.0.113.10', family: 'IPv4', internal: false }],
    });

    // IMPORTANT: server is bound to a concrete non-local, non-any address
    const f = makeFastify({
      address: () => ({ address: '198.51.100.9', port: 8181 }), // TEST-NET-2 address
      listening: true,
    });

    await bannerPlugin(f as any, {});
    f.showBanner();

    // Local line always prints
    expect((console.log as any).mock.calls[0][0]).toBe('┃ Local    http://localhost:8181/');

    // A Network line likely prints (but it's not required to prove the ternary branch)
    const infoMsg = (info as any).mock.calls[0][1] as string;

    // Critically proves we used the ": address" arm
    expect(infoMsg).toContain('[network] Bound to host: 198.51.100.9');

    expect(warn).not.toHaveBeenCalled();
  });
});
