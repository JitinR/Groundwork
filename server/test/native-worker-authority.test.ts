import assert from "node:assert/strict";
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import express from "express";
import dotenv from "dotenv";
import type { NativeJobKind } from "../src/nativeAdapters.js";

dotenv.config = () => ({ parsed: {} });
const directory = mkdtempSync(path.join(tmpdir(), "groundwork-native-authority-"));
const masterKey = randomBytes(32);
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: "", SUPABASE_DB_URL: "", DB_PATH: "",
  GROUNDWORK_DATA_DIR: directory, MASTER_KEY: masterKey.toString("base64"), PREVIOUS_MASTER_KEY: "",
  MAIL_PROVIDER: "console", PAYMENTS_MODE: "demo", BIND_HOST: "127.0.0.1", NATIVE_WORKER_ENABLED: "false",
  GROUNDWORK_SERVERLESS: "", VERCEL: "", NATIVE_REMOTE_WORKER_ENABLED: "false",
});
const { db, now } = await import("../src/db.js");
const { randomId } = await import("../src/crypto.js");
const { createWorkspaceArtifact, readWorkspaceArtifact } = await import("../src/workspaces.js");
const { readNativeJob } = await import("../src/nativeJobs.js");
const { authenticateNativeWorker, createWorkerClaim, renewWorkerClaim, readWorkerInput, stageWorkerOutput, completeWorkerJob, NATIVE_WORKER_CHUNK_BYTES: CHUNK, NATIVE_WORKER_MAX_BYTES: MAX } = await import("../src/nativeWorkerAuthority.js");
const { readNativeWorkerRegistrations, remoteNativeWorkerConfiguredFor } = await import("../src/nativeWorkerRemoteConfig.js");
const { default: router } = await import("../src/routes/nativeWorker.js");
const app = express(); app.use("/api/native-worker/v1", router);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}/api/native-worker/v1`;
const token = randomBytes(32).toString("base64url"), otherToken = randomBytes(32).toString("base64url");
const workerId = "worker-fixture-one", otherWorkerId = "worker-fixture-two";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-groundwork-worker-id": workerId };
beforeEach(async () => {
  process.env.NATIVE_REMOTE_WORKER_ENABLED = "false";
  delete process.env.NATIVE_REMOTE_WORKERS_JSON;
  await db.prepare("UPDATE project_native_jobs SET state='cancelled',claim_token=NULL,claim_until=0 WHERE state='running'").run();
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  rmSync(directory, { recursive: true, force: true });
});

function register(projectIds: string[], kinds: NativeJobKind[] = ["dxf-to-dwg"], second?: { projectIds: string[]; kinds: NativeJobKind[] }) {
  process.env.NATIVE_REMOTE_WORKER_ENABLED = "true";
  process.env.NATIVE_REMOTE_WORKERS_JSON = JSON.stringify([
    { id: workerId, tokenSha256: sha(token), projectIds, kinds },
    ...(second ? [{ id: otherWorkerId, tokenSha256: sha(otherToken), ...second }] : []),
  ]);
  return authenticateNativeWorker(headers.authorization, workerId);
}
async function fixture(input = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"), kind: NativeJobKind = "dxf-to-dwg", projectId?: string) {
  const userId = randomId(), sessionId = randomId(), id = projectId ?? randomId(), jobId = randomId();
  await db.prepare("INSERT INTO users(id,email,email_verified,password_salt,password_hash,password_changed_at,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)")
    .run(userId, `${userId}@example.test`, "synthetic-salt", "synthetic-hash", now(), now(), now());
  await db.prepare("INSERT INTO sessions(id,user_id,token_hash,csrf_token,status,created_at,last_seen_at,expires_at,credential_version) VALUES(?,?,?,?,'active',?,?,?,0)")
    .run(sessionId, userId, randomId(), randomId(), now(), now(), now() + 3600);
  if (!projectId) await db.prepare("INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, userId, "Synthetic worker project", now(), now());
  else await db.prepare("INSERT INTO project_members(project_id,user_id,role,invited_by,created_at) VALUES(?,?,'editor',?,?)").run(id, userId, userId, now());
  const actor = { userId, sessionId }, workspaceKind = kind === "opensees-static" ? "engineering" : "exchange";
  const artifact = await createWorkspaceArtifact(id, workspaceKind, actor, "input.dxf", input);
  await db.prepare("INSERT INTO project_native_jobs(id,project_id,kind,workspace_kind,state,input_artifact_id,input_sha256,source_revision,idempotency_key,request_hash,created_by,session_id,created_at,updated_at,expires_at) VALUES(?,?,?,?,'queued',?,?,0,?,?,?,?,?,?,?)")
    .run(jobId, id, kind, workspaceKind, artifact.id, artifact.sha256, randomId(), sha(randomId()), userId, sessionId, now(), now(), now() + 600);
  return { projectId: id, jobId, actor, artifact, input, kind };
}
async function post(suffix: string, body: unknown, changes: Record<string, string> = {}, method = "POST") {
  const response = await fetch(origin + suffix, { method, headers: { ...headers, ...changes }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Record<string, any>, response };
}
function summary(f: Awaited<ReturnType<typeof fixture>>) {
  return { kind: f.kind, adapter: f.kind === "opensees-static" ? "OpenSees" : "LibreDWG", declaredVersion: f.kind === "opensees-static" ? "3.8.0" : "0.13.4", sourceArtifactId: f.artifact.id, sourceSha256: f.artifact.sha256, verification: "computed-unvalidated", warnings: ["Synthetic transport fixture; not native runtime acceptance."], ...(f.kind === "opensees-static" ? { dimension: "planar-2d", combinationId: "dead" } : {}) };
}
async function claimed(f: Awaited<ReturnType<typeof fixture>>) {
  const worker = register([f.projectId], [f.kind]);
  const result = await createWorkerClaim(worker, [f.kind]); assert(result.claim);
  return { worker, claim: result.claim };
}
function output(bytes: Buffer, index = 0, offset = 0, filename = "converted.dwg") {
  return { index, filename, mediaType: "image/vnd.dwg", totalBytes: bytes.length, sha256: sha(bytes), offset, bytes: bytes.subarray(offset, offset + CHUNK).toString("base64") };
}
function signedPayload(grant: string, changes: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString()), ...changes })).toString("base64url");
  const key = Buffer.from(hkdfSync("sha256", masterKey, "groundwork-native-worker", "grant-v1", 32));
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

test("remote registration is strict, explicit and scoped; disabled/invalid configuration never advertises availability", () => {
  assert.deepEqual(readNativeWorkerRegistrations({}), []);
  assert.equal(remoteNativeWorkerConfiguredFor("project-a", "dxf-to-dwg", {}), false);
  const registration = { id: workerId, tokenSha256: sha(token), projectIds: ["project-a"], kinds: ["dxf-to-dwg"] };
  const env = { NATIVE_REMOTE_WORKER_ENABLED: "true", NATIVE_REMOTE_WORKERS_JSON: JSON.stringify([registration]) };
  assert.equal(remoteNativeWorkerConfiguredFor("project-a", "dxf-to-dwg", env), true);
  assert.equal(remoteNativeWorkerConfiguredFor("project-b", "dxf-to-dwg", env), false);
  assert.equal(remoteNativeWorkerConfiguredFor("project-a", "opensees-static", env), false);
  for (const entries of [[registration, registration], [{ ...registration, projectIds: [] }], [{ ...registration, projectIds: ["project-a", "project-a"] }], [{ ...registration, kinds: ["unknown"] }], [{ ...registration, rawToken: token }]]) {
    assert.throws(() => readNativeWorkerRegistrations({ ...env, NATIVE_REMOTE_WORKERS_JSON: JSON.stringify(entries) }));
    assert.equal(remoteNativeWorkerConfiguredFor("project-a", "dxf-to-dwg", { ...env, NATIVE_REMOTE_WORKERS_JSON: JSON.stringify(entries) }), false);
  }
});

test("router authenticates before parsing and never accepts browser credentials or exposes supplied secrets", async () => {
  const f = await fixture();
  assert.equal((await post("/claim", { version: 1, kinds: [f.kind] })).status, 503);
  register([f.projectId]);
  for (const changes of [{ authorization: "Bearer invalid-secret-value" }, { "x-groundwork-worker-id": "unknown-fixture-worker" }, { cookie: "private-cookie" }, { origin: "https://attacker.example" }]) {
    const response = await post("/claim", { version: 1, kinds: [f.kind] }, changes);
    assert.ok([400, 401].includes(response.status));
    assert.equal(JSON.stringify(response.body).includes("secret-value"), false);
    assert.equal(response.response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await post("/claim", {}, {}, "GET")).status, 400);
  assert.equal((await post("/claim?copy=private", { version: 1, kinds: [f.kind] })).status, 400);
  const invalidJson = await fetch(origin + "/claim", { method: "POST", headers, body: "{private-provider-body" });
  assert.equal(invalidJson.status, 400); assert.equal((await invalidJson.text()).includes("private-provider-body"), false);
  const unauthenticatedLarge = await fetch(origin + "/claim", { method: "POST", headers: { ...headers, authorization: "Bearer invalid" }, body: "x".repeat(600_000) });
  assert.equal(unauthenticatedLarge.status, 401);
});

test("claims cannot cross project/kind scope or reveal submitting identities, including beyond the first queued batch", async () => {
  const foreign = await fixture();
  // More than the old bounded scan size of unrelated earlier queued records.
  for (let index = 0; index < 65; index++) {
    await db.prepare("INSERT INTO project_native_jobs(id,project_id,kind,workspace_kind,state,input_artifact_id,input_sha256,source_revision,idempotency_key,request_hash,created_by,session_id,created_at,updated_at,expires_at) VALUES(?,?,?,'exchange','queued',?,?,0,?,?,?,?,?,?,?)")
      .run(randomId(), foreign.projectId, foreign.kind, foreign.artifact.id, foreign.artifact.sha256, randomId(), sha(randomId()), foreign.actor.userId, foreign.actor.sessionId, now() - 10, now(), now() + 600);
  }
  const own = await fixture(); register([own.projectId]);
  const disallowedKind = await post("/claim", { version: 1, kinds: ["opensees-static"] }); assert.equal(disallowedKind.status, 403);
  const response = await post("/claim", { version: 1, kinds: [own.kind] }); assert.equal(response.status, 200);
  assert.equal(response.body.claim.jobId, own.jobId);
  const payload = JSON.parse(Buffer.from(response.body.claim.grant.split(".")[0], "base64url").toString());
  assert.equal(payload.workerId, workerId); assert.equal(payload.projectId, own.projectId);
  for (const text of [JSON.stringify(response.body), JSON.stringify(payload)]) {
    assert.equal(text.includes(own.actor.sessionId), false); assert.equal(text.includes(own.actor.userId), false);
  }
  assert.equal((await db.prepare("SELECT state FROM project_native_jobs WHERE id=?").get(foreign.jobId) as { state: string }).state, "queued");
});

test("forged, expired, wrong-worker, wrong-job and out-of-scope grants cannot access inputs", async () => {
  const f = await fixture(), { worker, claim } = await claimed(f);
  for (const grant of [claim.grant + "x", signedPayload(claim.grant, { expiresAt: now() - 1 }), signedPayload(claim.grant, { expiresAt: now() + 601 }), signedPayload(claim.grant, { workerId: otherWorkerId })]) {
    await assert.rejects(readWorkerInput(worker, f.jobId, grant, 0), { code: "WORKER_GRANT_INVALID" });
  }
  await assert.rejects(readWorkerInput(worker, randomId(), claim.grant, 0), { code: "WORKER_GRANT_INVALID" });
  register([f.projectId], [f.kind], { projectIds: [f.projectId], kinds: [f.kind] });
  const second = authenticateNativeWorker(`Bearer ${otherToken}`, otherWorkerId);
  await assert.rejects(readWorkerInput(second, f.jobId, claim.grant, 0), { code: "WORKER_GRANT_INVALID" });
  register(["another-project"]);
  await assert.rejects(readWorkerInput(worker, f.jobId, claim.grant, 0), { code: "WORKER_SCOPE" });
});

test("credential rotation and configuration disablement revoke even a previously authenticated worker identity", async () => {
  const f = await fixture(), { worker, claim } = await claimed(f);
  process.env.NATIVE_REMOTE_WORKERS_JSON = JSON.stringify([{ id: workerId, tokenSha256: sha(otherToken), projectIds: [f.projectId], kinds: [f.kind] }]);
  await assert.rejects(renewWorkerClaim(worker, f.jobId, claim.grant), { code: "WORKER_AUTH" });
  process.env.NATIVE_REMOTE_WORKER_ENABLED = "false";
  await assert.rejects(renewWorkerClaim(worker, f.jobId, claim.grant), { code: "WORKER_DISABLED" });
});

test("source chunks retain canonical boundaries and fingerprints; output staging is encrypted and publication is atomic", async () => {
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n" + "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n".repeat(9000) + "0\nENDSEC\n0\nEOF\n");
  const f = await fixture(source); register([f.projectId]);
  const response = await post("/claim", { version: 1, kinds: [f.kind] }); assert.equal(response.status, 200);
  const claim = response.body.claim;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < source.length; offset += CHUNK) {
    const part = await post(`/jobs/${claim.jobId}/input`, { version: 1, grant: claim.grant, offset });
    assert.equal(part.status, 200); assert.equal(part.body.totalBytes, source.length);
    const bytes = Buffer.from(part.body.bytes, "base64"); assert.equal(sha(bytes), part.body.sha256); parts.push(bytes);
  }
  assert(Buffer.concat(parts).equals(source));
  const bytes = Buffer.concat([Buffer.from("AC1015"), Buffer.alloc(CHUNK * 2 + 11, 92)]);
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = output(bytes, 0, offset);
    const staged = await post(`/jobs/${claim.jobId}/output`, { version: 1, grant: claim.grant, ...chunk });
    assert.equal(staged.status, 200); assert.equal(staged.body.nextOffset, Math.min(offset + CHUNK, bytes.length));
    const replay = await post(`/jobs/${claim.jobId}/output`, { version: 1, grant: claim.grant, ...chunk }); assert.equal(replay.status, 200);
  }
  const stored = await db.prepare("SELECT ciphertext,iv,tag FROM native_worker_output_chunks WHERE job_id=? ORDER BY chunk_offset").all(f.jobId) as { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }[];
  assert.equal(stored.length, 3); assert.equal(Buffer.from(stored[0].ciphertext).equals(bytes.subarray(0, CHUNK)), false);
  assert.equal((await readNativeJob(f.projectId, f.jobId, f.actor)).artifacts.length, 0);
  const completed = await post(`/jobs/${claim.jobId}/complete`, { version: 1, grant: claim.grant, summary: summary(f) }); assert.equal(completed.status, 200); assert.equal(completed.body.accepted, true);
  const job = await readNativeJob(f.projectId, f.jobId, f.actor); assert.equal(job.state, "succeeded"); assert.equal(job.summary?.verification, "computed-unvalidated"); assert.equal(job.artifacts.length, 1);
  assert((await readWorkspaceArtifact(f.projectId, job.artifacts[0].id, f.actor)).bytes.equals(bytes));
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM native_worker_output_chunks WHERE job_id=?").get(f.jobId) as { count: number }).count, 0);
  assert.equal((await post(`/jobs/${claim.jobId}/complete`, { version: 1, grant: claim.grant, summary: summary(f) })).status, 409);
});

test("chunk validation rejects traversal, gaps, noncanonical bytes, conflicting replay, duplicate names and declared aggregate overflow", async () => {
  const f = await fixture(), { worker, claim } = await claimed(f), bytes = Buffer.alloc(CHUNK + 10, 34);
  for (const changed of [{ filename: "../escape.dwg" }, { offset: 1 }, { bytes: "YQ" }, { bytes: "!!!!" }, { totalBytes: MAX + 1 }, { index: 8 }]) {
    await assert.rejects(stageWorkerOutput(worker, f.jobId, claim.grant, { ...output(bytes), ...changed }), { code: "WORKER_REQUEST_INVALID" });
  }
  await assert.rejects(stageWorkerOutput(worker, f.jobId, claim.grant, output(bytes, 0, CHUNK)), { code: "WORKER_OUTPUT_CONFLICT" });
  await stageWorkerOutput(worker, f.jobId, claim.grant, output(bytes));
  const conflicting = Buffer.from(bytes); conflicting[0]++;
  await assert.rejects(stageWorkerOutput(worker, f.jobId, claim.grant, { ...output(bytes), bytes: conflicting.subarray(0, CHUNK).toString("base64") }), { code: "WORKER_OUTPUT_CONFLICT" });
  await assert.rejects(stageWorkerOutput(worker, f.jobId, claim.grant, output(Buffer.from("second"), 1)), { code: "WORKER_OUTPUT_CONFLICT" });
  await assert.rejects(stageWorkerOutput(worker, f.jobId, claim.grant, { ...output(bytes, 1, 0, "second.dwg"), totalBytes: MAX }), { code: "WORKER_OUTPUT_LIMIT" });
  await assert.rejects(completeWorkerJob(worker, f.jobId, claim.grant, summary(f)), { code: "WORKER_OUTPUT_CONFLICT" });
  assert.equal((await readNativeJob(f.projectId, f.jobId, f.actor)).state, "running");
});

test("tampered staging ciphertext and claimed verification/source mismatches never publish artifacts", async () => {
  const f = await fixture(), { worker, claim } = await claimed(f), bytes = Buffer.from("AC1015synthetic");
  await stageWorkerOutput(worker, f.jobId, claim.grant, output(bytes));
  for (const changed of [{ verification: "verified" }, { sourceArtifactId: randomId() }, { sourceSha256: "a".repeat(64) }, { declaredVersion: "3.8.0" }, { adapter: "OpenSees" }, { unexpected: "field" }]) {
    await assert.rejects(completeWorkerJob(worker, f.jobId, claim.grant, { ...summary(f), ...changed }), { code: "WORKER_OUTPUT_INVALID" });
  }
  await db.prepare("UPDATE native_worker_output_chunks SET ciphertext=? WHERE job_id=?").run(Buffer.alloc(bytes.length, 0), f.jobId);
  await assert.rejects(completeWorkerJob(worker, f.jobId, claim.grant, summary(f)), { code: "WORKER_OUTPUT_INVALID" });
  assert.equal((await readNativeJob(f.projectId, f.jobId, f.actor)).artifacts.length, 0);
});

test("current submitting-session, access, cancellation and attempt fences protect every transport operation", async () => {
  for (const mutation of ["credential", "revoked", "access", "cancel", "lease", "source"] as const) {
    const f = await fixture(), { worker, claim } = await claimed(f);
    await stageWorkerOutput(worker, f.jobId, claim.grant, output(Buffer.from("AC1015bound")));
    if (mutation === "credential") await db.prepare("UPDATE users SET credential_version=credential_version+1 WHERE id=?").run(f.actor.userId);
    if (mutation === "revoked") await db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), f.actor.sessionId);
    if (mutation === "access") await db.prepare("UPDATE projects SET user_id=? WHERE id=?").run((await fixture()).actor.userId, f.projectId);
    if (mutation === "cancel") await db.prepare("UPDATE project_native_jobs SET cancel_requested=1 WHERE id=?").run(f.jobId);
    if (mutation === "lease") await db.prepare("UPDATE project_native_jobs SET claim_token=? WHERE id=?").run(randomId(), f.jobId);
    if (mutation === "source") await db.prepare("UPDATE project_native_jobs SET input_sha256=? WHERE id=?").run("f".repeat(64), f.jobId);
    for (const action of [() => readWorkerInput(worker, f.jobId, claim.grant, 0), () => renewWorkerClaim(worker, f.jobId, claim.grant), () => stageWorkerOutput(worker, f.jobId, claim.grant, output(Buffer.from("AC1015bound"))), () => completeWorkerJob(worker, f.jobId, claim.grant, summary(f))]) await assert.rejects(action(), { code: "WORKER_LEASE_LOST" });
    const artifacts = await db.prepare("SELECT COUNT(*) AS count FROM project_native_job_artifacts WHERE job_id=?").get(f.jobId) as { count: number }; assert.equal(artifacts.count, 0);
    await db.prepare("UPDATE project_native_jobs SET state='cancelled',claim_token=NULL,claim_until=0 WHERE state='running'").run();
  }
});

test("failure codes are fixed and staged data is removed; expiry cleanup cannot preserve stale attempts", async () => {
  const f = await fixture(), { worker, claim } = await claimed(f), bytes = Buffer.from("AC1015staged");
  await stageWorkerOutput(worker, f.jobId, claim.grant, output(bytes));
  const unsupported = await post(`/jobs/${f.jobId}/fail`, { version: 1, grant: claim.grant, code: "private exception details" }); assert.equal(unsupported.status, 400); assert.equal(JSON.stringify(unsupported.body).includes("private exception"), false);
  const accepted = await post(`/jobs/${f.jobId}/fail`, { version: 1, grant: claim.grant, code: "EXECUTOR_UNAVAILABLE" }); assert.equal(accepted.status, 200);
  assert.equal((await readNativeJob(f.projectId, f.jobId, f.actor)).error?.message, "Native executor is unavailable.");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM native_worker_outputs WHERE job_id=?").get(f.jobId) as { count: number }).count, 0);
  const next = await fixture(), second = await claimed(next);
  await stageWorkerOutput(second.worker, next.jobId, second.claim.grant, output(bytes));
  await db.prepare("UPDATE project_native_jobs SET claim_until=? WHERE id=?").run(now() - 1, next.jobId);
  await createWorkerClaim(second.worker, [next.kind]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM native_worker_outputs WHERE job_id=?").get(next.jobId) as { count: number }).count, 0);
});
