export interface HandleReq {
  method: string;
  body: string;
  ip: string;
  /** Set by the Node handler when the body exceeded the limit and was not buffered. */
  oversized?: boolean;
}
export interface HandleRes {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

type NodeReq = { method?: string; headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } } & AsyncIterable<Buffer | string>;
type NodeRes = { statusCode: number; setHeader(k: string, v: string): void; end(s: string): void };

export function scrub(res: HandleRes, secrets: string[]): HandleRes {
  const live = secrets.filter((s) => s.length > 0);
  if (!live.length) return res;
  let text = JSON.stringify(res.json);
  for (const s of live) text = text.split(s).join("[redacted]").split(JSON.stringify(s).slice(1, -1)).join("[redacted]");
  return { ...res, json: JSON.parse(text) };
}

/** Buffers up to the limit; beyond it, keeps draining (discarding) so the connection is not reset. */
async function readBody(req: AsyncIterable<Buffer | string>, maxBody: number): Promise<{ body: string; oversized: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > 1_000_000) break;
    if (size <= maxBody) chunks.push(b);
  }
  return size > maxBody ? { body: "", oversized: true } : { body: Buffer.concat(chunks).toString("utf8"), oversized: false };
}

/** Wraps a pure handler as a Vercel Node handler: body reading, client IP, secret scrubbing, response writing. */
export function nodeHandler(
  handle: (r: HandleReq) => Promise<HandleRes>,
  opts: { maxBody: number; secrets: () => string[] },
): (req: NodeReq, res: NodeRes) => Promise<void> {
  return async (req, res) => {
    const h = (k: string) => {
      const v = req.headers[k];
      return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined;
    };
    const ip = h("x-vercel-forwarded-for") || h("x-real-ip") || h("x-forwarded-for") || req.socket?.remoteAddress || "unknown";
    const { body, oversized } = req.method === "POST" ? await readBody(req, opts.maxBody) : { body: "", oversized: false };
    const r = scrub(await handle({ method: req.method ?? "GET", body, ip, oversized }), opts.secrets());
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    if (r.status === 413) res.setHeader("connection", "close");
    res.end(JSON.stringify(r.json));
  };
}
