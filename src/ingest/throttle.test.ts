import { afterEach, describe, expect, it, vi } from "vitest";
import { Throttle } from "./throttle.js";

afterEach(() => vi.useRealTimers());

describe("Throttle", () => {
  it("spaces concurrent callers, including a clock starting at zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const throttle = new Throttle({ minSpacingMs: 100 });
    const starts: number[] = [];
    const requests = Array.from({ length: 4 }, async () => {
      await throttle.wait();
      starts.push(Date.now());
    });
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    expect(starts).toEqual([0, 100, 200, 300]);
  });

  it("allows the next request immediately after an idle period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const throttle = new Throttle({ minSpacingMs: 100 });
    await throttle.wait();
    vi.setSystemTime(1000);
    await throttle.wait();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers after an injected sleep rejects", async () => {
    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("cancelled"))
      .mockResolvedValue(undefined);
    const throttle = new Throttle({ minSpacingMs: 100, now: () => 0, sleep });
    await throttle.wait();
    await expect(throttle.wait()).rejects.toThrow("cancelled");
    await expect(throttle.wait()).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
