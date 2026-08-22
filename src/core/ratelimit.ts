/** 内存令牌桶限流:按租户/IP/设备分桶。 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacityPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 消耗 1 个令牌,够用返回 true。 */
  allow(key: string): boolean {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacityPerMinute, lastRefill: now };
      this.buckets.set(key, b);
    }
    const refill = ((now - b.lastRefill) / 60_000) * this.capacityPerMinute;
    if (refill > 0) {
      b.tokens = Math.min(this.capacityPerMinute, b.tokens + refill);
      b.lastRefill = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** 定期清理闲置桶(避免内存缓慢增长)。 */
  sweep(idleMs = 10 * 60_000): void {
    const now = this.now();
    for (const [k, b] of [...this.buckets]) {
      if (now - b.lastRefill > idleMs && b.tokens >= this.capacityPerMinute) this.buckets.delete(k);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
