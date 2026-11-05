import { isIP } from "node:net";
import type { RequestHandler, Response } from "express";
import { isNativeWorkerMachinePath } from "./nativeWorkerPaths.js";

type Environment = Readonly<Record<string, string | undefined>>;

/** Vercel's opt-in cancellation reaches Node handlers as a request error. */
export function bindServerlessCancellation(request: Pick<import("node:http").IncomingMessage, "once" | "off" | "aborted">, response: Pick<Response, "once" | "off" | "end" | "destroyed" | "writableEnded">): () => void {
  const cancel = () => { if (!response.destroyed && !response.writableEnded) response.end(); };
  const detach = () => {
    request.off("error", cancel); request.off("aborted", cancel);
    response.off("close", detach); response.off("finish", detach);
  };
  request.once("error", cancel); request.once("aborted", cancel);
  response.once("close", detach); response.once("finish", detach);
  if (request.aborted) cancel();
  return detach;
}

/** An explicit deployment mode prevents accidental SQLite or worker use on ephemeral hosts. */
export function readServerlessMode(env: Environment): boolean {
  const mode = env.GROUNDWORK_SERVERLESS || "";
  if (!mode) {
    if (env.VERCEL === "1") throw new Error("Vercel requires GROUNDWORK_SERVERLESS=vercel");
    return false;
  }
  if (mode !== "vercel" || env.VERCEL !== "1" || env.NODE_ENV !== "production") {
    throw new Error("GROUNDWORK_SERVERLESS=vercel requires the Vercel production runtime");
  }
  const provider = env.DATABASE_PROVIDER || (env.DATABASE_URL || env.SUPABASE_DB_URL ? "supabase" : "sqlite");
  if (provider !== "supabase") throw new Error("Vercel requires the hosted Supabase database");
  if (env.DATABASE_ADMIN_URL) throw new Error("Database administrator credentials must not be deployed to Vercel");
  if (env.NATIVE_WORKER_ENABLED === "true") throw new Error("Native workers must remain disabled on Vercel");
  if (env.GROUNDWORK_SERVER_ROLE && env.GROUNDWORK_SERVER_ROLE !== "authority") throw new Error("Vercel requires the direct authority runtime");
  if (env.GROUNDWORK_AUTHORITY_GATEWAY_MODE && env.GROUNDWORK_AUTHORITY_GATEWAY_MODE !== "direct") throw new Error("Vercel requires direct authority mode");
  if (!env.GROUNDWORK_DATA_DIR || !/^\/tmp\/[^\0]+$/.test(env.GROUNDWORK_DATA_DIR)
    || env.GROUNDWORK_DATA_DIR.split("/").includes("..")) {
    throw new Error("Vercel scratch storage must be a directory below /tmp");
  }
  canonicalOrigin(env.PUBLIC_APP_ORIGIN);
  return true;
}

function canonicalOrigin(value: string | undefined): string {
  try {
    const url = new URL(value || "");
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch { /* Return configuration guidance without printing the value. */ }
  throw new Error("Vercel requires PUBLIC_APP_ORIGIN to be a fixed HTTPS origin");
}

/** Only mount after readServerlessMode succeeds; these headers are trusted only on Vercel. */
export function vercelRequestContext(env: Environment): RequestHandler {
  const origins = new Set([canonicalOrigin(env.PUBLIC_APP_ORIGIN)]);
  // Vercel supplies this server-side value for the immutable deployment URL.
  // It permits checking a staged deployment without trusting a request Host header.
  if (env.VERCEL_URL && /^[a-z0-9][a-z0-9.-]*\.vercel\.app$/i.test(env.VERCEL_URL)) {
    origins.add(`https://${env.VERCEL_URL.toLowerCase()}`);
  }
  return (req, res, next) => {
    const address = req.get("x-vercel-forwarded-for") || "";
    if (!isIP(address)) { res.status(400).json({ error: "Verified client identity is unavailable", code: "CLIENT_IDENTITY_UNAVAILABLE" }); return; }
    const ip = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    // req.ip normally reads the direct proxy socket. Avoid wildcard trust of
    // arbitrary forwarded chains; audit and limiter identity use the verified IP.
    Object.defineProperty(req, "ip", { value: ip, configurable: true });
    req.headers["x-forwarded-for"] = ip;
    req.headers["x-forwarded-proto"] = "https";
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("Origin");
      const webhook = req.method === "POST" && req.path === "/payments/webhook";
      if (webhook && !origin) { next(); return; }
      // Exact machine-only paths; their router requires a separate bearer token.
      if (!origin && req.method === "POST" && req.path === "/ops/backup-report") { next(); return; }
      if (!origin && req.method === "PATCH" && /^\/ops\/flags\/(assistant|uploads|collaboration|native|render)$/.test(req.path)) { next(); return; }
      if (!origin && isNativeWorkerMachinePath(req.method, req.path)) { next(); return; }
      let source = origin;
      if (!source) {
        try { source = new URL(req.get("Referer") || "").origin; } catch { source = undefined; }
      }
      if (!source || !origins.has(source)) { res.status(403).json({ error: "Request must originate from this application", code: "INVALID_ORIGIN" }); return; }
    }
    next();
  };
}

/** End before the Hobby function deadline so EventSource can reconnect cleanly. */
export function serverlessStreamDeadline(response: Pick<Response, "on" | "off" | "end" | "destroyed" | "writableEnded">, maximumMs = 240_000): () => void {
  const timer = setTimeout(() => { if (!response.destroyed && !response.writableEnded) response.end(); }, maximumMs);
  timer.unref?.();
  const stop = () => {
    clearTimeout(timer);
    response.off("close", stop);
    response.off("finish", stop);
  };
  response.on("close", stop);
  response.on("finish", stop);
  return stop;
}
