import type { NextFunction, Request, Response } from "express";
import { sharedRateLimiter } from "./sharedRateLimit.js";
import {
  COOKIE_CSRF,
  COOKIE_SESSION,
  IS_PROD,
  MAIL,
  isLoopbackAddress,
  PENDING_2FA_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from "./config.js";
import { db, now, withTransaction } from "./db.js";
import { randomToken, sha256Hex } from "./crypto.js";

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
  session?: {
    id: string;
    user_id: string;
    csrf_token: string;
    status: string;
  };
  csrfToken?: string;
}

/* ----------------------------- Rate limiting ----------------------------- */

export const strictLimiter = sharedRateLimiter({
  namespace: "authentication",
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many attempts. Please wait 15 minutes.",
});

export const apiLimiter = sharedRateLimiter({
  namespace: "api",
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: "Too many requests. Please slow down.",
});

/* ------------------------------- Cookies --------------------------------- */

function baseCookie(name: string, value: string, maxAgeSeconds: number, httpOnly: boolean) {
  return {
    name,
    value,
    options: {
      httpOnly,
      secure: IS_PROD,
      sameSite: name === COOKIE_SESSION ? ("lax" as const) : ("strict" as const),
      path: "/",
      maxAge: maxAgeSeconds * 1000,
    },
  };
}

export function setSessionCookie(res: Response, rawToken: string, ttlSeconds: number) {
  const { name, value, options } = baseCookie(COOKIE_SESSION, rawToken, ttlSeconds, true);
  res.cookie(name, value, options);
}

export function setCsrfCookie(res: Response, token: string) {
  const { name, value, options } = baseCookie(COOKIE_CSRF, token, 60 * 60, false);
  res.cookie(name, value, options);
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_SESSION, { path: "/" });
  res.clearCookie(COOKIE_CSRF, { path: "/" });
}

/* -------------------------------- Session -------------------------------- */

export async function createSession(
  res: Response,
  userId: string,
  opts: { pending2fa?: boolean; isPending?: boolean; credentialVersion?: number; deferCookies?: boolean } = {},
) {
  const raw = randomToken(32);
  const dbCsrf = randomToken(24);
  const ttl = opts.isPending ? PENDING_2FA_TTL_SECONDS : SESSION_TTL_SECONDS;
  const sessionId = randomToken(16);
  (await withTransaction(async () => {
    const account = (await db.prepare("SELECT credential_version FROM users WHERE id=?").get(userId)) as { credential_version: number } | undefined;
    if (!account || (opts.credentialVersion !== undefined && opts.credentialVersion !== account.credential_version)) {
      throw Object.assign(new Error("Authentication changed. Sign in again."), { status: 401 });
    }
    (await db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, status, user_agent, ip, created_at, last_seen_at, expires_at, credential_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      userId,
      sha256Hex(raw),
      dbCsrf,
      opts.isPending ? "pending_2fa" : "active",
      null,
      null,
      now(),
      now(),
      now() + ttl,
      account.credential_version,
    ));
  }));
  const setCookies = () => {
    setSessionCookie(res, raw, ttl);
    setCsrfCookie(res, dbCsrf);
  };
  // A surrounding credential transaction must commit before cookies are sent.
  if (!opts.deferCookies) setCookies();
  return { sessionId, csrfToken: dbCsrf, ttl, setCookies };
}

/* ------------------------------- Middleware ------------------------------ */

export function bootstrap(req: Request, res: Response) {
  const csrf = randomToken(24);
  setCsrfCookie(res, csrf);
  return { csrfToken: csrf };
}

type SessionRow = {
  id: string;
  user_id: string;
  csrf_token: string;
  status: string;
  expires_at: number;
  credential_version: number;
  totp_attempts: number;
};

export async function resolveSession(req: Request): Promise<SessionRow | null> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[COOKIE_SESSION];
  if (!raw) return null;
  const row = (await db
    .prepare(`SELECT s.id,s.user_id,s.csrf_token,s.status,s.expires_at,s.credential_version,s.totp_attempts
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.credential_version=u.credential_version`)
    .get(sha256Hex(raw))) as SessionRow | undefined;
  if (!row) return null;
  if (row.status === "revoked") return null;
  if (row.expires_at <= now()) return null;
  return row;
}

/** Development-only code display requires an explicit opt-in and a local browser request. */
export function allowDevelopmentOtp(req: Request): boolean {
  if (IS_PROD || !MAIL.devOtp || !isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackAddress(req.ip)) return false;
  try {
    const hostname = new URL(`http://${req.get("host") || ""}`).hostname;
    if (!isLoopbackAddress(hostname)) return false;
    const origin = req.get("origin");
    return !origin || isLoopbackAddress(new URL(origin).hostname);
  } catch { return false; }
}

export const requireSession = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const session = (await resolveSession(req));
  if (!session || session.status !== "active") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const user = (await db
    .prepare("SELECT id, email FROM users WHERE id = ?")
    .get(session.user_id)) as { id: string; email: string } | undefined;
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const authed = req as AuthedRequest;
  authed.user = user;
  authed.session = session;
  authed.csrfToken = session.csrf_token;
  (await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), session.id));
  next();
});

export const csrfProtection = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  // Anonymous auth endpoints create or upgrade a session from nothing. No
  // session CSRF token can be trusted yet; same-origin/SameSite cookies and
  // the API rate limiter protect these short-lived authentication requests.
  if (
    req.path === "/auth/signup" ||
    req.path === "/auth/login" ||
    req.path === "/auth/verify-email" ||
    req.path === "/auth/resend-otp" ||
    req.path === "/auth/otp/request" ||
    req.path === "/auth/otp/verify"
  ) {
    next();
    return;
  }
  // Payment provider webhooks carry their own cryptographically-verified
  // signature (HMAC) and never have a browser session or CSRF cookie.
  if (req.path === "/payments/webhook") {
    next();
    return;
  }
  const headerToken = req.get("x-csrf-token");
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[COOKIE_CSRF];
  const session = (await resolveSession(req));
  const sessionToken = session?.csrf_token ?? null;

  let matches = false;
  if (headerToken && cookieToken) {
    if (sessionToken !== null) {
      // Authenticated users MUST match their secure session token
      matches = (headerToken === sessionToken);
    } else {
      // Unauthenticated users (who still need CSRF) fallback to double-submit cookie
      matches = (headerToken === cookieToken);
    }
  }

  if (!matches) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }
  next();
});

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve().then(() => fn(req, res, next)).catch(next);
  };
}
