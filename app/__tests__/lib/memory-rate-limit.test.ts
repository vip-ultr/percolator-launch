import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";

describe("createMemoryRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
  });

  it("blocks requests over the limit", () => {
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
    // 3rd call exceeds limit of 2
    expect(limiter.isLimited("1.2.3.4")).toBe(true);
  });

  it("resets after window expires", () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 10_000 });
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
    expect(limiter.isLimited("1.2.3.4")).toBe(true);

    // Advance time past the window
    vi.advanceTimersByTime(10_001);
    expect(limiter.isLimited("1.2.3.4")).toBe(false);
  });

  it("isolates keys from each other", () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.isLimited("ip-a")).toBe(false);
    expect(limiter.isLimited("ip-a")).toBe(true);
    // Different key should not be limited
    expect(limiter.isLimited("ip-b")).toBe(false);
  });

  it("reports remaining correctly", () => {
    const limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.remaining("1.2.3.4")).toBe(3);
    limiter.isLimited("1.2.3.4");
    expect(limiter.remaining("1.2.3.4")).toBe(2);
    limiter.isLimited("1.2.3.4");
    expect(limiter.remaining("1.2.3.4")).toBe(1);
    limiter.isLimited("1.2.3.4");
    expect(limiter.remaining("1.2.3.4")).toBe(0);
  });

  it("evicts stale entries when threshold exceeded", () => {
    const limiter = createMemoryRateLimiter({
      limit: 100,
      windowMs: 1000,
      evictionThreshold: 5,
    });

    // Fill 6 unique keys
    for (let i = 0; i < 6; i++) {
      limiter.isLimited(`ip-${i}`);
    }

    // Advance time past window so all entries are stale
    vi.advanceTimersByTime(1001);

    // Next call should trigger eviction and work fine
    expect(limiter.isLimited("ip-new")).toBe(false);
  });
});
