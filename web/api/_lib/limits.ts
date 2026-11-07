const MINUTE = 60_000;
const DAY = 86_400_000;

export type Limiter = ((ip: string, now: number) => { ok: true } | { ok: false; retryAfterSec: number }) & { reset(): void };

/** In-memory limits: perIpPerMin requests per minute per IP and perDay per day, per server instance. */
export function makeLimiter(perIpPerMin: number, perDay: number): Limiter {
  let perIp = new Map<string, number[]>();
  let day: number[] = [];

  /** Records a request when allowed; otherwise returns how many seconds to wait. */
  const check = (ip: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } => {
    day = day.filter((t) => now - t < DAY);
    const mine = (perIp.get(ip) ?? []).filter((t) => now - t < MINUTE);
    if (mine.length >= perIpPerMin) {
      perIp.set(ip, mine);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((mine[0]! + MINUTE - now) / 1000)) };
    }
    if (day.length >= perDay) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((day[0]! + DAY - now) / 1000)) };
    mine.push(now);
    perIp.set(ip, mine);
    day.push(now);
    // Keep the map from growing without bound.
    if (perIp.size > 5000) for (const [k, v] of perIp) if (v.every((t) => now - t >= MINUTE)) perIp.delete(k);
    return { ok: true };
  };
  return Object.assign(check, {
    reset(): void {
      perIp = new Map();
      day = [];
    },
  });
}
