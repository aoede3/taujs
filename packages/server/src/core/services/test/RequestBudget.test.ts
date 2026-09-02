// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createRequestBudget } from '../RequestBudget';

// A hand-rolled monotonic clock: the ONLY time source these cells advance. `Date` is left
// untouched throughout, so any test that changes Date and still sees `remaining()` move would
// prove the clock is not actually injected.
const makeClock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRequestBudget', () => {
  it('fixes the deadline at creation against the injected clock', () => {
    const clock = makeClock(1_000);
    const budget = createRequestBudget({ budgetMs: 500, now: clock.now });

    expect(budget.deadline).toBe(1_500);
  });

  it('remaining() floors at 0 and never goes negative', () => {
    const clock = makeClock(0);
    const budget = createRequestBudget({ budgetMs: 100, now: clock.now });

    clock.advance(40);
    expect(budget.remaining()).toBe(60);

    clock.advance(1_000);
    expect(budget.remaining()).toBe(0);
  });

  it('is wall-clock independent: only the injected clock moves remaining(), never Date', () => {
    const clock = makeClock(0);
    const budget = createRequestBudget({ budgetMs: 1_000, now: clock.now });

    const realDateNow = Date.now;
    try {
      // Advance real wall-clock time far into the future - remaining() must not react.
      Date.now = () => realDateNow() + 10_000_000;
      expect(budget.remaining()).toBe(1_000);

      // Only advancing the injected monotonic clock changes remaining().
      clock.advance(250);
      expect(budget.remaining()).toBe(750);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('defaults `now` to the telemetry monotonic clock when omitted', () => {
    const budget = createRequestBudget({ budgetMs: 1_000 });

    expect(Number.isFinite(budget.deadline)).toBe(true);
    // Reuses the same clock reading the telemetry `now()` export would give right now, within a
    // small tolerance for the time the two calls take.
    expect(Math.abs(budget.deadline - (performance.now?.() ?? Date.now()) - 1_000)).toBeLessThan(1_000);
  });

  it('signal aborts exactly at the deadline, not before (fake timers)', () => {
    const clock = makeClock(0);
    const budget = createRequestBudget({ budgetMs: 100, now: clock.now });

    expect(budget.signal.aborted).toBe(false);

    vi.advanceTimersByTime(99);
    expect(budget.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(Error);
  });

  it('parent-signal abort propagates immediately and preserves the reason', () => {
    const parent = new AbortController();
    const budget = createRequestBudget({ budgetMs: 10_000, parentSignal: parent.signal });

    expect(budget.signal.aborted).toBe(false);

    const reason = new Error('parent gone');
    parent.abort(reason);

    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBe(reason);
  });

  it('constructs already-aborted when the parent signal is already aborted, with no timer created', () => {
    const parent = new AbortController();
    const reason = new Error('already gone');
    parent.abort(reason);

    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const setSpy = vi.spyOn(global, 'setTimeout');

    const budget = createRequestBudget({ budgetMs: 10_000, parentSignal: parent.signal });

    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBe(reason);
    expect(setSpy).not.toHaveBeenCalled();

    clearSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('cleans up the deadline timer and the parent listener when the DEADLINE fires first', () => {
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, 'removeEventListener');
    const clock = makeClock(0);

    const budget = createRequestBudget({ budgetMs: 50, parentSignal: parent.signal, now: clock.now });

    vi.advanceTimersByTime(50);
    expect(budget.signal.aborted).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // Further parent aborts (impossible in practice with `once`, but proves no leaked listener
    // could double-fire) and further timer advances are no-ops - nothing throws.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(() => parent.abort(new Error('late'))).not.toThrow();
  });

  it('cleans up the deadline timer when the PARENT aborts first', () => {
    const parent = new AbortController();
    const clock = makeClock(0);
    const clearSpy = vi.spyOn(global, 'clearTimeout');

    createRequestBudget({ budgetMs: 50, parentSignal: parent.signal, now: clock.now });

    parent.abort(new Error('bye'));

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('unrefs the deadline timer so it cannot hold the process open', () => {
    const unref = vi.fn();
    const setSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => ({ unref, [Symbol.toPrimitive]: () => 0 }) as any) as any);

    createRequestBudget({ budgetMs: 50 });

    expect(unref).toHaveBeenCalledTimes(1);
    setSpy.mockRestore();
  });

  describe('deadlineAt (an already-resolved absolute deadline)', () => {
    it('uses the given deadline verbatim instead of deriving one from budgetMs + now', () => {
      const clock = makeClock(500);
      const budget = createRequestBudget({ deadlineAt: 1_234, now: clock.now });

      expect(budget.deadline).toBe(1_234);
    });

    it('two budgets constructed at different "now" readings but the SAME deadlineAt share one absolute line', () => {
      const early = makeClock(0);
      const late = makeClock(90); // simulates real time having passed between the two constructions

      const capturedDeadline = 1_000; // e.g. captured once at admission via now() + requestBudgetMs
      const first = createRequestBudget({ deadlineAt: capturedDeadline, now: early.now });
      const second = createRequestBudget({ deadlineAt: capturedDeadline, now: late.now });

      expect(first.deadline).toBe(capturedDeadline);
      expect(second.deadline).toBe(capturedDeadline);
      // The second construction happened 90ms "later" on the clock - remaining() reflects that
      // directly, proving neither construction re-derived a fresh allowance from its own "now".
      expect(first.remaining()).toBe(1_000);
      expect(second.remaining()).toBe(910);
    });

    it('a deadlineAt already in the past constructs immediately aborted, the same as an exhausted budgetMs', () => {
      const clock = makeClock(2_000);
      const budget = createRequestBudget({ deadlineAt: 1_000, now: clock.now });

      expect(budget.remaining()).toBe(0);
      expect(budget.signal.aborted).toBe(true);
    });
  });

  describe('dispose()', () => {
    it('is idempotent: calling it more than once does not throw', () => {
      const budget = createRequestBudget({ budgetMs: 1_000 });

      expect(() => {
        budget.dispose();
        budget.dispose();
        budget.dispose();
      }).not.toThrow();
    });

    it('does NOT abort the signal', () => {
      const budget = createRequestBudget({ budgetMs: 1_000 });

      budget.dispose();

      expect(budget.signal.aborted).toBe(false);
    });

    it('does NOT change what remaining() reports - refusal stays pure clock math after disposal', () => {
      const clock = makeClock(0);
      const budget = createRequestBudget({ budgetMs: 100, now: clock.now });

      budget.dispose();

      clock.advance(40);
      expect(budget.remaining()).toBe(60);

      // Genuinely past the deadline: remaining() still reports 0, even though disposal happened
      // long before - a call made now must still refuse.
      clock.advance(1_000);
      expect(budget.remaining()).toBe(0);
    });

    it('clears the deadline timer: the deadline no longer fires signal after disposal', () => {
      const clock = makeClock(0);
      const budget = createRequestBudget({ budgetMs: 50, now: clock.now });

      budget.dispose();

      vi.advanceTimersByTime(10_000);
      expect(budget.signal.aborted).toBe(false);
    });

    it('removes the parent-signal listener: a later parent abort no longer reaches signal', () => {
      const parent = new AbortController();
      const budget = createRequestBudget({ budgetMs: 10_000, parentSignal: parent.signal });

      budget.dispose();

      parent.abort(new Error('too late, already disposed'));
      expect(budget.signal.aborted).toBe(false);
    });

    it('is a safe no-op when the signal already aborted before disposal', () => {
      const clock = makeClock(0);
      const budget = createRequestBudget({ budgetMs: 50, now: clock.now });

      vi.advanceTimersByTime(50);
      expect(budget.signal.aborted).toBe(true);

      expect(() => budget.dispose()).not.toThrow();
      expect(budget.signal.aborted).toBe(true); // still aborted - dispose never un-aborts
    });
  });

  describe('child(reserveMs)', () => {
    it('reserves time off the end: child remaining = parent remaining - reserve', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 1_000, now: clock.now });
      const child = parent.child(300);

      expect(child.deadline).toBe(parent.deadline - 300);
      expect(child.remaining()).toBe(700);
      expect(parent.remaining()).toBe(1_000);
    });

    it('a negative reserve floors at 0 (child deadline never exceeds the parent deadline)', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 1_000, now: clock.now });
      const child = parent.child(-500);

      expect(child.deadline).toBe(parent.deadline);
      expect(child.remaining()).toBe(1_000);
    });

    it('a child with an already-exhausted parent still constructs, and is immediately aborted', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 100, now: clock.now });
      clock.advance(200); // parent deadline has passed

      expect(parent.remaining()).toBe(0);

      const child = parent.child(0);
      expect(child.remaining()).toBe(0);
      expect(child.signal.aborted).toBe(true);
    });

    it('a reserve larger than what remains still constructs and is immediately aborted', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 1_000, now: clock.now });
      const child = parent.child(5_000);

      expect(child.remaining()).toBe(0);
      expect(child.signal.aborted).toBe(true);
    });

    it('the child never outlives the parent terminal: the child deadline can never exceed the parent deadline', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 100, now: clock.now });
      const child = parent.child(10);

      expect(child.signal.aborted).toBe(false);

      // The child's OWN (earlier, reserved) deadline fires first.
      vi.advanceTimersByTime(90);
      expect(child.signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);

      // The parent's own deadline then fires too - the child was never later than this.
      vi.advanceTimersByTime(10);
      expect(parent.signal.aborted).toBe(true);
    });

    it('the child never outlives an upstream parent-signal abort', () => {
      const upstream = new AbortController();
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 10_000, parentSignal: upstream.signal, now: clock.now });
      const child = parent.child(100);

      expect(child.signal.aborted).toBe(false);

      const reason = new Error('client disconnected');
      upstream.abort(reason);

      expect(parent.signal.aborted).toBe(true);
      expect(child.signal.aborted).toBe(true);
      expect(child.signal.reason).toBe(reason);
    });

    it('grandchildren compose: child-of-child reserves further off the same terminal', () => {
      const clock = makeClock(0);
      const parent = createRequestBudget({ budgetMs: 1_000, now: clock.now });
      const child = parent.child(200);
      const grandchild = child.child(300);

      expect(grandchild.deadline).toBe(parent.deadline - 200 - 300);
      expect(grandchild.remaining()).toBe(500);
    });
  });
});
