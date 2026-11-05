import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import { MASTER_KEY } from "./config.js";
import { db, type Db } from "./db.js";

/** IPv6 privacy addresses in one /56 share a budget, like established IP limiters. */
export function rateLimitIdentity(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(address) !== 6) return address;
  let value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) value = value.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a, b, c, d) => `${(Number(a) * 256 + Number(b)).toString(16)}:${(Number(c) * 256 + Number(d)).toString(16)}`);
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  const numbers = words.map((word) => parseInt(word, 16));
  if (numbers.slice(0, 5).every((word) => word === 0) && numbers[5] === 0xffff) return `${numbers[6] >> 8}.${numbers[6] & 255}.${numbers[7] >> 8}.${numbers[7] & 255}`;
  return `${numbers[0].toString(16)}:${numbers[1].toString(16)}:${numbers[2].toString(16)}:${(numbers[3] & 0xff00).toString(16)}::/56`;
}

/** Atomic, shared fixed windows survive process restarts and serverless scaling. */
export function sharedRateLimiter(options: {
  namespace: string; limit: number; windowMs: number; message: string;
  database?: Db; clock?: () => number;
  identity?: (request: Request) => string;
}): RequestHandler {
  const database = options.database ?? db;
  const clock = options.clock ?? Date.now;
  let nextCleanup = 0;
  return async (req, res, next) => {
    try {
      const time = clock();
      const start = Math.floor(time / options.windowMs) * options.windowMs;
      const reset = Math.ceil((start + options.windowMs - time) / 1000);
      const subject = options.identity ? options.identity(req) : rateLimitIdentity(req.ip || req.socket.remoteAddress || "unknown");
      const identity = createHmac("sha256", MASTER_KEY).update(`rate:v1:${options.namespace}:${subject.slice(0, 256)}`).digest("hex");
      const result = await database.prepare(`INSERT INTO runtime_rate_windows (bucket_key,window_start,hits,expires_at)
        VALUES (?,?,1,?) ON CONFLICT(bucket_key,window_start) DO UPDATE SET hits=runtime_rate_windows.hits+1 RETURNING hits`)
        .get(identity, start, start + options.windowMs * 2) as { hits: number };
      res.setHeader("RateLimit-Policy", `${options.limit};w=${Math.ceil(options.windowMs / 1000)}`);
      res.setHeader("RateLimit", `limit=${options.limit}, remaining=${Math.max(0, options.limit - Number(result.hits))}, reset=${reset}`);
      if (time >= nextCleanup) {
        nextCleanup = time + 60_000;
        await database.prepare("DELETE FROM runtime_rate_windows WHERE expires_at<=?").run(time);
      }
      if (Number(result.hits) > options.limit) {
        res.setHeader("Retry-After", String(reset));
        res.status(429).json({ error: options.message }); return;
      }
      next();
    } catch {
      console.error(JSON.stringify({ type: "rate_limit.unavailable", namespace: options.namespace }));
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "Request protection is temporarily unavailable. Please retry." });
    }
  };
}
