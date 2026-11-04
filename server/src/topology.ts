import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";

// This configuration reader deliberately never imports config.ts, SQLite,
// vault keys, provider modules, job workers or filesystem-writing helpers.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });
export interface AuthorityConfiguration {
  role: "authority";
  gatewayRequired: boolean;
  authorityId: string;
  gatewaySecret: string;
  publicOrigin: string;
  trustedProxyIps: string[];
}
export interface SecondaryConfiguration {
  role: "secondary";
  authorityUrl: string;
  authorityId: string;
  gatewaySecret: string;
  publicOrigin: string;
  trustedProxyIps: string[];
  port: number;
  bindHost: string;
  maximumInflight: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  requestDeadlineMs: number;
  connectDeadlineMs: number;
  idleTimeoutMs: number;
  maximumSseLifetimeMs: number;
}
function role(): "authority" | "secondary" {
  const value = process.env.GROUNDWORK_SERVER_ROLE || "authority";
  if (value !== "authority" && value !== "secondary") throw new Error("GROUNDWORK_SERVER_ROLE must be authority or secondary");
  return value;
}
function httpsOrigin(value: string, name: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a fixed HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${name} must be a fixed HTTPS origin without credentials, path or query`);
  return parsed.origin;
}
function sharedSettings() {
  const authorityId = process.env.GROUNDWORK_AUTHORITY_ID || "";
  const gatewaySecret = process.env.GROUNDWORK_GATEWAY_SECRET || "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(authorityId)) throw new Error("GROUNDWORK_AUTHORITY_ID must be a stable 8–64 character application authority identifier");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(gatewaySecret)) throw new Error("GROUNDWORK_GATEWAY_SECRET must be a provisioned 43–128 character base64url secret");
  return { authorityId, gatewaySecret, publicOrigin: httpsOrigin(process.env.PUBLIC_APP_ORIGIN || "", "PUBLIC_APP_ORIGIN") };
}
export function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}
function trustedProxyIps(): string[] {
  const values = (process.env.GROUNDWORK_TRUSTED_PROXY_IPS || "").split(",").map((value) => normalizeIp(value.trim())).filter(Boolean);
  if (values.length > 32 || values.some((value) => isIP(value) === 0)) throw new Error("GROUNDWORK_TRUSTED_PROXY_IPS must contain at most 32 exact proxy IP addresses");
  return [...new Set(values)];
}
function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} exceeds the supported configuration range`);
  return value;
}
export function requireAuthorityConfiguration(): AuthorityConfiguration {
  if (role() !== "authority") throw new Error("Secondary hosts must use start:secondary; authority modules are disabled for this role");
  // The direct adapter needs privileged identity transition. An HTTP authority
  // must never acquire that privilege just to run a queue in its own process.
  if (process.env.NATIVE_WORKER_ENABLED && process.env.NATIVE_WORKER_ENABLED !== "false") {
    throw new Error("Native execution is disabled in HTTP authorities; keep NATIVE_WORKER_ENABLED=false and provision a separately isolated worker service");
  }
  const mode = process.env.GROUNDWORK_AUTHORITY_GATEWAY_MODE || "direct";
  if (mode !== "direct" && mode !== "required") throw new Error("GROUNDWORK_AUTHORITY_GATEWAY_MODE must be direct or required");
  if (mode === "required" && process.env.NODE_ENV !== "production") throw new Error("Authenticated gateway authority requires NODE_ENV=production so session cookies are Secure");
  if (process.env.GROUNDWORK_AUTHORITY_URL) throw new Error("An authority process must not configure another authority URL");
  const settings = mode === "required" ? sharedSettings() : { authorityId: "", gatewaySecret: "", publicOrigin: "" };
  return { role: "authority", gatewayRequired: mode === "required", ...settings, trustedProxyIps: trustedProxyIps() };
}
export function requireSecondaryConfiguration(): SecondaryConfiguration {
  if (role() !== "secondary") throw new Error("start:secondary requires GROUNDWORK_SERVER_ROLE=secondary");
  if (process.env.GROUNDWORK_AUTHORITY_GATEWAY_MODE !== "required") throw new Error("Secondary hosts require GROUNDWORK_AUTHORITY_GATEWAY_MODE=required");
  for (const name of ["MASTER_KEY", "PREVIOUS_MASTER_KEY", "DB_PATH", "GROUNDWORK_DATA_DIR", "DATABASE_URL", "SUPABASE_DB_URL", "DATABASE_ADMIN_URL", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "PAYPAL_CLIENT_SECRET", "AI_API_KEY", "COLLABORATION_REDIS_REST_TOKEN", "MAIL_PASS", "RESEND_API_KEY"]) {
    if (process.env[name]) throw new Error(`Secondary hosts must not contain authority-only configuration ${name}`);
  }
  if (process.env.NATIVE_WORKER_ENABLED && process.env.NATIVE_WORKER_ENABLED !== "false") throw new Error("Native workers are disabled on secondary hosts");
  const settings = sharedSettings();
  const authorityUrl = httpsOrigin(process.env.GROUNDWORK_AUTHORITY_URL || "", "GROUNDWORK_AUTHORITY_URL");
  if (authorityUrl === settings.publicOrigin) throw new Error("The authority URL must differ from the public gateway origin to prevent routing loops");
  const bindHost = process.env.GROUNDWORK_GATEWAY_BIND_HOST || "127.0.0.1";
  if (isIP(bindHost) === 0) throw new Error("GROUNDWORK_GATEWAY_BIND_HOST must be a literal interface IP");
  return {
    role: "secondary", ...settings, authorityUrl, bindHost, trustedProxyIps: trustedProxyIps(),
    port: boundedInteger("PORT", 4001, 1, 65535),
    maximumInflight: boundedInteger("GROUNDWORK_GATEWAY_MAX_INFLIGHT", 128, 1, 1024),
    maximumRequestBytes: boundedInteger("GROUNDWORK_GATEWAY_MAX_REQUEST_BYTES", 70 * 1024 * 1024, 8 * 1024 * 1024, 128 * 1024 * 1024),
    maximumResponseBytes: boundedInteger("GROUNDWORK_GATEWAY_MAX_RESPONSE_BYTES", 70 * 1024 * 1024, 8 * 1024 * 1024, 128 * 1024 * 1024),
    requestDeadlineMs: boundedInteger("GROUNDWORK_GATEWAY_REQUEST_DEADLINE_MS", 120000, 30000, 300000),
    connectDeadlineMs: boundedInteger("GROUNDWORK_GATEWAY_CONNECT_DEADLINE_MS", 10000, 1000, 30000),
    idleTimeoutMs: boundedInteger("GROUNDWORK_GATEWAY_IDLE_TIMEOUT_MS", 90000, 30000, 300000),
    maximumSseLifetimeMs: boundedInteger("GROUNDWORK_GATEWAY_SSE_LIFETIME_SECONDS", 3600, 60, 14400) * 1000,
  };
}
export function browserHostMatches(host: string | undefined, publicOrigin: string): boolean {
  if (!host || /[\s\/@?#,\\]/.test(host)) return false;
  try { return new URL(`https://${host}`).origin === publicOrigin; } catch { return false; }
}
export function browserMutationAllowed(req: Request, publicOrigin: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  // Provider callbacks have their own signature and carry no browser identity.
  if (req.method === "POST" && req.originalUrl.split("?")[0] === "/api/payments/webhook") return !req.get("Origin") || req.get("Origin") === publicOrigin;
  const origin = req.get("Origin");
  if (origin) return origin === publicOrigin;
  const referer = req.get("Referer");
  try { return Boolean(referer && new URL(referer).origin === publicOrigin); } catch { return false; }
}
/** Run before cookies/body parsing, rate limiting and every API route. */
export function authorityGatewayMiddleware(configuration: AuthorityConfiguration) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!configuration.gatewayRequired) {
      if (req.get("x-groundwork-gateway-secret") || req.get("x-groundwork-authority-id") || req.get("x-groundwork-public-origin")) { res.status(503).json({ error: "This authority has not enabled authenticated gateway access" }); return; }
      next(); return;
    }
    res.setHeader("x-groundwork-authority-id", configuration.authorityId);
    const presented = req.get("x-groundwork-gateway-secret") || "";
    const verified = /^[A-Za-z0-9_-]{43,128}$/.test(presented) && presented.length === configuration.gatewaySecret.length && timingSafeEqual(Buffer.from(presented), Buffer.from(configuration.gatewaySecret));
    if (!verified || req.get("x-groundwork-authority-id") !== configuration.authorityId || req.get("x-groundwork-public-origin") !== configuration.publicOrigin) { res.status(401).json({ error: "Gateway authority credentials are invalid" }); return; }
    const clientIp = req.get("x-forwarded-for") || "";
    if (isIP(clientIp) === 0 || req.get("x-forwarded-host") !== new URL(configuration.publicOrigin).host || req.get("x-forwarded-proto") !== "https") { res.status(400).json({ error: "Gateway forwarding identity is invalid" }); return; }
    if (!browserMutationAllowed(req, configuration.publicOrigin)) { res.status(403).json({ error: "Request must originate from the canonical application origin" }); return; }
    // Remove the normalized gateway credential before route handling.
    delete req.headers["x-groundwork-gateway-secret"];
    next();
  };
}

