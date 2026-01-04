// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

const originalPerformance = globalThis.performance;
const originalDateNow = Date.now;

afterEach(() => {
  (globalThis as any).performance = originalPerformance;
  Date.now = originalDateNow;
  vi.restoreAllMocks();
});

describe('telemetry/Telemetry', () => {
  it('now() uses performance.now() when available', async () => {
    const perfNow = vi.fn().mockReturnValue(123.45);
    (globalThis as any).performance = { now: perfNow };
    const dateNow = vi.fn().mockReturnValue(999999);
    Date.now = dateNow;

    const T = await import('../Telemetry');

    const t = T.now();

    expect(t).toBe(123.45);
    expect(perfNow).toHaveBeenCalledTimes(1);
    expect(dateNow).not.toHaveBeenCalled();
  });

  it('now() falls back to Date.now() when performance.now() is unavailable', async () => {
    (globalThis as any).performance = undefined;
    const dateNow = vi.fn().mockReturnValue(456789);
    Date.now = dateNow;

    const T = await import('../Telemetry');

    const t = T.now();

    expect(t).toBe(456789);
    expect(dateNow).toHaveBeenCalledTimes(1);
  });

  it('now() falls back to Date.now() when performance exists but now is missing', async () => {
    (globalThis as any).performance = {};
    const dateNow = vi.fn().mockReturnValue(42);
    Date.now = dateNow;

    const T = await import('../Telemetry');

    const t = T.now();

    expect(t).toBe(42);
    expect(dateNow).toHaveBeenCalledTimes(1);
  });
});
