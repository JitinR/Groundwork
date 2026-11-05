import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MASTER_KEY } from "./config.js";
import { db, now, withTransaction } from "./db.js";
import { claimNativeJob, failNativeJob, finishNativeJob, NATIVE_JOB_KINDS, renewNativeJob, resolveNativeWorkerClaim, type NativeJobClaim } from "./nativeJobs.js";
import type { NativeJobKind, NativeJobSummary, NativeOutputArtifact } from "./nativeAdapters.js";
import { readWorkspaceArtifact } from "./workspaces.js";
import { readNativeWorkerRegistrations, type NativeWorkerRegistration, type NativeWorkerRemoteEnvironment } from "./nativeWorkerRemoteConfig.js";

export const NATIVE_WORKER_CHUNK_BYTES = 256 * 1024;
export const NATIVE_WORKER_MAX_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUTS = 8;
const GRANT_SECONDS = 600;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const grantKey = Buffer.from(hkdfSync("sha256", MASTER_KEY, "groundwork-native-worker", "grant-v1", 32));
const stagingKey = Buffer.from(hkdfSync("sha256", MASTER_KEY, "groundwork-native-worker", "staging-v1", 32));
const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const hexId = z.string().regex(/^[a-f0-9]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const workerId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const kind = z.enum(NATIVE_JOB_KINDS);
const messages = {
  WORKER_DISABLED: "Remote native workers are unavailable.",
  WORKER_AUTH: "Worker authentication was refused.",
  WORKER_SCOPE: "Worker operation is outside the configured scope.",
  WORKER_REQUEST_INVALID: "Worker request does not match the supported contract.",
  WORKER_GRANT_INVALID: "Worker job authorization was refused.",
  WORKER_LEASE_LOST: "Worker job lease is no longer active.",
  WORKER_OUTPUT_CONFLICT: "Worker output does not match the staged attempt.",
  WORKER_OUTPUT_LIMIT: "Worker output exceeds the supported budget.",
  WORKER_OUTPUT_INVALID: "Worker output failed validation.",
  WORKER_STORAGE_UNAVAILABLE: "Worker operation could not be completed.",
} as const;
type ErrorCode = keyof typeof messages;
export class NativeWorkerAuthorityError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode) { super(messages[code]); this.name = "NativeWorkerAuthorityError"; }
}
const fail = (status: number, code: ErrorCode): never => { throw new NativeWorkerAuthorityError(status, code); };
type Environment = NativeWorkerRemoteEnvironment;
type Registration = NativeWorkerRegistration;
export interface WorkerIdentity { readonly id: string; readonly projectIds: readonly string[]; readonly kinds: readonly NativeJobKind[] }
const identities = new WeakMap<WorkerIdentity, { tokenHash: string; env: Environment }>();
function registrations(env: Environment): Registration[] {
  try {
    const entries = readNativeWorkerRegistrations(env);
    if (!entries.length) return fail(503, "WORKER_DISABLED");
    return [...entries];
  } catch { return fail(503, "WORKER_DISABLED"); }
}
/** Only an opaque verified identity crosses the HTTP/service boundary. It
 * contains neither the bootstrap token nor a submitting user's session. */
export function authenticateNativeWorker(authorization: string | undefined, id: string | undefined, env: Environment = process.env): WorkerIdentity {
  const entries = registrations(env);
  if (!workerId.safeParse(id).success || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization || "")) return fail(401, "WORKER_AUTH");
  const supplied = hash(authorization!.slice(7));
  const registered = entries.find(entry => entry.id === id);
  // Always compare equal-length values, including for an unknown identity.
  const valid = timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(registered?.tokenSha256 ?? "0".repeat(64), "hex"));
  if (!registered || !valid) return fail(401, "WORKER_AUTH");
  const identity = Object.freeze({ id: registered.id, projectIds: Object.freeze([...registered.projectIds]), kinds: Object.freeze([...registered.kinds]) });
  identities.set(identity, { tokenHash: supplied, env });
  return identity;
}
function currentWorker(worker: WorkerIdentity): Registration {
  const proof = identities.get(worker);
  if (!proof) return fail(401, "WORKER_AUTH");
  const registered = registrations(proof.env).find(entry => entry.id === worker.id);
  if (!registered || !timingSafeEqual(Buffer.from(registered.tokenSha256, "hex"), Buffer.from(proof.tokenHash, "hex"))) return fail(401, "WORKER_AUTH");
  return registered;
}
const grantSchema = z.object({
  version: z.literal(1), workerId, jobId: hexId, projectId: safeId, kind,
  sourceArtifactId: hexId, sourceSha256: digest, claimToken: hexId,
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
type Grant = z.infer<typeof grantSchema>;
function signGrant(worker: Registration, claim: NativeJobClaim): string {
  const grant: Grant = { version: 1, workerId: worker.id, jobId: claim.id, projectId: claim.projectId, kind: claim.kind, sourceArtifactId: claim.artifactId, sourceSha256: claim.sha256, claimToken: claim.token, expiresAt: now() + GRANT_SECONDS };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${createHmac("sha256", grantKey).update(payload).digest("base64url")}`;
}
function verifyGrant(worker: Registration, jobId: string, value: unknown): Grant {
  try {
    if (!hexId.safeParse(jobId).success || typeof value !== "string" || value.length < 32 || value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const [payload, signature] = value.split(".");
    const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", grantKey).update(payload).digest();
    if (actual.length !== expected.length || actual.toString("base64url") !== signature || !timingSafeEqual(actual, expected)) throw new Error();
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) throw new Error();
    const grant = grantSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (grant.workerId !== worker.id || grant.jobId !== jobId || grant.expiresAt <= now() || grant.expiresAt > now() + GRANT_SECONDS) throw new Error();
    if (!worker.projectIds.includes(grant.projectId) || !worker.kinds.includes(grant.kind)) return fail(403, "WORKER_SCOPE");
    return grant;
  } catch (error) {
    if (error instanceof NativeWorkerAuthorityError) throw error;
    return fail(403, "WORKER_GRANT_INVALID");
  }
}
async function withClaim<T>(worker: WorkerIdentity, jobId: string, token: unknown, work: (claim: NativeJobClaim, grant: Grant) => Promise<T>): Promise<T> {
  const grant = verifyGrant(currentWorker(worker), jobId, token);
  const result = await withTransaction(async () => {
    const claim = await resolveNativeWorkerClaim({ id: grant.jobId, token: grant.claimToken, projectId: grant.projectId, kind: grant.kind, artifactId: grant.sourceArtifactId, sha256: grant.sourceSha256 });
    // Returning a refusal commits any durable cancellation/access-change state
    // produced by the resolver; throwing here would roll it back.
    if (!claim) return { active: false as const };
    return { active: true as const, value: await work(claim, grant) };
  });
  if (!result.active) return fail(409, "WORKER_LEASE_LOST");
  return result.value;
}
async function cleanup(): Promise<void> {
  await db.prepare(`DELETE FROM native_worker_outputs WHERE expires_at<=? OR NOT EXISTS (
    SELECT 1 FROM project_native_jobs j WHERE j.id=native_worker_outputs.job_id AND j.state='running'
    AND j.claim_token=native_worker_outputs.claim_token AND j.claim_until>? AND j.expires_at>? AND j.cancel_requested=0
  )`).run(now(), now(), now());
}
export async function createWorkerClaim(worker: WorkerIdentity, requestedKinds: unknown) {
  const registered = currentWorker(worker);
  const parsed = z.array(kind).min(1).max(3).safeParse(requestedKinds);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) return fail(400, "WORKER_REQUEST_INVALID");
  if (parsed.data.some(item => !registered.kinds.includes(item))) return fail(403, "WORKER_SCOPE");
  return await withTransaction(async () => {
    await cleanup();
    const claim = await claimNativeJob({ projectIds: registered.projectIds, kinds: parsed.data, remote: true });
    if (!claim) return { claim: null };
    const artifact = await db.prepare("SELECT size,sha256 FROM project_workspace_artifacts WHERE id=? AND project_id=?").get(claim.artifactId, claim.projectId) as { size: number; sha256: string } | undefined;
    if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > NATIVE_WORKER_MAX_BYTES || artifact.sha256 !== claim.sha256) {
      await failNativeJob(claim, "JOB_INPUT_INVALID", "Source does not meet the supported input contract.");
      return { claim: null };
    }
    return { claim: { version: 1 as const, jobId: claim.id, projectId: claim.projectId, kind: claim.kind, sourceArtifactId: claim.artifactId, sourceSha256: claim.sha256, inputBytes: artifact.size, grant: signGrant(registered, claim) } };
  });
}
export async function renewWorkerClaim(worker: WorkerIdentity, jobId: string, token: unknown) {
  return await withClaim(worker, jobId, token, async claim => ({ active: await renewNativeJob(claim) }));
}
export async function readWorkerInput(worker: WorkerIdentity, jobId: string, token: unknown, offset: unknown) {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) % NATIVE_WORKER_CHUNK_BYTES !== 0) return fail(400, "WORKER_REQUEST_INVALID");
  return await withClaim(worker, jobId, token, async claim => {
    const { artifact, bytes } = await readWorkspaceArtifact(claim.projectId, claim.artifactId, claim.actor);
    if (artifact.sha256 !== claim.sha256 || bytes.length > NATIVE_WORKER_MAX_BYTES || (offset as number) >= bytes.length) return fail(400, "WORKER_REQUEST_INVALID");
    const part = bytes.subarray(offset as number, (offset as number) + NATIVE_WORKER_CHUNK_BYTES);
    return { offset: offset as number, bytes: part.toString("base64"), sha256: hash(part), totalBytes: bytes.length };
  });
}
const outputSchema = z.object({
  index: z.number().int().min(0).max(MAX_OUTPUTS - 1), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  mediaType: z.enum(["text/plain", "application/json", "application/dxf", "image/vnd.dwg"]),
  totalBytes: z.number().int().min(1).max(NATIVE_WORKER_MAX_BYTES), sha256: digest,
  offset: z.number().int().min(0).max(NATIVE_WORKER_MAX_BYTES - 1), bytes: z.string().min(4).max(Math.ceil(NATIVE_WORKER_CHUNK_BYTES / 3) * 4),
}).strict();
interface OutputRow { job_id: string; claim_token: string; output_index: number; filename: string; mime: string; total_bytes: number; sha256: string; received_bytes: number; expires_at: number }
interface ChunkRow { chunk_offset: number; byte_length: number; sha256: string; iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }
function chunkAad(claim: NativeJobClaim, output: OutputRow, offset: number, chunkHash: string): Buffer {
  return Buffer.from(JSON.stringify(["native-worker-output-v1", claim.projectId, claim.id, claim.token, output.output_index, output.filename, output.mime, output.total_bytes, output.sha256, offset, chunkHash]));
}
function decryptChunk(claim: NativeJobClaim, output: OutputRow, chunk: ChunkRow): Buffer {
  try {
    if (chunk.iv.byteLength !== 12 || chunk.tag.byteLength !== 16 || chunk.ciphertext.byteLength !== chunk.byte_length || chunk.byte_length < 1 || chunk.byte_length > NATIVE_WORKER_CHUNK_BYTES) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", stagingKey, Buffer.from(chunk.iv));
    cipher.setAAD(chunkAad(claim, output, chunk.chunk_offset, chunk.sha256)); cipher.setAuthTag(Buffer.from(chunk.tag));
    const bytes = Buffer.concat([cipher.update(Buffer.from(chunk.ciphertext)), cipher.final()]);
    if (hash(bytes) !== chunk.sha256) throw new Error();
    return bytes;
  } catch { return fail(400, "WORKER_OUTPUT_INVALID"); }
}
export async function stageWorkerOutput(worker: WorkerIdentity, jobId: string, token: unknown, value: unknown) {
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return fail(400, "WORKER_REQUEST_INVALID");
  const input = parsed.data, bytes = Buffer.from(input.bytes, "base64");
  if (bytes.toString("base64") !== input.bytes || !bytes.length || bytes.length > NATIVE_WORKER_CHUNK_BYTES || input.offset % NATIVE_WORKER_CHUNK_BYTES !== 0 || input.offset + bytes.length > input.totalBytes || (input.offset + bytes.length < input.totalBytes && bytes.length !== NATIVE_WORKER_CHUNK_BYTES)) return fail(400, "WORKER_REQUEST_INVALID");
  return await withClaim(worker, jobId, token, async (claim, grant) => {
    let output = await db.prepare("SELECT * FROM native_worker_outputs WHERE job_id=? AND claim_token=? AND output_index=?").get(claim.id, claim.token, input.index) as OutputRow | undefined;
    if (!output) {
      const capacity = await db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(total_bytes),0) AS bytes FROM native_worker_outputs WHERE job_id=? AND claim_token=?").get(claim.id, claim.token) as { count: number; bytes: number };
      if (capacity.count >= MAX_OUTPUTS || capacity.bytes + input.totalBytes > NATIVE_WORKER_MAX_BYTES) return fail(413, "WORKER_OUTPUT_LIMIT");
      if (input.offset !== 0) return fail(409, "WORKER_OUTPUT_CONFLICT");
      const duplicate = await db.prepare("SELECT 1 AS found FROM native_worker_outputs WHERE job_id=? AND claim_token=? AND filename=?").get(claim.id, claim.token, input.filename);
      if (duplicate) return fail(409, "WORKER_OUTPUT_CONFLICT");
      await db.prepare("INSERT INTO native_worker_outputs(job_id,claim_token,output_index,filename,mime,total_bytes,sha256,received_bytes,expires_at) VALUES(?,?,?,?,?,?,?,0,?)").run(claim.id, claim.token, input.index, input.filename, input.mediaType, input.totalBytes, input.sha256, grant.expiresAt);
      output = { job_id: claim.id, claim_token: claim.token, output_index: input.index, filename: input.filename, mime: input.mediaType, total_bytes: input.totalBytes, sha256: input.sha256, received_bytes: 0, expires_at: grant.expiresAt };
    }
    if (output.filename !== input.filename || output.mime !== input.mediaType || output.total_bytes !== input.totalBytes || output.sha256 !== input.sha256 || output.expires_at <= now()) return fail(409, "WORKER_OUTPUT_CONFLICT");
    const chunkHash = hash(bytes);
    const existing = await db.prepare("SELECT chunk_offset,byte_length,sha256,iv,tag,ciphertext FROM native_worker_output_chunks WHERE job_id=? AND claim_token=? AND output_index=? AND chunk_offset=?").get(claim.id, claim.token, input.index, input.offset) as ChunkRow | undefined;
    if (existing) {
      if (existing.sha256 !== chunkHash || !decryptChunk(claim, output, existing).equals(bytes)) return fail(409, "WORKER_OUTPUT_CONFLICT");
      return { accepted: true as const, nextOffset: input.offset + bytes.length };
    }
    if (input.offset !== output.received_bytes) return fail(409, "WORKER_OUTPUT_CONFLICT");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", stagingKey, iv);
    cipher.setAAD(chunkAad(claim, output, input.offset, chunkHash));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    await db.prepare("INSERT INTO native_worker_output_chunks(job_id,claim_token,output_index,chunk_offset,byte_length,sha256,iv,tag,ciphertext,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(claim.id, claim.token, input.index, input.offset, bytes.length, chunkHash, iv, cipher.getAuthTag(), ciphertext, grant.expiresAt);
    const nextOffset = input.offset + bytes.length;
    await db.prepare("UPDATE native_worker_outputs SET received_bytes=? WHERE job_id=? AND claim_token=? AND output_index=?").run(nextOffset, claim.id, claim.token, input.index);
    return { accepted: true as const, nextOffset };
  });
}
const summarySchema = z.object({
  kind, adapter: z.enum(["LibreDWG", "OpenSees"]), declaredVersion: z.enum(["0.13.4", "3.8.0"]),
  sourceArtifactId: hexId, sourceSha256: digest, verification: z.literal("computed-unvalidated"),
  dimension: z.literal("planar-2d").optional(), combinationId: z.string().min(1).max(100).refine(value => !/[\u0000-\u001f]/.test(value)).optional(),
  warnings: z.array(z.string().max(2000)).max(16),
}).strict();
export async function completeWorkerJob(worker: WorkerIdentity, jobId: string, token: unknown, value: unknown) {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) return fail(400, "WORKER_OUTPUT_INVALID");
  return await withClaim(worker, jobId, token, async claim => {
    const summary: NativeJobSummary = parsed.data;
    const solver = claim.kind === "opensees-static";
    if (summary.kind !== claim.kind || summary.sourceArtifactId !== claim.artifactId || summary.sourceSha256 !== claim.sha256 || summary.adapter !== (solver ? "OpenSees" : "LibreDWG") || summary.declaredVersion !== (solver ? "3.8.0" : "0.13.4") || (solver ? summary.dimension !== "planar-2d" || !summary.combinationId : summary.dimension !== undefined || summary.combinationId !== undefined)) return fail(400, "WORKER_OUTPUT_INVALID");
    const rows = await db.prepare("SELECT * FROM native_worker_outputs WHERE job_id=? AND claim_token=? ORDER BY output_index").all(claim.id, claim.token) as unknown as OutputRow[];
    if (!rows.length || rows.length > MAX_OUTPUTS || rows.reduce((total, row) => total + row.total_bytes, 0) > NATIVE_WORKER_MAX_BYTES) return fail(413, "WORKER_OUTPUT_LIMIT");
    const outputs: NativeOutputArtifact[] = [];
    for (const row of rows) {
      if (row.expires_at <= now() || row.received_bytes !== row.total_bytes) return fail(409, "WORKER_OUTPUT_CONFLICT");
      const chunks = await db.prepare("SELECT chunk_offset,byte_length,sha256,iv,tag,ciphertext FROM native_worker_output_chunks WHERE job_id=? AND claim_token=? AND output_index=? ORDER BY chunk_offset").all(claim.id, claim.token, row.output_index) as unknown as ChunkRow[];
      let offset = 0; const parts: Buffer[] = [];
      for (const chunk of chunks) { if (chunk.chunk_offset !== offset) return fail(400, "WORKER_OUTPUT_INVALID"); const bytes = decryptChunk(claim, row, chunk); parts.push(bytes); offset += bytes.length; }
      const bytes = Buffer.concat(parts, offset);
      if (offset !== row.total_bytes || hash(bytes) !== row.sha256) return fail(400, "WORKER_OUTPUT_INVALID");
      outputs.push({ filename: row.filename, mediaType: row.mime, bytes, sha256: row.sha256 });
    }
    const accepted = await finishNativeJob(claim, outputs, summary);
    if (accepted) await db.prepare("DELETE FROM native_worker_outputs WHERE job_id=? AND claim_token=?").run(claim.id, claim.token);
    return { accepted };
  });
}
const failureMessages = {
  INPUT_INVALID: "Native job input failed validation.", EXECUTOR_UNAVAILABLE: "Native executor is unavailable.",
  EXECUTION_FAILED: "Native operation failed its execution or output contract.", WORKER_STOPPED: "Worker stopped before completion; submit again if needed.",
} as const;
export async function failWorkerJob(worker: WorkerIdentity, jobId: string, token: unknown, code: unknown) {
  if (typeof code !== "string" || !Object.hasOwn(failureMessages, code)) return fail(400, "WORKER_REQUEST_INVALID");
  return await withClaim(worker, jobId, token, async claim => {
    await failNativeJob(claim, code, failureMessages[code as keyof typeof failureMessages]);
    await db.prepare("DELETE FROM native_worker_outputs WHERE job_id=? AND claim_token=?").run(claim.id, claim.token);
    return { accepted: true };
  });
}
