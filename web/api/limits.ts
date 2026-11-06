/** In-memory limits: 5 requests per minute per IP, 200 per day per server instance. */
const MINUTE = 60_000;
const DAY = 86_400_000;
const PER_IP = 5;
const PER_DAY = 200;

let perIp = new Map<string, number[]>();
let day: number[] = [];

export function _resetLimits(): void {
  perIp = new Map();
  day = [];
}

/** Records a request when allowed; otherwise returns how many seconds to wait. */
export function checkLimit(ip: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
  day = day.filter((t) => now - t < DAY);
  const mine = (perIp.get(ip) ?? []).filter((t) => now - t < MINUTE);
  if (mine.length >= PER_IP) {
    perIp.set(ip, mine);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((mine[0]! + MINUTE - now) / 1000)) };
  }
  if (day.length >= PER_DAY) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((day[0]! + DAY - now) / 1000)) };
  mine.push(now);
  perIp.set(ip, mine);
  day.push(now);
  // Keep the map from growing without bound.
  if (perIp.size > 5000) for (const [k, v] of perIp) if (v.every((t) => now - t >= MINUTE)) perIp.delete(k);
  return { ok: true };
}
