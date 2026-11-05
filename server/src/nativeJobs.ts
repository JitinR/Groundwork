import { z } from "zod";
import { randomId, sha256Hex } from "./crypto.js";
import { db, now, withTransaction } from "./db.js";
import { getNativeCapabilities, NativeAdapterError, validateNativeInput, type NativeJobKind, type NativeJobSummary, type NativeOutputArtifact } from "./nativeAdapters.js";
import { nativeAdapterConfig, NATIVE_WORKER_ENABLED } from "./nativeJobsConfig.js";
import { remoteNativeWorkerConfiguredFor } from "./nativeWorkerRemoteConfig.js";
import { organizationAudit } from "./organization.js";
import { canWriteProject, getProjectAccess, type ProjectAccess, type ProjectRole } from "./projectAccess.js";
import { artifactIdSchema, createWorkspaceArtifact, readWorkspaceArtifact, WorkspaceError, type WorkspaceActor, type WorkspaceArtifact, type WorkspaceKind, } from "./workspaces.js";
export const NATIVE_JOB_KINDS = ["dwg-to-dxf", "dxf-to-dwg", "opensees-static"] as const;
export const nativeJobSubmitSchema = z.object({
    kind: z.enum(NATIVE_JOB_KINDS), sourceArtifactId: artifactIdSchema,
    sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceWorkspaceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    idempotencyKey: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
type JobSubmission = z.infer<typeof nativeJobSubmitSchema>;
export type NativeJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface NativeJob {
    id: string;
    projectId: string;
    kind: NativeJobKind;
    state: NativeJobState;
    sourceArtifactId: string;
    sourceSha256: string;
    sourceRevision: number;
    sourceWorkspaceRevision: number | null;
    createdAt: number;
    updatedAt: number;
    createdBy: string | null;
    attempts: number;
    error: {
        code: string;
        message: string;
    } | null;
    artifacts: WorkspaceArtifact[];
    summary: NativeJobSummary | null;
}
interface JobRow {
    id: string;
    project_id: string;
    kind: NativeJobKind;
    workspace_kind: WorkspaceKind;
    state: NativeJobState;
    input_artifact_id: string;
    input_sha256: string;
    source_revision: number;
    source_workspace_revision: number | null;
    idempotency_key: string;
    request_hash: string;
    created_by: string;
    session_id: string;
    created_at: number;
    updated_at: number;
    expires_at: number;
    attempts: number;
    cancel_requested: number;
    claim_token: string | null;
    claim_until: number;
    error_code: string | null;
    error_message: string | null;
    summary_json: string | null;
}
export interface NativeJobClaim {
    id: string;
    token: string;
    projectId: string;
    kind: NativeJobKind;
    actor: WorkspaceActor;
    artifactId: string;
    sha256: string;
}
export interface NativeJobClaimScope {
    projectIds: readonly string[];
    kinds: readonly NativeJobKind[];
    remote: true;
}
const MAX_PROJECT_JOBS = 32;
const LEASE_SECONDS = 20;
const JOB_DEADLINE_SECONDS = 600;
async function authorize(projectId: string, actor: WorkspaceActor, write = false): Promise<{
    access: ProjectAccess;
    project: {
        id: string;
        name: string;
        revision: number;
        role: ProjectRole;
    };
}> {
    const session = await db.prepare(`SELECT s.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.credential_version=u.credential_version`).get(actor.sessionId, actor.userId) as {
        status: string;
        expires_at: number;
    } | undefined;
    if (!session || session.status !== "active" || session.expires_at <= now())
        throw new WorkspaceError(401, "Session is no longer active", "SESSION_EXPIRED");
    const access = await getProjectAccess(projectId, actor.userId);
    if (!access)
        throw new WorkspaceError(404, "Project not found", "PROJECT_NOT_FOUND");
    if (write && !await canWriteProject(access))
        throw new WorkspaceError(403, "Editor access required", "READ_ONLY");
    const project = await db.prepare("SELECT id,name,revision FROM projects WHERE id=?").get(projectId) as {
        id: string;
        name: string;
        revision: number;
    } | undefined;
    if (!project)
        throw new WorkspaceError(404, "Project not found", "PROJECT_NOT_FOUND");
    if (!Number.isSafeInteger(project.revision) || project.revision < 0)
        throw new WorkspaceError(500, "Project revision is invalid", "STORAGE_ERROR");
    return { access, project: { ...project, role: access.role } };
}
async function jobRow(projectId: string, jobId: string): Promise<JobRow> {
    const row = await db.prepare("SELECT * FROM project_native_jobs WHERE project_id=? AND id=?").get(projectId, jobId) as unknown as JobRow | undefined;
    if (!row)
        throw new WorkspaceError(404, "Job not found", "JOB_NOT_FOUND");
    return row;
}
async function metadata(row: JobRow): Promise<NativeJob> {
    const artifacts = await db.prepare("SELECT a.id,a.kind,a.name,a.mime,a.size,a.sha256,a.created_at FROM project_workspace_artifacts a JOIN project_native_job_artifacts r ON r.artifact_id=a.id AND r.project_id=a.project_id WHERE r.job_id=? ORDER BY a.created_at,a.id")
        .all(row.id) as unknown as Array<{
        id: string;
        kind: WorkspaceKind;
        name: string;
        mime: string;
        size: number;
        sha256: string;
        created_at: number;
    }>;
    let summary: NativeJobSummary | null = null;
    if (row.summary_json) {
        try {
            summary = JSON.parse(row.summary_json) as NativeJobSummary;
        }
        catch {
            throw new WorkspaceError(500, "Job summary cannot be read", "STORAGE_ERROR");
        }
    }
    return {
        id: row.id, projectId: row.project_id, kind: row.kind, state: row.state,
        sourceArtifactId: row.input_artifact_id, sourceSha256: row.input_sha256,
        sourceRevision: row.source_revision, sourceWorkspaceRevision: row.source_workspace_revision,
        createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by, attempts: row.attempts,
        error: row.error_code ? { code: row.error_code, message: row.error_message || "Native job failed" } : null,
        artifacts: artifacts.map(({ created_at, ...artifact }) => ({ ...artifact, createdAt: created_at })), summary,
    };
}
export function nativeJobCapabilities(projectId?: string) {
    return getNativeCapabilities(nativeAdapterConfig).map(capability => {
        const remote = !!projectId && remoteNativeWorkerConfiguredFor(projectId, capability.kind);
        return {
            ...capability, configured: remote || capability.configured,
            available: remote || (capability.available && NATIVE_WORKER_ENABLED),
            reason: remote ? "A remote worker is configured for this project and kind; runtime/output acceptance is checked per job. Configuration does not guarantee current worker health."
                : NATIVE_WORKER_ENABLED ? capability.reason : "No native worker is configured for this project and kind.",
        };
    });
}
async function audit(access: ProjectAccess, userId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    if (access.organizationId)
        await organizationAudit(access.organizationId, userId, action, { projectId: access.projectId, ...detail });
}
export async function listNativeJobs(projectId: string, actor: WorkspaceActor) {
    return await withTransaction(async () => {
        const { project } = await authorize(projectId, actor);
        const rows = await db.prepare("SELECT * FROM project_native_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(projectId, MAX_PROJECT_JOBS) as unknown as JobRow[];
        const jobs: NativeJob[] = [];
        for (const row of rows)
            jobs.push(await metadata(row));
        return { project, jobs, capabilities: nativeJobCapabilities(projectId) };
    });
}
export async function readNativeJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<NativeJob> {
    return await withTransaction(async () => { await authorize(projectId, actor); return await metadata(await jobRow(projectId, jobId)); });
}
export async function submitNativeJob(projectId: string, actor: WorkspaceActor, input: JobSubmission): Promise<NativeJob> {
    return await withTransaction(async () => {
        const { project, access } = await authorize(projectId, actor, true);
        const requestHash = sha256Hex(JSON.stringify({ kind: input.kind, artifactId: input.sourceArtifactId, sourceRevision: input.sourceRevision, workspaceRevision: input.sourceWorkspaceRevision ?? null }));
        const previous = await db.prepare("SELECT * FROM project_native_jobs WHERE project_id=? AND created_by=? AND idempotency_key=?").get(projectId, actor.userId, input.idempotencyKey) as unknown as JobRow | undefined;
        if (previous) {
            if (previous.request_hash !== requestHash)
                throw new WorkspaceError(409, "Retry key belongs to another job request", "IDEMPOTENCY_CONFLICT");
            return await metadata(previous);
        }
        if (!nativeJobCapabilities(projectId).find(item => item.kind === input.kind)?.available)
            throw new WorkspaceError(503, "Native runtime or isolation is not configured. Review native job capabilities.", "NATIVE_UNAVAILABLE");
        if (input.sourceRevision !== project.revision)
            throw new WorkspaceError(409, "Project changed. Refresh before submitting a new job.", "SOURCE_REVISION_CONFLICT", project.revision);
        const workspaceKind = input.kind === "opensees-static" ? "engineering" : "exchange";
        const artifact = await db.prepare("SELECT size,sha256 FROM project_workspace_artifacts WHERE id=? AND project_id=? AND kind=?").get(input.sourceArtifactId, projectId, workspaceKind) as {
            size: number;
            sha256: string;
        } | undefined;
        if (!artifact || artifact.size > 32 * 1024 * 1024)
            throw new WorkspaceError(400, "Input must be a project artifact in the matching module, no larger than 32 MiB", "JOB_INPUT_INVALID");
        try {
            validateNativeInput(input.kind, (await readWorkspaceArtifact(projectId, input.sourceArtifactId, actor)).bytes);
        }
        catch (error) {
            if (error instanceof NativeAdapterError)
                throw new WorkspaceError(400, "Source does not match the supported drawing or frame JSON contract", "JOB_INPUT_INVALID");
            throw error;
        }
        if (input.sourceWorkspaceRevision !== undefined) {
            const referenced = await db.prepare("SELECT 1 AS found FROM project_workspace_snapshots WHERE project_id=? AND kind=? AND revision=? AND source_revision=? AND payload_artifact_id=? UNION ALL SELECT 1 AS found FROM project_workspace_artifact_refs r JOIN project_workspace_snapshots s ON s.project_id=r.project_id AND s.kind=r.kind AND s.revision=r.revision WHERE r.project_id=? AND r.kind=? AND r.revision=? AND s.source_revision=? AND r.artifact_id=? LIMIT 1")
                .get(projectId, workspaceKind, input.sourceWorkspaceRevision, input.sourceRevision, input.sourceArtifactId, projectId, workspaceKind, input.sourceWorkspaceRevision, input.sourceRevision, input.sourceArtifactId);
            if (!referenced)
                throw new WorkspaceError(409, "Input is not bound to the declared saved workspace revision", "WORKSPACE_SOURCE_CONFLICT");
        }
        const capacity = await db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN state IN ('queued','running') THEN 1 ELSE 0 END) AS active FROM project_native_jobs WHERE project_id=?").get(projectId) as {
            total: number;
            active: number | null;
        };
        const global = await db.prepare("SELECT COUNT(*) AS count FROM project_native_jobs WHERE state IN ('queued','running')").get() as {
            count: number;
        };
        if (capacity.total >= MAX_PROJECT_JOBS || (capacity.active ?? 0) >= 2 || global.count >= 64)
            throw new WorkspaceError(409, "Job capacity reached. Wait for active work or remove completed job records.", "JOB_CAPACITY");
        const id = randomId(), timestamp = now();
        await db.prepare("INSERT INTO project_native_jobs(id,project_id,kind,workspace_kind,state,input_artifact_id,input_sha256,source_revision,source_workspace_revision,idempotency_key,request_hash,created_by,session_id,created_at,updated_at,expires_at) VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?)")
            .run(id, projectId, input.kind, workspaceKind, input.sourceArtifactId, artifact.sha256, input.sourceRevision, input.sourceWorkspaceRevision ?? null, input.idempotencyKey, requestHash, actor.userId, actor.sessionId, timestamp, timestamp, timestamp + JOB_DEADLINE_SECONDS);
        await audit(access, actor.userId, "native-job.submit", { jobId: id, kind: input.kind, sourceSha256: artifact.sha256, sourceRevision: input.sourceRevision });
        return await metadata(await jobRow(projectId, id));
    });
}
export async function cancelNativeJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<NativeJob> {
    return await withTransaction(async () => {
        const { access } = await authorize(projectId, actor, true), row = await jobRow(projectId, jobId);
        if (row.state === "queued")
            await db.prepare("UPDATE project_native_jobs SET state='cancelled',cancel_requested=1,updated_at=? WHERE id=? AND state='queued'").run(now(), jobId);
        else if (row.state === "running")
            await db.prepare("UPDATE project_native_jobs SET cancel_requested=1,updated_at=? WHERE id=? AND state='running'").run(now(), jobId);
        await audit(access, actor.userId, "native-job.cancel", { jobId });
        return await metadata(await jobRow(projectId, jobId));
    });
}
export async function deleteNativeJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<void> {
    await withTransaction(async () => {
        const { access } = await authorize(projectId, actor, true), row = await jobRow(projectId, jobId);
        if (row.state === "running" || row.state === "queued")
            throw new WorkspaceError(409, "Cancel the job and wait for a terminal state before removing its record", "JOB_ACTIVE");
        await db.prepare("DELETE FROM project_native_jobs WHERE id=? AND project_id=?").run(jobId, projectId);
        await audit(access, actor.userId, "native-job.delete", { jobId });
    });
}
export async function readNativeJobArtifact(projectId: string, jobId: string, artifactId: string, actor: WorkspaceActor) {
    return await withTransaction(async () => {
        await authorize(projectId, actor);
        const row = await jobRow(projectId, jobId);
        const output = await db.prepare("SELECT 1 AS found FROM project_native_job_artifacts WHERE project_id=? AND job_id=? AND artifact_id=?").get(projectId, jobId, artifactId);
        if (row.input_artifact_id !== artifactId && !output)
            throw new WorkspaceError(404, "Job artifact not found", "ARTIFACT_NOT_FOUND");
        return await readWorkspaceArtifact(projectId, artifactId, actor);
    });
}
async function terminal(row: JobRow, state: "failed" | "cancelled", code: string, message: string): Promise<void> {
    await db.prepare("UPDATE project_native_jobs SET state=?,error_code=?,error_message=?,claim_token=NULL,claim_until=0,updated_at=? WHERE id=?")
        .run(state, code, message, now(), row.id);
}
/** Lease recovery and claim share the database's serialized write transaction. */
export async function claimNativeJob(scope?: NativeJobClaimScope): Promise<NativeJobClaim | null> {
    const scoped = scope === undefined ? undefined : z.object({
        projectIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)).min(1).max(128),
        kinds: z.array(z.enum(NATIVE_JOB_KINDS)).min(1).max(3), remote: z.literal(true),
    }).strict().parse(scope);
    return await withTransaction(async () => {
        const timestamp = now();
        const stale = await db.prepare("SELECT * FROM project_native_jobs WHERE state='running' AND claim_until<=? LIMIT 64").all(timestamp) as unknown as JobRow[];
        for (const row of stale) {
            if (row.cancel_requested)
                await terminal(row, "cancelled", "CANCELLED", "Job was cancelled");
            else if (row.attempts >= 2 || row.expires_at <= timestamp)
                await terminal(row, "failed", "LEASE_EXPIRED", "Worker lease expired before completion");
            else
                await db.prepare("UPDATE project_native_jobs SET state='queued',claim_token=NULL,claim_until=0,updated_at=? WHERE id=?").run(timestamp, row.id);
        }
        const running = await db.prepare("SELECT COUNT(*) AS count FROM project_native_jobs WHERE state='running'").get() as {
            count: number;
        };
        if (running.count >= 4)
            return null;
        // Filter before the bounded batch so unrelated queued projects cannot
        // starve a scoped remote worker. Only configured IDs become parameters.
        const queued = scoped
            ? await db.prepare(`SELECT * FROM project_native_jobs WHERE state='queued' AND project_id IN (${scoped.projectIds.map(() => "?").join(",")}) AND kind IN (${scoped.kinds.map(() => "?").join(",")}) ORDER BY created_at,id LIMIT 64`).all(...scoped.projectIds, ...scoped.kinds) as unknown as JobRow[]
            : await db.prepare("SELECT * FROM project_native_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 64").all() as unknown as JobRow[];
        for (const row of queued) {
            if (row.cancel_requested || row.expires_at <= timestamp) {
                await terminal(row, row.cancel_requested ? "cancelled" : "failed", row.cancel_requested ? "CANCELLED" : "QUEUE_EXPIRED", row.cancel_requested ? "Job was cancelled" : "Job exceeded its queue deadline");
                continue;
            }
            const actor = { userId: row.created_by, sessionId: row.session_id };
            try {
                await authorize(row.project_id, actor, true);
            }
            catch {
                await terminal(row, "failed", "ACCESS_CHANGED", "Submitting session or project access changed");
                continue;
            }
            if (!scoped && !getNativeCapabilities(nativeAdapterConfig).find(item => item.kind === row.kind)?.available) {
                await terminal(row, "failed", "NATIVE_UNAVAILABLE", "Native runtime or isolation is no longer configured");
                continue;
            }
            const token = randomId();
            await db.prepare("UPDATE project_native_jobs SET state='running',claim_token=?,claim_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'").run(token, timestamp + LEASE_SECONDS, timestamp, row.id);
            return { id: row.id, token, projectId: row.project_id, kind: row.kind, actor, artifactId: row.input_artifact_id, sha256: row.input_sha256 };
        }
        return null;
    });
}
/** Authority-only grant seam: reconstruct the submitting identity from durable
 * state, never from the worker. Every use is bound to one current attempt. */
export async function resolveNativeWorkerClaim(binding: Omit<NativeJobClaim, "actor">): Promise<NativeJobClaim | null> {
    return await withTransaction(async () => {
        const row = await db.prepare("SELECT * FROM project_native_jobs WHERE id=? AND project_id=? AND state='running' AND claim_token=? AND claim_until>?")
            .get(binding.id, binding.projectId, binding.token, now()) as unknown as JobRow | undefined;
        if (!row || row.kind !== binding.kind || row.input_artifact_id !== binding.artifactId || row.input_sha256 !== binding.sha256)
            return null;
        if (row.cancel_requested || row.expires_at <= now()) {
            await terminal(row, row.cancel_requested ? "cancelled" : "failed", row.cancel_requested ? "CANCELLED" : "JOB_DEADLINE_EXCEEDED", row.cancel_requested ? "Job was cancelled" : "Job exceeded its overall deadline");
            return null;
        }
        const actor = { userId: row.created_by, sessionId: row.session_id };
        try { await authorize(row.project_id, actor, true); }
        catch {
            await terminal(row, "failed", "ACCESS_CHANGED", "Submitting session or project access changed");
            return null;
        }
        return { ...binding, actor };
    });
}
async function ownedRow(claim: NativeJobClaim): Promise<JobRow | null> {
    const row = await db.prepare("SELECT * FROM project_native_jobs WHERE id=? AND project_id=? AND state='running' AND claim_token=? AND claim_until>?").get(claim.id, claim.projectId, claim.token, now()) as unknown as JobRow | undefined;
    if (row && row.expires_at <= now()) {
        await terminal(row, row.cancel_requested ? "cancelled" : "failed", row.cancel_requested ? "CANCELLED" : "JOB_DEADLINE_EXCEEDED", row.cancel_requested ? "Job was cancelled" : "Job exceeded its overall deadline");
        return null;
    }
    return row ?? null;
}
export async function renewNativeJob(claim: NativeJobClaim): Promise<boolean> {
    return await withTransaction(async () => {
        const row = await ownedRow(claim);
        if (!row)
            return false;
        if (row.cancel_requested) {
            await terminal(row, "cancelled", "CANCELLED", "Job was cancelled");
            return false;
        }
        try {
            await authorize(claim.projectId, claim.actor, true);
        }
        catch {
            await terminal(row, "failed", "ACCESS_CHANGED", "Submitting session or project access changed");
            return false;
        }
        await db.prepare("UPDATE project_native_jobs SET claim_until=? WHERE id=? AND claim_token=?").run(Math.min(now() + LEASE_SECONDS, row.expires_at), claim.id, claim.token);
        return true;
    });
}
/** Only the current fenced lease can publish; artifacts and state commit or roll back together. */
export async function finishNativeJob(claim: NativeJobClaim, outputs: NativeOutputArtifact[], summary: NativeJobSummary): Promise<boolean> {
    return await withTransaction(async () => {
        const row = await ownedRow(claim);
        if (!row)
            return false;
        if (row.cancel_requested) {
            await terminal(row, "cancelled", "CANCELLED", "Job was cancelled");
            return false;
        }
        const { access } = await authorize(claim.projectId, claim.actor, true);
        if (summary.kind !== claim.kind || summary.sourceArtifactId !== claim.artifactId || summary.sourceSha256 !== claim.sha256)
            throw new WorkspaceError(500, "Native output source binding is invalid", "JOB_OUTPUT_INVALID");
        if (!outputs.length || outputs.length > 8 || outputs.reduce((sum, item) => sum + item.bytes.byteLength, 0) > 32 * 1024 * 1024)
            throw new WorkspaceError(413, "Native output exceeds the artifact budget", "JOB_OUTPUT_SIZE");
        for (const output of outputs) {
            const bytes = Buffer.from(output.bytes);
            if (!bytes.length || sha256Hex(bytes) !== output.sha256)
                throw new WorkspaceError(500, "Native output integrity check failed", "JOB_OUTPUT_INVALID");
            const artifact = await createWorkspaceArtifact(claim.projectId, row.workspace_kind, claim.actor, output.filename, bytes);
            await db.prepare("INSERT INTO project_native_job_artifacts(job_id,project_id,workspace_kind,artifact_id) VALUES (?,?,?,?)").run(claim.id, claim.projectId, row.workspace_kind, artifact.id);
        }
        await db.prepare("UPDATE project_native_jobs SET state='succeeded',summary_json=?,claim_token=NULL,claim_until=0,error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND claim_token=?")
            .run(JSON.stringify(summary), now(), claim.id, claim.token);
        await audit(access, claim.actor.userId, "native-job.complete", { jobId: claim.id, kind: claim.kind, outputCount: outputs.length, sourceSha256: claim.sha256 });
        return true;
    });
}
export async function failNativeJob(claim: NativeJobClaim, code: string, message: string): Promise<void> {
    await withTransaction(async () => {
        const row = await ownedRow(claim);
        if (row)
            await terminal(row, row.cancel_requested ? "cancelled" : "failed", row.cancel_requested ? "CANCELLED" : code, row.cancel_requested ? "Job was cancelled" : message);
    });
}
