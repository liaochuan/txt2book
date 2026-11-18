/**
 * 进程内固定窗口限流器（设计文档 §13.2）。
 *
 * 单实例部署无需共享状态，因此用 `Map` 保存每个 key 的计数与窗口结束时间。
 * 过期桶会在窗口滚动时清理；同时设置硬容量上限（默认 10_000 桶），
 * 容量满时淘汰最旧的桶并对新 key fail closed，保证 Map 不会无限增长。
 */

export interface RateLimiterOptions {
  /** 每个窗口允许的命中次数；非法值回退为 1（最严格）。 */
  limit: number;
  /** 窗口长度，毫秒；非法值回退为 60 秒。 */
  windowMs: number;
  /** 桶数量硬上限，默认 10_000；非法值回退为默认值。 */
  capacity?: number;
  /** 当前时间来源，默认 `Date.now`；测试可注入假时钟。 */
  now?: () => number;
}

export interface RateLimiter {
  /** 记录一次命中；仍在限额内返回 `true`，超限或容量满时返回 `false`。 */
  hit(key: string): boolean;
  /** 只读检查：key 当前是否已超限；不计数、不插入、不改变状态。 */
  blocked(key: string): boolean;
  /** 当前桶数量，仅用于诊断与测试。 */
  size(): number;
}

interface Bucket {
  count: number;
  /** 当前窗口的结束时间（不含），到达后计数重置。 */
  resetAt: number;
}

const DEFAULT_CAPACITY = 10_000;
const DEFAULT_LIMIT = 1;
const DEFAULT_WINDOW_MS = 60_000;

/** 读取正整数参数；非有限值、非数字或小于 1 时回退安全默认值。 */
function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const limit = readPositiveInteger(options.limit, DEFAULT_LIMIT);
  const windowMs = readPositiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const capacity = readPositiveInteger(options.capacity, DEFAULT_CAPACITY);
  const now = options.now ?? Date.now;

  const buckets = new Map<string, Bucket>();
  // 下一次清理时间；只在时间越过窗口边界时扫描一次 Map，避免每次命中都 O(n)。
  let nextPruneAt = now() + windowMs;

  /** 全量删除已过期的桶。 */
  function pruneExpired(current: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= current) buckets.delete(key);
    }
  }

  /** 按窗口节奏做一次过期清理（每次命中只是 O(1) 的时间判断）。 */
  function pruneIfDue(current: number): void {
    if (current < nextPruneAt) return;
    nextPruneAt = current + windowMs;
    pruneExpired(current);
  }

  /** 淘汰最旧的桶（Map 保持插入顺序；窗口重置会重新插入到末尾）。 */
  function evictOldest(): void {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }

  return {
    hit(key: string): boolean {
      const current = now();
      pruneIfDue(current);

      const existing = buckets.get(key);
      if (existing !== undefined && current < existing.resetAt) {
        if (existing.count >= limit) return false;
        existing.count += 1;
        return true;
      }

      // 过期或不存在：先移除旧桶，再按新桶处理。
      if (existing !== undefined) buckets.delete(key);

      if (buckets.size >= capacity) {
        // 容量满：先强制清理一次过期桶，仍满则淘汰最旧的桶。
        pruneExpired(current);
        if (buckets.size >= capacity) {
          evictOldest();
          // fail closed：为新 key 落一个“已超限”的桶，保证同一 key 的后续尝试
          // 在窗口内继续被拒绝，而 Map 大小仍不超过 capacity。
          buckets.set(key, { count: limit, resetAt: current + windowMs });
          return false;
        }
      }

      buckets.set(key, { count: 1, resetAt: current + windowMs });
      return true;
    },

    blocked(key: string): boolean {
      const bucket = buckets.get(key);
      if (bucket === undefined) return false;
      return now() < bucket.resetAt && bucket.count >= limit;
    },

    size(): number {
      return buckets.size;
    },
  };
}
