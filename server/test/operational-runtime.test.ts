import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import express, { Router } from "express";
import type { RequestTelemetry } from "../src/telemetry.js";

const directory = mkdtempSync(join(tmpdir(), "groundwork-operations-"));
const opsToken = randomBytes(32).toString("hex"), cronToken = randomBytes(32).toString("hex");
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: "", SUPABASE_DB_URL: "", GROUNDWORK_DATA_DIR: directory,
  MASTER_KEY: randomBytes(32).toString("base64"), MAIL_PROVIDER: "console", PAYMENTS_MODE: "demo", BIND_HOST: "127.0.0.1",
  OPERATIONS_TOKEN: opsToken, CRON_SECRET: cronToken, ALERT_TO: "", TRACE_SAMPLE_PERCENT: "100", SLO_MIN_REQUESTS: "20",
  SLO_AVAILABILITY_PERCENT: "99.9", SLO_P95_MS: "750", DURABLE_WORKERS_ENABLED: "false", NATIVE_WORKER_ENABLED: "false",
});
delete process.env.DB_PATH;
delete process.env.PREVIOUS_MASTER_KEY;
const { db, now } = await import("../src/db.js");
const { telemetryMiddleware, withOperationalSpan, operationalTraceHeaders, parseTraceparent, scheduleTelemetryWork, drainTelemetry } = await import("../src/telemetry.js");
const { operationalMetrics, persistRequestTelemetry, operationalCheck, recordBackupReport, recentOperationalTraces } = await import("../src/operationalRuntime.js");
const { listFeatureFlags, featureFlagEnabled, updateFeatureFlag, inFeatureRollout } = await import("../src/featureFlags.js");
const { default: operationsRouter, operationalTokenMatches } = await import("../src/routes/operations.js");
const app = express();
app.use("/api", telemetryMiddleware);
app.use(express.json({ limit: "8kb" }));
app.use("/api/ops", operationsRouter);
const projectRouter = Router();
projectRouter.get("/:projectId/probe", async (_req, res) => {
  let childTraceparent = "";
  await withOperationalSpan("outbound.request", async () => {
    childTraceparent = operationalTraceHeaders().traceparent;
    await withOperationalSpan("db.select", async () => 1);
  });
  try { await withOperationalSpan("service.test", () => { throw new Error("private failure message"); }); } catch { /* Response is deliberately successful. */ }
  for (let index = 0; index < 70; index += 1) await withOperationalSpan("work.cpu", async () => index);
  res.json({ traceparent: childTraceparent });
});
projectRouter.get("/:projectId/failure", (_req, _res, next) => { next(new Error("private route failure")); });
projectRouter.get("/:projectId/stream", (_req, res) => {
  res.setHeader("content-type", "text/event-stream"); res.flushHeaders();
  res.write("event: ready\ndata: {}\n\n");
  setTimeout(() => res.end(), 80);
});
app.use("/api/projects", projectRouter);
app.use((error: { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: "Operational request failed", ...(error.code ? { code: error.code } : {}) });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const headers = { authorization: `Bearer ${opsToken}`, "content-type": "application/json" };
async function reset() {
  await drainTelemetry();
  await db.prepare("DELETE FROM runtime_request_metrics").run();
  await db.prepare("DELETE FROM runtime_traces").run();
  await db.prepare("DELETE FROM operational_state").run();
}
const record = (durationMs: number, status = 200): RequestTelemetry => ({ requestId: randomBytes(16).toString("hex"), traceId: randomBytes(16).toString("hex"), route: "/api/measure", method: "GET", status, durationMs, createdAt: now(), spans: [], droppedSpans: 0 });

test("request telemetry correlates W3C traces, bounds spans, and redacts every request secret", async () => {
  await reset();
  const incomingTrace = "0123456789abcdef0123456789abcdef";
  const captured: string[] = [];
  const info = console.info;
  console.info = (...values: unknown[]) => { captured.push(values.map(String).join(" ")); };
  let response: Response;
  try {
    response = await fetch(`${origin}/api/projects/private-project-id/probe?token=private-query`, {
      headers: { traceparent: `00-${incomingTrace}-0123456789abcdef-01`, cookie: "session=private-cookie", "x-private": "private-header" },
    });
    assert.equal(response.status, 200);
    await drainTelemetry();
  } finally { console.info = info; }
  const result = await response!.json() as { traceparent: string };
  assert.equal(parseTraceparent(result.traceparent)?.traceId, incomingTrace);
  assert.notEqual(result.traceparent, response!.headers.get("traceparent"), "Outbound requests use the child span identifier");
  assert.match(response!.headers.get("x-request-id") || "", /^[a-f0-9]{32}$/);
  const traces = await recentOperationalTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].traceId, incomingTrace);
  assert.equal(traces[0].route, "/api/projects/:projectId/probe");
  assert.equal(traces[0].spans.length, 64);
  assert.equal(traces[0].droppedSpans, 9);
  const span = traces[0].spans.find((item) => (item as { name: string }).name === "service.test") as { failed: boolean };
  assert.equal(span.failed, true);
  const serialized = JSON.stringify({ traces, captured });
  for (const secret of ["private-project-id", "private-query", "private-cookie", "private-header", "private failure message"]) assert(!serialized.includes(secret));
  assert(captured.some((line) => JSON.parse(line).type === "api.request"));
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-0123456789abcdef-01"), null);
  assert.equal(parseTraceparent(`00-${incomingTrace}-0000000000000000-01`), null);
  assert.equal(parseTraceparent("private\r\ninjected"), null);
  const failed = await fetch(`${origin}/api/projects/private-project-id/failure`);
  assert.equal(failed.status, 500);
  await drainTelemetry();
  const failureTrace = (await recentOperationalTraces()).find((item) => item.requestId === failed.headers.get("x-request-id"));
  assert.equal(failureTrace?.route, "/api/projects/:projectId/failure");
});

test("concurrent requests persist shared histogram counts and useful p95/p99/error-budget summaries", async () => {
  await reset();
  await Promise.all(Array.from({ length: 20 }, (_, index) => persistRequestTelemetry(record(index < 18 ? 10 : index === 18 ? 4000 : 9000, index < 18 ? 200 : 500))));
  const metrics = await operationalMetrics(60);
  assert.equal(metrics.totals.count, 20);
  assert.equal(metrics.totals.errors, 2);
  assert.equal(metrics.totals.p95Ms, 5000);
  assert.equal(metrics.totals.p99Ms, 9000);
  assert.equal(metrics.totals.histogram.reduce((total, count) => total + count, 0), 20);
  assert(metrics.slo.remainingErrors < 0);
  assert(metrics.slo.burnRate > 1);
  const durable = await db.prepare("SELECT SUM(request_count) AS total FROM runtime_request_metrics").get() as { total: number };
  assert.equal(durable.total, 20);
  await assert.rejects(persistRequestTelemetry({ ...record(1), route: "/api/private?email=person@example.test" }), /Invalid operational record/);
});

test("SSE latency measures readiness headers while retaining stream duration and request counts", async () => {
  await reset();
  const response = await fetch(`${origin}/api/projects/private-stream-id/stream`);
  await response.text();
  await drainTelemetry();
  const trace = (await recentOperationalTraces())[0] as Awaited<ReturnType<typeof recentOperationalTraces>>[number] & { latencyBasis: string; streamDurationMs: number };
  assert.equal(trace.latencyBasis, "headers");
  assert(trace.streamDurationMs >= 70);
  assert(trace.durationMs < trace.streamDurationMs - 40);
  const metrics = await operationalMetrics();
  assert.equal(metrics.totals.count, 1);
  assert.equal(metrics.totals.errors, 0);
  assert.equal(metrics.totals.maximumMs, trace.durationMs);
});

test("ops endpoints enforce independent bearer credentials and only accept encrypted successful backup reports", async () => {
  await reset();
  assert.equal(operationalTokenMatches(`Bearer ${opsToken}`, opsToken), true);
  assert.equal(operationalTokenMatches(`Bearer ${opsToken}x`, opsToken), false);
  assert.equal(operationalTokenMatches("Bearer short", "short"), false);
  assert.equal((await fetch(`${origin}/api/ops/metrics`)).status, 401);
  assert.equal((await fetch(`${origin}/api/ops/metrics`, { headers: { cookie: `operations=${opsToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/ops/metrics`, { headers: { authorization: `Bearer ${cronToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/ops/metrics`, { headers })).status, 200);
  const invalid = { backupId: "fixture", status: "succeeded", encrypted: false, completedAt: now() };
  assert.equal((await fetch(`${origin}/api/ops/backup-report`, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
  const valid = { ...invalid, encrypted: true, checksum: "a".repeat(64), bytes: 123 };
  assert.equal((await fetch(`${origin}/api/ops/backup-report`, { method: "POST", headers, body: JSON.stringify(valid) })).status, 202);
  await drainTelemetry();
  const check = await fetch(`${origin}/api/ops/check`, { headers: { authorization: `Bearer ${cronToken}` } });
  assert.equal(check.status, 200);
  assert.equal((await check.json() as { healthy: boolean }).healthy, true);
  const state = await db.prepare("SELECT value FROM operational_state WHERE key='backup.last_success'").get() as { value: string };
  assert.equal(JSON.parse(state.value).encrypted, true);
});

test("operational alerts notify transitions and throttle identical failures for six hours without real email", async () => {
  await reset();
  process.env.ALERT_TO = "synthetic-alert@example.test";
  const sent: { subject: string; text: string }[] = [];
  const send = async (_recipient: string, subject: string, text: string) => { sent.push({ subject, text }); return { delivered: true, via: "smtp" as const }; };
  try {
    const first = await operationalCheck({ send });
    assert.deepEqual(first.reasons, ["backup_stale_or_missing"]);
    assert.equal(first.notification, "sent");
    assert.equal((await operationalCheck({ send })).notification, "throttled");
    assert.equal(sent.length, 1);
    await recordBackupReport({ backupId: "test-backup", status: "succeeded", encrypted: true, checksum: "a".repeat(64), bytes: 1, completedAt: now() });
    const healthy = await operationalCheck({ send });
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.notification, "sent");
    assert.match(sent[1].subject, /recovery/);
    await recordBackupReport({ backupId: "failed-backup", status: "failed", encrypted: false, completedAt: now() });
    const failed = await operationalCheck({ send });
    assert(failed.reasons.includes("backup_failed"));
    assert.equal(failed.notification, "sent");
    const row = await db.prepare("SELECT value FROM operational_state WHERE key='alerts.runtime'").get() as { value: string };
    const state = JSON.parse(row.value);
    state.lastNotifiedAt = now() - 6 * 3600 - 1; state.lastAttemptAt = state.lastNotifiedAt;
    await db.prepare("UPDATE operational_state SET value=? WHERE key='alerts.runtime'").run(JSON.stringify(state));
    assert.equal((await operationalCheck({ send })).notification, "sent");
    assert.equal(sent.length, 4);
  } finally { process.env.ALERT_TO = ""; }
});

test("database outage alerts can send without database access and throttle parallel attempts", async (t) => {
  const originalRecipient = process.env.ALERT_TO;
  process.env.ALERT_TO = "synthetic-database-alert@example.test";
  let time = Date.now();
  t.mock.method(Date, "now", () => time);
  const prepare = t.mock.method(db, "prepare", () => { throw new Error("Synthetic database unavailable"); });
  let attempts = 0;
  const send = async (_recipient: string, subject: string, body: string) => {
    attempts += 1;
    assert.match(subject, /alert/);
    assert.match(body, /database_unavailable/);
    return { delivered: attempts > 1, via: "smtp" as const };
  };
  try {
    const first = await Promise.all([operationalCheck({ send }), operationalCheck({ send })]);
    assert.deepEqual(first.map(report => report.notification).sort(), ["failed", "throttled"]);
    assert.equal((await operationalCheck({ send })).notification, "throttled");
    time += 10 * 60_000;
    assert.equal((await operationalCheck({ send })).notification, "sent");
    time += 11 * 60_000;
    assert.equal((await operationalCheck({ send })).notification, "throttled");
    assert.equal(attempts, 2);
    assert.equal(prepare.mock.callCount(), 5);
  } finally {
    if (originalRecipient === undefined) delete process.env.ALERT_TO;
    else process.env.ALERT_TO = originalRecipient;
  }
});

test("feature flags have deterministic rollout, atomic compare-and-set audit, and hard worker capability limits", async () => {
  await db.prepare("DELETE FROM runtime_feature_flags").run();
  assert.equal(await featureFlagEnabled("assistant", "synthetic-user"), true);
  assert.equal(await featureFlagEnabled("native", "synthetic-user"), false);
  assert.equal(await featureFlagEnabled("render", "synthetic-user"), false);
  for (const name of ["native", "render"] as const) await assert.rejects(updateFeatureFlag(name, { enabled: true, rolloutPercent: 100, baseRevision: 0 }), { code: "FEATURE_UNSUPPORTED" });
  const racers = await Promise.allSettled([
    updateFeatureFlag("assistant", { enabled: false, rolloutPercent: 100, baseRevision: 0 }),
    updateFeatureFlag("assistant", { enabled: true, rolloutPercent: 25, baseRevision: 0 }),
  ]);
  assert.equal(racers.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = racers.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(conflict.reason.code, "FLAG_CONFLICT");
  const flag = (await listFeatureFlags()).find((item) => item.name === "assistant")!;
  assert.equal(flag.revision, 1);
  const audit = await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='feature_flag.updated'").get() as { count: number };
  assert.equal(audit.count, 1);
  const subjects = Array.from({ length: 1000 }, (_, index) => `synthetic-${index}`);
  const selected = subjects.filter((subject) => inFeatureRollout("uploads", subject, 25));
  assert(selected.length > 200 && selected.length < 300);
  assert.deepEqual(subjects.filter((subject) => inFeatureRollout("uploads", subject, 25)), selected);
  assert.equal((await fetch(`${origin}/api/ops/flags`)).status, 401);
  assert.equal((await fetch(`${origin}/api/ops/flags`, { headers })).status, 200);
});

test("post-response work is bounded and can be drained during graceful shutdown", async () => {
  await drainTelemetry();
  const errors = console.error; console.error = () => undefined;
  let release!: () => void, invoked = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    for (let index = 0; index < 129; index += 1) scheduleTelemetryWork(async () => { invoked += 1; await gate; });
    assert.equal(await drainTelemetry(10), false);
    assert.equal(invoked, 128);
    release();
    assert.equal(await drainTelemetry(), true);
  } finally { release(); console.error = errors; }
});

test("Vercel post-response work registers a Promise with the platform waitUntil lifetime", async () => {
  await drainTelemetry();
  const symbol = Symbol.for("@vercel/request-context");
  const global = globalThis as unknown as Record<symbol, unknown>;
  const original = global[symbol], oldMode = process.env.GROUNDWORK_SERVERLESS, oldVercel = process.env.VERCEL;
  const registered: Promise<unknown>[] = [];
  global[symbol] = { get: () => ({ waitUntil(promise: Promise<unknown>) { registered.push(promise); } }) };
  process.env.GROUNDWORK_SERVERLESS = "vercel"; process.env.VERCEL = "1";
  let completed = false;
  try {
    scheduleTelemetryWork(async () => { completed = true; });
    assert.equal(registered.length, 1);
    assert.equal(typeof registered[0].then, "function");
    await registered[0];
    assert.equal(completed, true);
  } finally {
    if (original === undefined) delete global[symbol]; else global[symbol] = original;
    if (oldMode === undefined) delete process.env.GROUNDWORK_SERVERLESS; else process.env.GROUNDWORK_SERVERLESS = oldMode;
    if (oldVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = oldVercel;
  }
});

test("operational counters, traces, flags and backup state execute against the migrated PostgreSQL engine", async () => {
  await drainTelemetry();
  const { PGlite } = await import("@electric-sql/pglite");
  const { createPostgresAdapter, postgresMigrationSql } = await import("../src/postgresDatabase.js");
  const engine = new PGlite();
  const original = db.prepare;
  let postgres: Awaited<ReturnType<typeof createPostgresAdapter>> | undefined;
  try {
    await engine.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
    await engine.exec(await postgresMigrationSql());
    const query = async (text: string, parameters: unknown[] = []) => {
      const result = await engine.query<Record<string, unknown>>(text, parameters);
      for (const field of result.fields) if ([20, 1700].includes(field.dataTypeID)) {
        for (const row of result.rows) if (row[field.name] !== null) row[field.name] = String(row[field.name]);
      }
      return { rows: result.rows, fields: result.fields, command: result.command, rowCount: result.command === "SELECT" ? result.rows.length : result.affectedRows, oid: 0 } as import("pg").QueryResult;
    };
    postgres = await createPostgresAdapter({ url: "postgresql://test:test@localhost/test", poolMax: 1 }, { pool: { query, connect: async () => ({ query, release() {} }), end: async () => undefined } });
    await postgres.withTransaction(async () => {
      db.prepare = (sql: string) => postgres!.db.prepare(sql);
      await persistRequestTelemetry(record(1250, 500));
      const metrics = await operationalMetrics();
      assert.equal(metrics.totals.count, 1);
      assert.equal(metrics.totals.errors, 1);
      assert.equal((await recentOperationalTraces()).length, 1);
      await updateFeatureFlag("uploads", { enabled: false, rolloutPercent: 100, baseRevision: 0 });
      assert.equal(await featureFlagEnabled("uploads", "test"), false);
      await recordBackupReport({ backupId: "pg-backup", status: "succeeded", encrypted: true, completedAt: now(), checksum: "b".repeat(64), bytes: 20 });
      assert.equal((await operationalCheck()).reasons.includes("backup_stale_or_missing"), false);
    });
  } finally {
    db.prepare = original;
    await postgres?.db.close();
    await engine.close();
  }
});

after(async () => {
  await drainTelemetry();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.close();
  rmSync(directory, { recursive: true, force: true });
});
