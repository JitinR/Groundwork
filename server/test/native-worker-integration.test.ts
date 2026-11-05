import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { after, beforeEach, test } from "node:test";
import express, { type Response } from "express";
import dotenv from "dotenv";
import { startDedicatedNativeWorker, type NativeWorkerExecutor } from "../src/nativeWorkerClient.js";

dotenv.config = () => ({ parsed: {} });
const directory = mkdtempSync(path.join(tmpdir(), "groundwork-worker-integration-"));
const postgres = process.env.GROUNDWORK_NATIVE_TEST_ENGINE === "postgres";
Object.assign(process.env, {
  NODE_ENV: "test", GROUNDWORK_DATA_DIR: directory, DB_PATH: "", MASTER_KEY: randomBytes(32).toString("base64"), PREVIOUS_MASTER_KEY: "",
  DATABASE_PROVIDER: postgres ? "supabase" : "sqlite", DATABASE_URL: postgres ? "postgresql://fixture:fixture@localhost/test" : "", SUPABASE_DB_URL: "", DATABASE_ADMIN_URL: "", DATABASE_SSL_CA_FILE: "",
  PAYMENTS_MODE: "demo", MAIL_PROVIDER: "console", BIND_HOST: "127.0.0.1", GROUNDWORK_SERVER_ROLE: "authority", GROUNDWORK_AUTHORITY_GATEWAY_MODE: "direct", GROUNDWORK_AUTHORITY_URL: "",
  GROUNDWORK_SERVERLESS: "", VERCEL: "", NATIVE_WORKER_ENABLED: "false", NATIVE_REMOTE_WORKER_ENABLED: "false", TRACE_SAMPLE_PERCENT: "0", ALERT_TO: "",
});
let engine: import("@electric-sql/pglite").PGlite | undefined;
if (postgres) {
  const { PGlite } = await import("@electric-sql/pglite");
  engine = new PGlite();
  let tail = Promise.resolve();
  async function acquire() { const prior = tail; let release!: () => void; tail = new Promise<void>(done => { release = done; }); await prior; return release; }
  async function query(sql: string, values: unknown[] = []) {
    const result = await engine!.query<Record<string, unknown>>(sql, values);
    return { rows: result.rows, fields: result.fields, command: result.command, rowCount: result.command === "SELECT" ? result.rows.length : result.affectedRows, oid: 0 };
  }
  const require = createRequire(import.meta.url);
  require("pg").Pool = class extends EventEmitter {
    async query(sql: string, values?: unknown[]) { const release = await acquire(); try { return await query(sql, values); } finally { release(); } }
    async connect() { const release = await acquire(); return { query, release }; }
    async end() {}
  };
  const { postgresMigrationSql } = await import("../src/postgresDatabase.js");
  await engine.exec(await postgresMigrationSql());
  await engine.exec("SET ROLE groundwork_runtime");
}
const { app } = await import("../src/index.js");
const { db, now } = await import("../src/db.js");
const { randomId } = await import("../src/crypto.js");
const { createSession } = await import("../src/security.js");
const { createWorkspaceArtifact } = await import("../src/workspaces.js");
const { submitNativeJob, cancelNativeJob, readNativeJob, readNativeJobArtifact } = await import("../src/nativeJobs.js");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const trustedOrigin = "https://worker-authority.example.test", workerId = "integration-worker", token = randomBytes(32).toString("base64url");
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic worker flow exceeded its deadline")), 12_000); })]); }
  finally { clearTimeout(timer); }
}
beforeEach(async () => {
  await db.prepare("UPDATE project_native_jobs SET state='cancelled',claim_token=NULL,claim_until=0 WHERE state IN ('queued','running')").run();
  await db.prepare("DELETE FROM runtime_rate_windows").run();
});
async function fixture() {
  const userId = randomId(), projectId = randomId();
  await db.prepare("INSERT INTO users(id,email,email_verified,password_salt,password_hash,password_changed_at,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)").run(userId, `${userId}@example.test`, "synthetic-salt", "synthetic-hash", now(), now(), now());
  const session = await createSession({ cookie() {} } as unknown as Response, userId);
  const actor = { userId, sessionId: session.sessionId };
  await db.prepare("INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(projectId, userId, "Synthetic worker flow", now(), now());
  Object.assign(process.env, { NATIVE_REMOTE_WORKER_ENABLED: "true", NATIVE_REMOTE_WORKERS_JSON: JSON.stringify([{ id: workerId, tokenSha256: sha(token), projectIds: [projectId], kinds: ["dxf-to-dwg"] }]) });
  const input = Buffer.from(`0\nSECTION\n2\nENTITIES\n999\n${"A".repeat(270_000)}\n0\nENDSEC\n0\nEOF\n`);
  const artifact = await createWorkspaceArtifact(projectId, "exchange", actor, "source.dxf", input);
  const job = await submitNativeJob(projectId, actor, { kind: "dxf-to-dwg", sourceArtifactId: artifact.id, sourceRevision: 0, idempotencyKey: randomId() });
  return { actor, projectId, input, artifact, job };
}
const bridge: typeof fetch = async (url, options) => {
  const target = new URL(String(url));
  assert.equal(target.origin, trustedOrigin); assert.ok(target.pathname.startsWith("/api/native-worker/v1/"));
  // Deliberate test-only bridge: production still requires fixed-origin HTTPS.
  const response = await fetch(origin + target.pathname, options);
  Object.defineProperty(response, "url", { value: target.href });
  return response;
};
function config() { return { authorityOrigin: trustedOrigin, workerId, token, kinds: ["dxf-to-dwg" as const], executorSocketPath: "/run/groundwork-native/executor.sock" }; }
const headers = { authorization: `Bearer ${token}`, "x-groundwork-worker-id": workerId, "content-type": "application/json" };
const bytes = Buffer.concat([Buffer.from("AC1015"), Buffer.alloc(270_000, 7)]);
function result(request: Parameters<NativeWorkerExecutor>[0]) {
  return { artifacts: [{ filename: "synthetic.dwg", mediaType: "image/vnd.dwg", bytes, sha256: sha(bytes) }], summary: { kind: request.kind, adapter: "LibreDWG" as const, declaredVersion: "0.13.4", sourceArtifactId: request.input.sourceArtifactId, sourceSha256: request.input.sha256, verification: "computed-unvalidated" as const, warnings: ["Synthetic transport fixture; not native converter acceptance."] } };
}

test("worker client completes real API multi-chunk submission/publication without exposing its credential to the executor", async t => {
  const f = await fixture(), completed = deferred<void>(); let calls = 0;
  const worker = startDedicatedNativeWorker(config(), {
    request: bridge, pollMs: 10, heartbeatMs: 50,
    execute: async (request, signal) => {
      calls++; assert.equal(signal.aborted, false);
      assert.deepEqual(Object.keys(request).sort(), ["input", "jobId", "kind", "version"]);
      assert.deepEqual(Object.keys(request.input).sort(), ["bytes", "sha256", "sourceArtifactId"]);
      assert.equal(Buffer.from(request.input.bytes).equals(f.input), true);
      assert.equal(JSON.stringify(request).includes(token), false);
      return result(request);
    }, report: code => { if (code === "job_succeeded") completed.resolve(); },
  });
  t.after(() => worker.stop());
  await within(completed.promise); await worker.stop();
  const saved = await readNativeJob(f.projectId, f.job.id, f.actor);
  assert.equal(saved.state, "succeeded"); assert.equal(saved.summary?.verification, "computed-unvalidated"); assert.equal(calls, 1);
  assert.equal(saved.artifacts.length, 1);
  assert.equal(Buffer.from((await readNativeJobArtifact(f.projectId, f.job.id, saved.artifacts[0].id, f.actor)).bytes).equals(bytes), true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM native_worker_outputs WHERE job_id=?").get(f.job.id) as { count: number }).count, 0);
  await assert.rejects(readNativeJobArtifact(f.projectId, f.job.id, saved.artifacts[0].id, { userId: randomId(), sessionId: randomId() }));
});

for (const change of ["cancel", "credential"] as const) {
  test(`real API ${change} aborts the worker and prevents result publication`, async t => {
    const f = await fixture(), executing = deferred<void>(), aborted = deferred<void>();
    const worker = startDedicatedNativeWorker(config(), {
      request: bridge, pollMs: 10, heartbeatMs: 50,
      execute: async (_request, signal) => { executing.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); aborted.resolve(); throw new Error("Synthetic cancelled execution"); },
    });
    t.after(() => worker.stop());
    await within(executing.promise);
    if (change === "cancel") await cancelNativeJob(f.projectId, f.job.id, f.actor);
    else await db.prepare("UPDATE users SET credential_version=credential_version+1 WHERE id=?").run(f.actor.userId);
    await within(aborted.promise); await worker.stop();
    const row = await db.prepare("SELECT state,error_code FROM project_native_jobs WHERE id=?").get(f.job.id) as { state: string; error_code: string };
    assert.equal(row.state, change === "cancel" ? "cancelled" : "failed");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM project_native_job_artifacts WHERE job_id=?").get(f.job.id) as { count: number }).count, 0);
  });
}

test("machine authentication uses its own rate bucket and does not grant browser or unrelated API access", async () => {
  await fixture();
  await fetch(`${origin}/api/countries`);
  await db.prepare("UPDATE runtime_rate_windows SET hits=100000").run();
  const call = (suffix: string, extra = {}) => fetch(`${origin}/api/native-worker/v1/${suffix}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ version: 1, kinds: ["dxf-to-dwg"] }) });
  assert.equal((await call("claim")).status, 200);
  assert.equal((await fetch(`${origin}/api/countries`)).status, 429);
  assert.equal((await call("claim", { authorization: "Bearer invalid" })).status, 429, "invalid worker credentials retain the public budget");
  await db.prepare("DELETE FROM runtime_rate_windows").run();
  assert.equal((await call("claim", { cookie: "session=browser" })).status, 400);
  assert.equal((await call("claim", { origin: trustedOrigin })).status, 400);
  assert.equal((await call("claim/extra")).status, 404);
  assert.equal((await fetch(`${origin}/api/projects`, { method: "POST", headers, body: "{}" })).status, 403);
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  const { drainTelemetry } = await import("../src/telemetry.js"); await drainTelemetry();
  await db.close(); await engine?.close(); rmSync(directory, { recursive: true, force: true });
});
