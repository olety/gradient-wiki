import { DurableObject } from "cloudflare:workers";

// One Durable Object per bucket: ip:/rep: salted hashes, key: hashes, or ns: names.
// Reports use their own hour window so ordinary writes do not consume the report allowance.
// Sliding window kept in memory: the object is evicted after idle time and the window
// resets with it, which is the right failure mode for a rate limit. Nothing is persisted,
// so no IP-derived value ever touches storage.
export class Limiter extends DurableObject {
  private hits: number[] = [];

  take(max: number, windowMs: number): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < windowMs);
    if (this.hits.length >= max) return { ok: false, retryAfter: Math.max(1, Math.ceil((this.hits[0]! + windowMs - now) / 1000)) };
    this.hits.push(now);
    return { ok: true, retryAfter: 0 };
  }
}
