import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import multer from "multer";
import { IS_PROD, NODE_ENV, PORT, BIND_HOST, SERVERLESS, isLoopbackAddress } from "./config.js";
import { DesignInputError } from "./designValidation.js";
import { RouteParameterError } from "./routeParams.js";
import { db, now } from "./db.js";
import { hashPassword } from "./crypto.js";
import { passwordSchema } from "./validate.js";
import { apiLimiter, asyncHandler, csrfProtection } from "./security.js";
import { COUNTRIES } from "./payments/pricing.js";
import authRoutes from "./routes/auth.js";
import secretRoutes from "./routes/secrets.js";
import auditRoutes from "./routes/audit.js";
import projectRoutes from "./routes/projects.js";
import workspaceRoutes from "./routes/workspaces.js";
import nativeJobRoutes from "./routes/nativeJobs.js";
import nativeWorkerRoutes from "./routes/nativeWorker.js";
import { authenticateNativeWorker } from "./nativeWorkerAuthority.js";
import { isNativeWorkerMachinePath } from "./nativeWorkerPaths.js";
import { sharedRateLimiter } from "./sharedRateLimit.js";
import paymentRoutes from "./routes/payments.js";
import assistantRoutes from "./routes/assistant.js";
import shareRoutes from "./routes/share.js";
import cadExchangeRoutes from "./routes/cadExchange.js";
import collaborationRoutes from "./routes/collaboration.js";
import organizationRoutes from "./routes/organizations.js";
import ssoRoutes from "./routes/sso.js";
import renderJobRoutes from "./routes/renderJobs.js";
import adminBackupRoutes from "./routes/adminBackup.js";
import { reconcileInterruptedRenderJobs } from "./renderJobs.js";
import { startDatabaseScheduler, checkpointDatabase } from "./databaseBackup.js";
import { authorityGatewayMiddleware, normalizeIp, requireAuthorityConfiguration } from "./topology.js";
import { mountPublicSite } from "./publicSite.js";
import { vercelRequestContext } from "./serverlessRuntime.js";
import { telemetryMiddleware, drainTelemetry } from "./telemetry.js";
import operationsRoutes, { operationalTokenMatches } from "./routes/operations.js";
import { featureFlagGuard } from "./featureFlags.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

export const app = express();
const topology = requireAuthorityConfiguration();

// Required gateway mode has one authenticated forwarding hop. Direct mode only
// trusts explicit proxy addresses; unauthenticated clients cannot invent IPs.
app.set("trust proxy", topology.gatewayRequired ? 1 : (address: string) => topology.trustedProxyIps.includes(normalizeIp(address)));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: IS_PROD ? ["'self'"] : ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: IS_PROD ? ["'self'"] : ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: IS_PROD ? ["'none'"] : null,
        formAction: ["'self'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use((_req, res, next) => {
  // Camera and location are available only to this app; unrelated device APIs are disabled.
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self), usb=(), browsing-topics=()");
  next();
});

// Stable v1 prefix; retain the original path for existing installed clients.
app.use((req, res, next) => {
  if (/^\/api\/v1(?:\/|\?|$)/.test(req.url)) req.url = req.url.replace(/^\/api\/v1/, "/api");
  if (/^\/api(?:\/|\?|$)/.test(req.url)) res.setHeader("X-API-Version", "1");
  next();
});
app.use("/api", telemetryMiddleware);
if (SERVERLESS) app.use("/api", vercelRequestContext(process.env));
app.use("/api", authorityGatewayMiddleware(topology));
app.get("/api/live", (_req, res) => { res.json({ ok: true }); });
const nativeWorkerLimiter = sharedRateLimiter({
  namespace: "native-worker-v1", windowMs: 60_000, limit: 600,
  identity: req => `worker:${req.get("x-groundwork-worker-id") || "unverified"}`,
  message: "Worker request budget exceeded. Retry after the current window.",
});
app.use("/api", (req, res, next) => {
  if (isNativeWorkerMachinePath(req.method, req.path) && req.headers.origin === undefined && req.headers.cookie === undefined) {
    try {
      authenticateNativeWorker(req.get("authorization"), req.get("x-groundwork-worker-id"));
      return nativeWorkerLimiter(req, res, next);
    } catch { /* Unauthenticated attempts keep the public IP rate budget. */ }
  }
  const machinePath = /^\/ops\/(?:check|metrics|traces|backup-report|flags(?:\/[a-z]+)?)$/.test(req.path);
  const trusted = machinePath && (operationalTokenMatches(req.get("authorization"), process.env.OPERATIONS_TOKEN)
    || (req.path === "/ops/check" && req.method === "GET" && operationalTokenMatches(req.get("authorization"), process.env.CRON_SECRET)));
  if (trusted) next(); else apiLimiter(req, res, next);
});
// Own bounded parser and machine authentication, before browser cookies/CSRF.
// A path exception alone never grants worker or browser authority.
app.use("/api/native-worker/v1", nativeWorkerRoutes);
app.use(cookieParser());
app.use(express.json({
  limit: SERVERLESS ? "4mb" : "8mb",
  verify: (req, _res, buffer) => {
    if ((req.url ?? "").split("?")[0] === "/api/payments/webhook") {
      if (buffer.length > 256 * 1024) throw Object.assign(new Error("Webhook body too large"), { status: 413 });
      (req as express.Request & { paymentWebhookBody?: Buffer }).paymentWebhookBody = Buffer.from(buffer);
    }
  },
}));

// Operations use a dedicated bearer credential, never browser cookies.
app.use("/api/ops", operationsRoutes);
app.use("/api", csrfProtection);


app.get("/api/health", asyncHandler(async (_req, res) => {
  const ok = ((await db.prepare("SELECT 1 AS ok").get()) as { ok: number }).ok === 1;
  res.json({ ok, uptime: process.uptime() });
}));

app.get("/api/countries", (_req, res) => {
  res.json({
    countries: COUNTRIES.map((c) => ({ iso2: c.iso2, name: c.name, currency: c.currency, symbol: c.symbol })),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/secrets", secretRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/projects/:projectId/workspaces", workspaceRoutes);
app.use("/api/projects/:projectId/jobs", (req, res, next) => {
  if (IS_PROD && req.method === "POST" && req.path === "/") featureFlagGuard("native")(req, res, next); else next();
}, nativeJobRoutes);
app.use("/api/projects/:projectId/renders", (req, res, next) => {
  if (IS_PROD && !SERVERLESS && req.method === "POST" && (req.path === "/" || /^\/[a-f0-9]{32}\/retry$/.test(req.path))) featureFlagGuard("render")(req, res, next); else next();
}, renderJobRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/share", shareRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/assistant", featureFlagGuard("assistant"), assistantRoutes);
app.use("/api/cad-exchange", cadExchangeRoutes);
app.use("/api/collaboration", featureFlagGuard("collaboration"), collaborationRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/sso", ssoRoutes);
app.use("/api/admin/backups", adminBackupRoutes);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

/* Upload limit + JSON parse errors -> readable JSON */
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Photo too large. Max 25 MB." });
        return;
      }
      res.status(400).json({ error: `Upload error: ${err.code}` });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    if (err && typeof err === "object" && "status" in err && err.status === 413) {
      res.status(413).json({ error: "Request is too large for this endpoint" });
      return;
    }
    if (err && typeof err === "object" && "status" in err && err.status === 401) {
      res.status(401).json({ error: "Authentication changed. Sign in again." });
      return;
    }
    next(err);
  },
);

/* Serve the studio at home and retain the React workspace on application routes. */
mountPublicSite(app, CLIENT_DIST);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof DesignInputError || err instanceof RouteParameterError) {
      res.status(err.status).json({ error: err.message, code: err.code }); return;
    }
    console.error("[groundwork] Unhandled request error", { type: err instanceof Error ? err.name : "UnknownError", requestId: res.getHeader("x-request-id") });
    res.status(500).json({ error: "Internal server error" });
  },
);

export async function seedDevUserIfEmpty(): Promise<void> {
  if (process.env.GROUNDWORK_SEED_DEMO !== "1") return;
  if (NODE_ENV !== "development" || !isLoopbackAddress(BIND_HOST)) {
    throw new Error("Demo seeding requires development mode and loopback binding");
  }
  const password = process.env.GROUNDWORK_DEMO_PASSWORD;
  if (!password || password.length < 12 || !passwordSchema.safeParse(password).success) {
    throw new Error("GROUNDWORK_DEMO_PASSWORD must contain at least 12 characters, a letter and a number");
  }
  const count = ((await db.prepare("SELECT COUNT(*) AS count FROM users").get()) as { count: number }).count;
  if (count > 0) return;

  const t = now();
  const { salt, hash } = hashPassword(password);
  await db.prepare(`
    INSERT INTO users (
      id, email, username, email_verified, password_salt, password_hash,
      country, account_type, password_changed_at, created_at, updated_at
    ) VALUES (
      'usr_demo_architect', 'demo@groundwork.design', 'architect', 1, ?, ?,
      'IN', 'individual', ?, ?, ?
    )
  `).run(salt, hash, t, t, t);
  console.log("[groundwork] Seeded development demo account");
}

export async function startAuthorityServer() {
  if (SERVERLESS) throw new Error("Vercel must invoke the exported request handler; background authority startup is disabled");
  await reconcileInterruptedRenderJobs();
  await seedDevUserIfEmpty();
  const stopDatabaseScheduler = startDatabaseScheduler();
  let reconciling = false;
  const reconciliationTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconcileInterruptedRenderJobs().finally(() => { reconciling = false; });
  }, 60_000);
  reconciliationTimer.unref();
  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`[groundwork] API listening on http://localhost:${PORT}`);
    console.log(`[groundwork] Environment: ${IS_PROD ? "production" : "development"}`);
    if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
      console.log(`[groundwork] Serving static client from ${CLIENT_DIST}`);
    }
  });

  let resourceCleanup: Promise<void> | undefined;
  function stopResources(): Promise<void> {
    if (!resourceCleanup) {
      stopDatabaseScheduler();
      clearInterval(reconciliationTimer);
      resourceCleanup = (async () => {
        try {
          await checkpointDatabase("TRUNCATE");
        } catch (err) {
          console.error("[groundwork] Shutdown checkpoint failed", { type: err instanceof Error ? err.name : "UnknownError" });
        }
        await drainTelemetry();
        await db.close();
      })();
    }
    return resourceCleanup;
  }
  server.once("close", () => { void stopResources(); });
  let stopping = false;
  async function stopServer(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => { server.closeAllConnections(); }, 10_000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(force);
    await stopResources();
    process.exit(0);
  }
  process.once("SIGTERM", () => { void stopServer(); });
  process.once("SIGINT", () => { void stopServer(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await startAuthorityServer();
}

export default app;
