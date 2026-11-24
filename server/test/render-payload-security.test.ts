import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRenderPayloadCodec } from "../src/renderPayload.js";

const master = randomBytes(32), previous = randomBytes(32);
process.env.DATABASE_PROVIDER = "sqlite";
process.env.DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.MASTER_KEY = master.toString("base64");
process.env.PREVIOUS_MASTER_KEY = previous.toString("base64");
const directory = mkdtempSync(join(tmpdir(), "groundwork-render-input-"));
process.env.GROUNDWORK_DATA_DIR = directory;
delete process.env.DB_PATH;
const { db, now, withTransaction } = await import("../src/db.js");
const { createWorkspaceArtifact } = await import("../src/workspaces.js");
const { submitRenderJob, retryRenderJob, getRenderJob } = await import("../src/renderJobs.js");
const { DemoRenderProvider, setRenderProviderForTesting, UnconfiguredRenderProvider } = await import("../src/renderProvider.js");
setRenderProviderForTesting(new UnconfiguredRenderProvider());
after(async () => { setRenderProviderForTesting(null); await db.close(); rmSync(directory, { force: true, recursive: true }); });
const actor = { userId: "render-privacy-user", sessionId: "render-privacy-session" }, projectId = "render-privacy-project", organizationId = "render-privacy-organization";
await db.prepare("INSERT INTO users(id,email,email_verified,password_salt,password_hash,password_changed_at,created_at,updated_at) VALUES (?, ?,1,'fixture','fixture',?,?,?)").run(actor.userId, "render-privacy@example.invalid", now(), now(), now());
await db.prepare("INSERT INTO sessions(id,user_id,token_hash,csrf_token,status,created_at,last_seen_at,expires_at) VALUES (?,?,'render-token','csrf','active',?,?,?)").run(actor.sessionId, actor.userId, now(), now(), now() + 3600);
await db.prepare("INSERT INTO organizations(id,name,created_by,created_at,updated_at) VALUES (?,'Render privacy fixture',?,?,?)").run(organizationId, actor.userId, now(), now());
await db.prepare("INSERT INTO organization_members(organization_id,user_id,role,created_at) VALUES (?,?,'owner',?)").run(organizationId, actor.userId, now());
await db.prepare("INSERT INTO projects(id,user_id,organization_id,name,design_data,created_at,updated_at) VALUES (?,?,?,'Fixture','{}',?,?)").run(projectId, actor.userId, organizationId, now(), now());
const png = Buffer.alloc(256, 1); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
const source = await createWorkspaceArtifact(projectId, "geometry", actor, "fixture.png", png);
const input = { prompt: "private architecture address", negativePrompt: "private exclusion request", parameters: { privateNote: "private design parameter" }, sourceRevision: 0, sourceImageArtifactId: source.id };

test("render payload authentication binds project, job and field, supports a prior key, and rejects tampering", () => {
  const codec = createRenderPayloadCodec(master, previous), old = createRenderPayloadCodec(previous);
  const context = { projectId, jobId: "job", field: "prompt" as const };
  const encrypted = old.seal("private text", context);
  assert.equal(encrypted.includes("private text"), false);
  assert.deepEqual(codec.open(encrypted, context), { plaintext: "private text", needsRewrite: true });
  for (const changed of [{ ...context, projectId: "another" }, { ...context, jobId: "another" }, { ...context, field: "parameters_json" as const }]) assert.throws(() => codec.open(encrypted, changed), /authenticated/);
  assert.throws(() => codec.open(encrypted.slice(0, -3) + "bad", context), /authenticated/);
  assert.throws(() => codec.open("groundwork-render:v2:unknown", context), /Unsupported/);
});

test("render submissions and retries encrypt stored inputs and omit prompt copies from organization audit", async () => {
  const job = await submitRenderJob(projectId, actor, input);
  assert.equal(job.prompt, input.prompt); assert.deepEqual(job.parameters, input.parameters);
  const raw = await db.prepare("SELECT prompt,negative_prompt,parameters_json FROM project_render_jobs WHERE id=?").get(job.id) as Record<string, string>;
  for (const value of Object.values(raw)) { assert.ok(value.startsWith("groundwork-render:v1:")); assert.equal(value.includes("private"), false); }
  const audits = await db.prepare("SELECT detail FROM organization_audit WHERE action='render.submit'").all() as { detail: string }[];
  assert.equal(audits.length, 1); assert.equal(audits[0].detail.includes("private"), false);
  const retry = await retryRenderJob(projectId, job.id, actor);
  assert.equal(retry.prompt, input.prompt); assert.equal(retry.parameters.retriedFromJobId, job.id);
  const copied = await db.prepare("SELECT prompt FROM project_render_jobs WHERE id=?").get(retry.id) as { prompt: string };
  assert.notEqual(copied.prompt, raw.prompt, "retry ciphertext must be rebound to the new immutable job");
});

test("authorized reads lazily encrypt legacy plaintext and previous-key rows and sanitize old audit copies", async () => {
  const job = await submitRenderJob(projectId, actor, input);
  await db.prepare("UPDATE project_render_jobs SET prompt=?,negative_prompt=?,parameters_json=? WHERE id=?").run(input.prompt, input.negativePrompt, JSON.stringify(input.parameters), job.id);
  await db.prepare("UPDATE organization_audit SET detail=? WHERE action='render.submit' AND detail LIKE ?").run(JSON.stringify({ jobId: job.id, projectId, prompt: input.prompt, parameters: input.parameters, status: "unconfigured" }), `%${job.id}%`);
  assert.equal((await getRenderJob(projectId, job.id, actor)).prompt, input.prompt);
  const migrated = await db.prepare("SELECT prompt FROM project_render_jobs WHERE id=?").get(job.id) as { prompt: string };
  assert.ok(migrated.prompt.startsWith("groundwork-render:v1:"));
  const audit = await db.prepare("SELECT detail FROM organization_audit WHERE action='render.submit' AND detail LIKE ?").get(`%${job.id}%`) as { detail: string };
  assert.equal(audit.detail.includes(input.prompt), false); assert.equal(audit.detail.includes("parameters"), false);
  const old = createRenderPayloadCodec(previous), current = createRenderPayloadCodec(master);
  await db.prepare("UPDATE project_render_jobs SET prompt=? WHERE id=?").run(old.seal(input.prompt, { projectId, jobId: job.id, field: "prompt" }), job.id);
  await getRenderJob(projectId, job.id, actor);
  const rotated = await db.prepare("SELECT prompt FROM project_render_jobs WHERE id=?").get(job.id) as { prompt: string };
  assert.equal(current.open(rotated.prompt, { projectId, jobId: job.id, field: "prompt" }).plaintext, input.prompt);
  const other = await submitRenderJob(projectId, actor, input);
  await db.prepare("UPDATE project_render_jobs SET prompt=? WHERE id=?").run(rotated.prompt, other.id);
  await assert.rejects(getRenderJob(projectId, other.id, actor), /could not be authenticated/);
});

test("old unsuccessful history leaves capacity for a retry while successful outputs remain attached", async () => {
  const entries = Array.from({ length: 200 }, (_, i) => (i + 1).toString(16).padStart(32, "0"));
  const output = await createWorkspaceArtifact(projectId, "geometry", actor, "original-render.png", png);
  const insert = db.prepare(`INSERT INTO project_render_jobs (
    id,project_id,source_revision,source_image_artifact_id,source_image_sha256,prompt,
    provider,model,version,status,output_artifact_id,output_sha256,created_by,created_at,updated_at,completed_at
  ) VALUES (?,?,0,?,?,'Imported architecture study','fixture','fixture','1',?,?,?,?,?,?,?)`);
  const oldest = now() - entries.length;
  await withTransaction(async () => {
    for (const [i, id] of entries.entries()) {
      const time = oldest + i;
      const succeeded = i === 0;
      await insert.run(id, projectId, source.id, source.sha256, succeeded ? "succeeded" : "failed",
        succeeded ? output.id : null, succeeded ? output.sha256 : null, actor.userId, time, time, time);
    }
  });
  setRenderProviderForTesting(new DemoRenderProvider());
  const [successful, retrySource, retired] = entries;
  const retried = await retryRenderJob(projectId, retrySource, actor);
  let result = await getRenderJob(projectId, retried.id, actor);
  for (let i = 0; i < 30 && (result.status === "queued" || result.status === "running"); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    result = await getRenderJob(projectId, retried.id, actor);
  }
  assert.equal(result.status, "succeeded");
  assert.equal(result.parameters.retriedFromJobId, retrySource);
  assert.equal((await getRenderJob(projectId, successful, actor)).outputArtifactId, output.id);
  assert.equal((await getRenderJob(projectId, retrySource, actor)).status, "failed");
  assert.equal(await db.prepare("SELECT id FROM project_render_jobs WHERE id=?").get(retired), undefined);
  const history = await db.prepare("SELECT COUNT(*) AS count FROM project_render_jobs WHERE project_id=? AND status<>'unconfigured'").get(projectId) as { count: number };
  assert.equal(history.count, 200);
});
