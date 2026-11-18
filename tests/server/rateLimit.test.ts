// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../server/lib/rateLimit";

describe("createRateLimiter", () => {
  it("allows exactly limit hits, then blocks", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => 0 });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
    expect(limiter.hit("k")).toBe(false);
  });

  it("starts a fresh window after windowMs", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => clock });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);

    clock = 999;
    expect(limiter.hit("k")).toBe(false);

    clock = 1_000;
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    expect(limiter.hit("b")).toBe(false);
  });

  it("keeps working after many distinct keys and window rollover", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => clock });
    for (let i = 0; i < 5_000; i += 1) {
      expect(limiter.hit(`k${i}`)).toBe(true);
    }
    clock = 2_000;
    expect(limiter.hit("k0")).toBe(true);
    expect(limiter.hit("k0")).toBe(false);
    expect(limiter.hit("fresh")).toBe(true);
  });

  it("defaults to the real clock", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
  });

  it("never grows past its capacity", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 1_000,
      capacity: 3,
      now: () => clock,
    });
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(3);

    clock = 5_000;
    for (let i = 0; i < 100; i += 1) limiter.hit(`fresh${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });

  it("bounds the map with the default capacity under a key flood", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, now: () => 0 });
    for (let i = 0; i < 10_500; i += 1) limiter.hit(`k${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });

  it("fails closed for new keys when the map is full and nothing expired", () => {
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 60_000,
      capacity: 2,
      now: () => 0,
    });
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    // 容量已满且无过期桶：淘汰最旧的桶，新 key 以“已超限”状态落桶并直接拒绝。
    expect(limiter.hit("c")).toBe(false);
    expect(limiter.size()).toBe(2);
    // 同一个新 key 的后续尝试仍然被拒绝，不会因为一次失败就放行。
    expect(limiter.hit("c")).toBe(false);
    // 未被淘汰的桶仍然按正常限额工作。
    expect(limiter.hit("b")).toBe(true);
  });

  it("blocked() reports over-limit keys without inserting or counting", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
    expect(limiter.blocked("a")).toBe(false);
    expect(limiter.size()).toBe(0);

    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    expect(limiter.blocked("a")).toBe(true);
    expect(limiter.blocked("b")).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it("does not count hits on an already-blocked key", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => clock });
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    // 窗口到期后重新计数，说明超限期间没有把桶推到未来或删除。
    clock = 1_000;
    expect(limiter.hit("a")).toBe(true);
  });

  it("falls back to safe defaults for non-finite parameters", () => {
    const limiter = createRateLimiter({
      limit: Number.NaN,
      windowMs: Number.POSITIVE_INFINITY,
      capacity: Number.NEGATIVE_INFINITY,
      now: () => 0,
    });
    // 非法 limit 回退为 1（最严格），不会抛错，也不会因 Infinity 让 Map 无界。
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    for (let i = 0; i < 10_100; i += 1) limiter.hit(`k${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });
});
