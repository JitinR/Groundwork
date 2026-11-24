import { z } from "zod";
import { randomId, sha256Hex } from "./crypto.js";
import { db, now, withTransaction } from "./db.js";
import { organizationAudit } from "./organization.js";
import { canManageProject, canWriteProject, getProjectAccess, type ProjectAccess, type ProjectRole } from "./projectAccess.js";
import { admitProviderRequest, isBoundedProviderJson, releaseProviderPermit, renderOutputBytes, providerLimits, withProviderDeadline, ProviderResourceError, type ProviderPermit, } from "./providerBudget.js";
import { getRenderProvider, RENDER_STYLE_PRESETS, type RenderPreset, type RenderProvider, type RenderProviderResult, } from "./renderProvider.js";
import { artifactIdSchema, createWorkspaceArtifact, readWorkspaceArtifact, WorkspaceError, type WorkspaceActor, } from "./workspaces.js";
import { MASTER_KEY, PREVIOUS_MASTER_KEY } from "./config.js";
import { createRenderPayloadCodec, type RenderInputField } from "./renderPayload.js";
const renderPayload = createRenderPayloadCodec(MASTER_KEY, PREVIOUS_MASTER_KEY);
export const RENDER_JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "unconfigured"] as const;
export type RenderJobState = (typeof RENDER_JOB_STATES)[number];
const MAX_RENDER_HISTORY = 200;
// Preserve a few diagnostic attempts while the provider is disconnected. They
// are accounted for separately from configured render history.
const MAX_UNCONFIGURED_ATTEMPTS = 4;
export const submitRenderJobSchema = z.object({
    prompt: z.string().trim().min(1, "Prompt cannot be empty").max(2000, "Prompt cannot exceed 2000 characters"),
    negativePrompt: z.string().trim().max(1000).optional(),
    stylePreset: z.string().trim().max(100).optional(),
    sourceRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sourceImageBase64: z.string().max(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 128).optional(),
    sourceImageArtifactId: artifactIdSchema.optional(),
    parameters: z.record(z.string(), z.unknown()).refine((value) => isBoundedProviderJson(value, 16384), "Parameters exceed the supported byte or complexity limits").optional(),
}).strict().superRefine((val, ctx) => {
    if (!val.sourceImageBase64 && !val.sourceImageArtifactId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Either sourceImageBase64 or sourceImageArtifactId is required",
        });
    }
    if (val.sourceImageBase64 && val.sourceImageArtifactId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Supply exactly one source image" });
    }
});
export type SubmitRenderJobInput = z.infer<typeof submitRenderJobSchema>;
export interface RenderJobSummary {
    id: string;
    projectId: string;
    sourceRevision: number;
    currentProjectRevision: number;
    isRevisionCurrent: boolean;
    revisionMismatch: boolean;
    sourceImageArtifactId: string;
    sourceImageSha256: string;
    prompt: string;
    negativePrompt: string | null;
    stylePreset: string | null;
    provider: string;
    model: string;
    version: string;
    status: RenderJobState;
    outputArtifactId: string | null;
    outputSha256: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdBy: string | null;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
    parameters: Record<string, unknown>;
}
interface RenderJobRow {
    id: string;
    project_id: string;
    source_revision: number;
    source_image_artifact_id: string;
    source_image_sha256: string;
    prompt: string;
    negative_prompt: string | null;
    style_preset: string | null;
    provider: string;
    model: string;
    version: string;
    status: RenderJobState;
    output_artifact_id: string | null;
    output_sha256: string | null;
    error_code: string | null;
    error_message: string | null;
    parameters_json: string;
    created_by: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}
type RenderAuditEntry = Pick<RenderJobRow, "id" | "project_id" | "source_revision" | "status">;
// In-memory active job cancellation controllers
const activeRenderJobs = new Map<string, AbortController>();
async function authorizeProject(projectId: string, actor: WorkspaceActor, write = false): Promise<{
    access: ProjectAccess;
    project: {
        id: string;
        name: string;
        revision: number;
        role: ProjectRole;
    };
}> {
    const session = await db
        .prepare("SELECT status,expires_at FROM sessions WHERE id=? AND user_id=?")
        .get(actor.sessionId, actor.userId) as {
        status: string;
        expires_at: number;
    } | undefined;
    if (!session || session.status !== "active" || session.expires_at <= now()) {
        throw new WorkspaceError(401, "Session is no longer active", "SESSION_EXPIRED");
    }
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
    if (!Number.isSafeInteger(project.revision) || project.revision < 0) {
        throw new WorkspaceError(500, "Project revision cannot be read safely", "STORAGE_ERROR");
    }
    return { access, project: { ...project, role: access.role } };
}
function parseParameters(jsonStr: string): Record<string, unknown> {
    try {
        const parameters: unknown = JSON.parse(jsonStr);
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || !isBoundedProviderJson(parameters, 16_384)) throw new Error("Invalid render parameters");
        return parameters as Record<string, unknown>;
    }
    catch {
        throw new WorkspaceError(500, "Stored render parameters could not be read safely", "RENDER_INPUT_INVALID");
    }
}
function sealRenderInput(value: string, projectId: string, jobId: string, field: RenderInputField): string {
    return renderPayload.seal(value, { projectId, jobId, field });
}
async function sanitizeLegacyRenderAudits(row: RenderAuditEntry): Promise<void> {
    // Retain the event while removing historical copies of free-form inputs.
    const audits = await db.prepare(`SELECT id,detail FROM organization_audit
        WHERE organization_id=(SELECT organization_id FROM projects WHERE id=?) AND action='render.submit' AND detail LIKE ?`)
        .all(row.project_id, `%${row.id}%`) as { id: number; detail: string }[];
    for (const audit of audits) {
        let detail: Record<string, unknown>;
        try { detail = JSON.parse(audit.detail) as Record<string, unknown>; } catch { continue; }
        if (!detail || detail.jobId !== row.id) continue;
        await db.prepare("UPDATE organization_audit SET detail=? WHERE id=?").run(JSON.stringify({
            projectId: row.project_id, jobId: row.id, sourceRevision: row.source_revision,
            status: RENDER_JOB_STATES.includes(detail.status as RenderJobState) ? detail.status : row.status,
        }), audit.id);
    }
}
async function openJobInputs(row: RenderJobRow): Promise<{ prompt: string; negativePrompt: string | null; stylePreset: string | null; parameters: Record<string, unknown> }> {
    try {
        const context = { projectId: row.project_id, jobId: row.id };
        const prompt = renderPayload.open(row.prompt, { ...context, field: "prompt" });
        const negative = row.negative_prompt === null ? null : renderPayload.open(row.negative_prompt, { ...context, field: "negative_prompt" });
        const style = row.style_preset === null ? null : renderPayload.open(row.style_preset, { ...context, field: "style_preset" });
        const parameters = renderPayload.open(row.parameters_json, { ...context, field: "parameters_json" });
        const parsedParameters = parseParameters(parameters.plaintext);
        if (prompt.needsRewrite || negative?.needsRewrite || style?.needsRewrite || parameters.needsRewrite) {
            await withTransaction(async () => {
                await db.prepare("UPDATE project_render_jobs SET prompt=?,negative_prompt=?,style_preset=?,parameters_json=? WHERE id=? AND project_id=?")
                    .run(sealRenderInput(prompt.plaintext, row.project_id, row.id, "prompt"), negative ? sealRenderInput(negative.plaintext, row.project_id, row.id, "negative_prompt") : null,
                        style ? sealRenderInput(style.plaintext, row.project_id, row.id, "style_preset") : null, sealRenderInput(parameters.plaintext, row.project_id, row.id, "parameters_json"), row.id, row.project_id);
                await sanitizeLegacyRenderAudits(row);
            });
        }
        return { prompt: prompt.plaintext, negativePrompt: negative?.plaintext ?? null, stylePreset: style?.plaintext ?? null, parameters: parsedParameters };
    } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError(500, "Stored render input could not be authenticated", "RENDER_INPUT_INVALID");
    }
}
async function formatJobSummary(row: RenderJobRow, currentProjectRevision: number): Promise<RenderJobSummary> {
    const isRevisionCurrent = row.source_revision === currentProjectRevision;
    const inputs = await openJobInputs(row);
    return {
        id: row.id,
        projectId: row.project_id,
        sourceRevision: row.source_revision,
        currentProjectRevision,
        isRevisionCurrent,
        revisionMismatch: !isRevisionCurrent,
        sourceImageArtifactId: row.source_image_artifact_id,
        sourceImageSha256: row.source_image_sha256,
        prompt: inputs.prompt,
        negativePrompt: inputs.negativePrompt,
        stylePreset: inputs.stylePreset,
        provider: row.provider,
        model: row.model,
        version: row.version,
        status: row.status,
        outputArtifactId: row.output_artifact_id,
        outputSha256: row.output_sha256,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        parameters: inputs.parameters,
    };
}
async function tenantAudit(access: ProjectAccess, actor: WorkspaceActor, action: string, detail: Record<string, unknown>): Promise<void> {
    if (access.organizationId) {
        await organizationAudit(access.organizationId, actor.userId, action, { projectId: access.projectId, ...detail });
    }
}
/**
 * Executes a queued render job asynchronously.
 */
async function executeRenderJob(jobId: string, projectId: string, actor: WorkspaceActor, provider: RenderProvider, permit: ProviderPermit): Promise<void> {
    const controller = new AbortController();
    activeRenderJobs.set(jobId, controller);
    try {
        // 1. Mark running
        await withTransaction(async () => {
            await authorizeProject(projectId, actor, true);
            await db.prepare("UPDATE project_render_jobs SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now(), jobId);
        });
        const job = await db.prepare("SELECT * FROM project_render_jobs WHERE id=?").get(jobId) as unknown as RenderJobRow | undefined;
        if (!job || job.status !== "running")
            return;
        const inputs = await openJobInputs(job);
        // 2. Read source image artifact
        const { bytes: sourceImageBuffer } = await readWorkspaceArtifact(projectId, job.source_image_artifact_id, actor);
        // 3. Call AI provider
        const result: RenderProviderResult = await withProviderDeadline(permit.timeoutMs, (signal) => provider.generate({
            prompt: inputs.prompt, negativePrompt: inputs.negativePrompt || undefined,
            stylePreset: inputs.stylePreset || undefined, sourceImageBuffer,
            parameters: inputs.parameters,
        }, signal), controller.signal);
        controller.signal.throwIfAborted();
        if (!Buffer.isBuffer(result.imageBuffer) || result.imageBuffer.length === 0 || result.imageBuffer.length > renderOutputBytes()) {
            throw new ProviderResourceError(502, "Rendered image exceeded the output byte limit", "PROVIDER_RESPONSE_SIZE");
        }
        // 4. Save rendered output as a brand-new versioned artifact
        const outputArtifactName = `render-output-rev${job.source_revision}-${jobId.slice(0, 8)}.png`;
        await withTransaction(async () => {
            await authorizeProject(projectId, actor, true);
            const current = await db.prepare("SELECT status FROM project_render_jobs WHERE id=? AND project_id=?").get(jobId, projectId) as {
                status: string;
            } | undefined;
            if (current?.status !== "running" || controller.signal.aborted)
                return;
            // Consume this reservation in the same transaction as the artifact write.
            await releaseProviderPermit(permit);
            const outputArtifact = await createWorkspaceArtifact(projectId, "geometry", actor, outputArtifactName, result.imageBuffer);
            const timestamp = now();
            await db.prepare("UPDATE project_render_jobs SET status='succeeded', output_artifact_id=?, output_sha256=?, updated_at=?, completed_at=? WHERE id=? AND status='running'").run(outputArtifact.id, outputArtifact.sha256, timestamp, timestamp, jobId);
        });
    }
    catch (err: unknown) {
        const error = err instanceof Error ? err : new Error("Rendering failed");
        const isAbort = error.name === "AbortError" || controller.signal.aborted;
        const status: RenderJobState = isAbort ? "cancelled" : "failed";
        const candidateCode = (error as {
            code?: string;
        }).code;
        const errorCode = typeof candidateCode === "string" && /^[A-Z0-9_]{1,64}$/.test(candidateCode) ? candidateCode : isAbort ? "CANCELLED" : "RENDER_FAILED";
        const errorMessage = isAbort ? "Job was cancelled" : "Rendering failed. Retry the job or check the provider configuration.";
        const timestamp = now();
        await withTransaction(async () => {
            await db.prepare("UPDATE project_render_jobs SET status=?, error_code=?, error_message=?, updated_at=?, completed_at=? WHERE id=? AND status IN ('queued','running')").run(status, errorCode, errorMessage, timestamp, timestamp, jobId);
        });
    }
    finally {
        activeRenderJobs.delete(jobId);
        await releaseProviderPermit(permit);
    }
}
/**
 * List all render jobs for a project.
 */
export async function listRenderJobs(projectId: string, actor: WorkspaceActor): Promise<{
    project: {
        id: string;
        name: string;
        revision: number;
        role: ProjectRole;
    };
    jobs: RenderJobSummary[];
    capabilities: {
        configured: boolean;
        provider: string;
        model: string;
        unconfiguredReason: string | null;
        presets: RenderPreset[];
    };
}> {
    return await withTransaction(async () => {
        const { project } = await authorizeProject(projectId, actor);
        const provider = getRenderProvider();
        const rows = await db
            .prepare("SELECT * FROM project_render_jobs WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT 100")
            .all(projectId) as unknown as RenderJobRow[];
        return {
            project,
            jobs: await Promise.all(rows.map((r) => formatJobSummary(r, project.revision))),
            capabilities: {
                configured: provider.isConfigured(),
                provider: provider.id,
                model: provider.model,
                unconfiguredReason: provider.getUnconfiguredReason(),
                presets: RENDER_STYLE_PRESETS,
            },
        };
    });
}
/**
 * Get details for a specific render job.
 */
export async function getRenderJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<RenderJobSummary> {
    return await withTransaction(async () => {
        const { project } = await authorizeProject(projectId, actor);
        const row = await db
            .prepare("SELECT * FROM project_render_jobs WHERE project_id=? AND id=?")
            .get(projectId, jobId) as unknown as RenderJobRow | undefined;
        if (!row)
            throw new WorkspaceError(404, "Render job not found", "JOB_NOT_FOUND");
        return formatJobSummary(row, project.revision);
    });
}
/**
 * Submit an asynchronous durable AI rendering job.
 */
export async function submitRenderJob(projectId: string, actor: WorkspaceActor, input: SubmitRenderJobInput): Promise<RenderJobSummary> {
    const provider = getRenderProvider();
    const configured = provider.isConfigured();
    const jobId = randomId();
    const timestamp = now();
    let permit: ProviderPermit | undefined;
    const summary = await withTransaction(async () => {
        const { access, project } = await authorizeProject(projectId, actor, true);
        if (input.sourceRevision > project.revision) {
            throw new WorkspaceError(409, "Source revision is ahead of current project revision", "SOURCE_REVISION_AHEAD");
        }
        await reserveRenderHistorySlot(access, actor, configured);
        if (configured)
            permit = await admitRender(projectId, actor, input);
        let sourceArtifactId = input.sourceImageArtifactId;
        let sourceSha256 = "";
        if (input.sourceImageBase64) {
            const rawBase64 = input.sourceImageBase64.replace(/^data:image\/\w+;base64,/, "");
            const imageBytes = Buffer.from(rawBase64, "base64");
            if (imageBytes.length < 100 || imageBytes.length > 32 * 1024 * 1024) {
                throw new WorkspaceError(400, "Source image must be between 100 bytes and 32 MiB", "INVALID_IMAGE_SIZE");
            }
            sourceSha256 = sha256Hex(imageBytes);
            sourceArtifactId = (await createWorkspaceArtifact(projectId, "geometry", actor, `render-source-rev${input.sourceRevision}-${jobId.slice(0, 8)}.png`, imageBytes)).id;
        }
        else if (sourceArtifactId) {
            const existing = await db.prepare("SELECT id,sha256,size FROM project_workspace_artifacts WHERE id=? AND project_id=?").get(sourceArtifactId, projectId) as {
                id: string;
                sha256: string;
                size: number;
            } | undefined;
            if (!existing)
                throw new WorkspaceError(400, "Specified source image artifact was not found", "ARTIFACT_NOT_FOUND");
            if (existing.size > 32 * 1024 * 1024)
                throw new WorkspaceError(400, "Source image cannot exceed 32 MiB", "INVALID_IMAGE_SIZE");
            sourceSha256 = existing.sha256;
        }
        else {
            throw new WorkspaceError(400, "A valid source image is required", "MISSING_SOURCE_IMAGE");
        }
        const initialStatus: RenderJobState = configured ? "queued" : "unconfigured";
        const errorCode = configured ? null : "PROVIDER_UNCONFIGURED";
        const errorMessage = configured ? null : provider.getUnconfiguredReason();
        await db.prepare(`
      INSERT INTO project_render_jobs (
        id, project_id, source_revision, source_image_artifact_id, source_image_sha256,
        prompt, negative_prompt, style_preset, provider, model, version, status,
        output_artifact_id, output_sha256, error_code, error_message, parameters_json,
        created_by, created_at, updated_at, completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(jobId, projectId, input.sourceRevision, sourceArtifactId!, sourceSha256, sealRenderInput(input.prompt, projectId, jobId, "prompt"), input.negativePrompt === undefined ? null : sealRenderInput(input.negativePrompt, projectId, jobId, "negative_prompt"), input.stylePreset === undefined ? null : sealRenderInput(input.stylePreset, projectId, jobId, "style_preset"), provider.id, provider.model, provider.version, initialStatus, null, null, errorCode, errorMessage, sealRenderInput(JSON.stringify(input.parameters ?? {}), projectId, jobId, "parameters_json"), actor.userId, timestamp, timestamp, configured ? null : timestamp);
        await tenantAudit(access, actor, "render.submit", {
            jobId,
            sourceRevision: input.sourceRevision,
            status: initialStatus,
        });
        const row = await db.prepare("SELECT * FROM project_render_jobs WHERE id=?").get(jobId) as unknown as RenderJobRow;
        return formatJobSummary(row, project.revision);
    });
    if (permit)
        void executeRenderJob(jobId, projectId, actor, provider, permit).catch(() => {
            console.warn("[groundwork] Render completion could not be persisted; the durable job remains available for reconciliation");
        });
    return summary;
}
async function removeRenderRecord(access: ProjectAccess, actor: WorkspaceActor, row: RenderAuditEntry, reason: "retention" | "owner"): Promise<void> {
    await sanitizeLegacyRenderAudits(row);
    // Workspace artifact deletion applies its own authorization and reference
    // checks. Removing metadata does not delete a source image.
    await db.prepare("DELETE FROM project_render_jobs WHERE id=? AND project_id=?").run(row.id, access.projectId);
    await tenantAudit(access, actor, "render.history.remove", { jobId: row.id, reason });
}

async function reserveRenderHistorySlot(access: ProjectAccess, actor: WorkspaceActor, configured: boolean, originalId = ""): Promise<void> {
    const projectId = access.projectId;
    if (!configured) {
        const { count } = await db.prepare("SELECT COUNT(*) AS count FROM project_render_jobs WHERE project_id=? AND status='unconfigured'")
            .get(projectId) as { count: number };
        if (count >= MAX_UNCONFIGURED_ATTEMPTS) {
            throw new WorkspaceError(503, "Connect a rendering provider before creating another render attempt.", "PROVIDER_UNCONFIGURED");
        }
        return;
    }
    const { count } = await db.prepare("SELECT COUNT(*) AS count FROM project_render_jobs WHERE project_id=? AND status<>'unconfigured'")
        .get(projectId) as { count: number };
    if (count < MAX_RENDER_HISTORY) return;
    const oldest = await db.prepare(`SELECT id,project_id,source_revision,status FROM project_render_jobs
        WHERE project_id=? AND id<>? AND status IN ('failed','cancelled') AND completed_at IS NOT NULL AND output_artifact_id IS NULL
        ORDER BY completed_at, id LIMIT 1`).get(projectId, originalId) as RenderAuditEntry | undefined;
    if (!oldest) {
        throw new WorkspaceError(409, "Project render history capacity reached. Wait for active renders or remove unsuccessful attempts.", "RENDER_HISTORY_CAPACITY");
    }
    await removeRenderRecord(access, actor, oldest, "retention");
}

export async function removeRenderHistoryEntry(projectId: string, jobId: string, actor: WorkspaceActor): Promise<void> {
    await withTransaction(async () => {
        const { access } = await authorizeProject(projectId, actor, true);
        if (!canManageProject(access)) {
            throw new WorkspaceError(403, "Owner access required to remove render history", "OWNER_REQUIRED");
        }
        const row = await db.prepare(`SELECT id,project_id,source_revision,status,completed_at,output_artifact_id
            FROM project_render_jobs WHERE project_id=? AND id=?`).get(projectId, jobId) as
            Pick<RenderJobRow, keyof RenderAuditEntry | "completed_at" | "output_artifact_id"> | undefined;
        if (!row) throw new WorkspaceError(404, "Render job not found", "JOB_NOT_FOUND");
        if (row.completed_at === null || row.output_artifact_id !== null || !["failed", "cancelled", "unconfigured"].includes(row.status)) {
            throw new WorkspaceError(409, "Only completed render attempts without an output can be removed", "INVALID_STATE");
        }
        await removeRenderRecord(access, actor, row, "owner");
    });
}
async function admitRender(projectId: string, actor: WorkspaceActor, input: {
    prompt: string;
    negativePrompt?: string | null;
    parameters?: Record<string, unknown>;
}): Promise<ProviderPermit> {
    // Image generation uses a fixed request charge proxy plus bounded prompt bytes.
    return await admitProviderRequest({
        userId: actor.userId, kind: "render", projectId,
        tokenBudget: 4096 + Buffer.byteLength(input.prompt + (input.negativePrompt ?? "") + JSON.stringify(input.parameters ?? {}), "utf8"),
        reservedBytes: renderOutputBytes(), reservedArtifacts: 1,
    });
}
/**
 * Retries a failed or cancelled render job by creating an immutable NEW job,
 * preserving historical records and outputs without corrupting the original.
 */
export async function retryRenderJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<RenderJobSummary> {
    const provider = getRenderProvider();
    const configured = provider.isConfigured();
    const newJobId = randomId();
    const timestamp = now();
    let permit: ProviderPermit | undefined;
    const summary = await withTransaction(async () => {
        const { access, project } = await authorizeProject(projectId, actor, true);
        const original = await db
            .prepare("SELECT * FROM project_render_jobs WHERE id=? AND project_id=?")
            .get(jobId, projectId) as unknown as RenderJobRow | undefined;
        if (!original)
            throw new WorkspaceError(404, "Original render job not found", "JOB_NOT_FOUND");
        if (original.status === "queued" || original.status === "running") {
            throw new WorkspaceError(409, "An active render cannot be retried", "INVALID_STATE");
        }
        await reserveRenderHistorySlot(access, actor, configured, jobId);
        const originalInputs = await openJobInputs(original);
        const newParams = { ...originalInputs.parameters, retriedFromJobId: jobId };
        if (!isBoundedProviderJson(newParams, 16_384)) throw new WorkspaceError(409, "Retried render parameters exceed the supported limit", "RENDER_INPUT_INVALID");
        const source = await db.prepare("SELECT size FROM project_workspace_artifacts WHERE id=? AND project_id=?").get(original.source_image_artifact_id, projectId) as {
            size: number;
        } | undefined;
        if (!source || source.size > 32 * 1024 * 1024)
            throw new WorkspaceError(400, "The original source image is unavailable or too large", "ARTIFACT_NOT_FOUND");
        if (configured)
            permit = await admitRender(projectId, actor, { prompt: originalInputs.prompt, negativePrompt: originalInputs.negativePrompt, parameters: newParams });
        const initialStatus: RenderJobState = configured ? "queued" : "unconfigured";
        const errorCode = configured ? null : "PROVIDER_UNCONFIGURED";
        const errorMessage = configured ? null : provider.getUnconfiguredReason();
        await db.prepare(`
      INSERT INTO project_render_jobs (
        id, project_id, source_revision, source_image_artifact_id, source_image_sha256,
        prompt, negative_prompt, style_preset, provider, model, version, status,
        output_artifact_id, output_sha256, error_code, error_message, parameters_json,
        created_by, created_at, updated_at, completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(newJobId, projectId, original.source_revision, original.source_image_artifact_id, original.source_image_sha256, sealRenderInput(originalInputs.prompt, projectId, newJobId, "prompt"), originalInputs.negativePrompt === null ? null : sealRenderInput(originalInputs.negativePrompt, projectId, newJobId, "negative_prompt"), originalInputs.stylePreset === null ? null : sealRenderInput(originalInputs.stylePreset, projectId, newJobId, "style_preset"), provider.id, provider.model, provider.version, initialStatus, null, null, errorCode, errorMessage, sealRenderInput(JSON.stringify(newParams), projectId, newJobId, "parameters_json"), actor.userId, timestamp, timestamp, configured ? null : timestamp);
        await tenantAudit(access, actor, "render.retry", {
            originalJobId: jobId,
            newJobId,
            sourceRevision: original.source_revision,
            status: initialStatus,
        });
        const row = await db.prepare("SELECT * FROM project_render_jobs WHERE id=?").get(newJobId) as unknown as RenderJobRow;
        return formatJobSummary(row, project.revision);
    });
    if (permit)
        void executeRenderJob(newJobId, projectId, actor, provider, permit).catch(() => {
            console.warn("[groundwork] Render completion could not be persisted; the durable job remains available for reconciliation");
        });
    return summary;
}
/**
 * Cancel an in-flight or queued render job.
 */
export async function cancelRenderJob(projectId: string, jobId: string, actor: WorkspaceActor): Promise<RenderJobSummary> {
    return await withTransaction(async () => {
        const { access, project } = await authorizeProject(projectId, actor, true);
        const row = await db
            .prepare("SELECT * FROM project_render_jobs WHERE id=? AND project_id=?")
            .get(jobId, projectId) as unknown as RenderJobRow | undefined;
        if (!row)
            throw new WorkspaceError(404, "Render job not found", "JOB_NOT_FOUND");
        if (row.status !== "queued" && row.status !== "running") {
            throw new WorkspaceError(409, `Job cannot be cancelled in state ${row.status}`, "INVALID_STATE");
        }
        // Signal abort
        const controller = activeRenderJobs.get(jobId);
        if (controller) {
            controller.abort();
        }
        const timestamp = now();
        await db.prepare("UPDATE project_render_jobs SET status='cancelled', error_code='CANCELLED', error_message='Job was cancelled by user', updated_at=?, completed_at=? WHERE id=?").run(timestamp, timestamp, jobId);
        await tenantAudit(access, actor, "render.cancel", { jobId });
        const updated = await db.prepare("SELECT * FROM project_render_jobs WHERE id=?").get(jobId) as unknown as RenderJobRow;
        return formatJobSummary(updated, project.revision);
    });
}
/**
 * Retrieves the raw image artifact bytes (source or output) for a render job.
 */
export async function getRenderJobArtifact(projectId: string, jobId: string, which: "output" | "source", actor: WorkspaceActor): Promise<{
    bytes: Buffer;
    mime: string;
    filename: string;
    sha256: string;
}> {
    return await withTransaction(async () => {
        await authorizeProject(projectId, actor);
        const job = await db
            .prepare("SELECT * FROM project_render_jobs WHERE id=? AND project_id=?")
            .get(jobId, projectId) as unknown as RenderJobRow | undefined;
        if (!job)
            throw new WorkspaceError(404, "Render job not found", "JOB_NOT_FOUND");
        const targetArtifactId = which === "output" ? job.output_artifact_id : job.source_image_artifact_id;
        if (!targetArtifactId) {
            throw new WorkspaceError(404, `No ${which} image artifact available for this job`, "ARTIFACT_NOT_FOUND");
        }
        const { artifact, bytes } = await readWorkspaceArtifact(projectId, targetArtifactId, actor);
        return {
            bytes,
            mime: "image/png",
            filename: artifact.name || `render-${which}-${jobId}.png`,
            sha256: artifact.sha256,
        };
    });
}
/**
 * Reconcile any in-flight jobs interrupted during server shutdown.
 */
export async function reconcileInterruptedRenderJobs(): Promise<void> {
    try {
        const timestamp = now();
        // Another API instance may still own the work. Only expired jobs without
        // a live provider reservation are eligible for crash reconciliation.
        const grace = Math.ceil(providerLimits("render").timeoutMs / 1000) + 120;
        await db.prepare(`UPDATE project_render_jobs SET status='failed', error_code='WORKER_EXPIRED',
          error_message='Render worker did not finish within its reservation', updated_at=?, completed_at=?
          WHERE status IN ('queued','running') AND updated_at<? AND NOT EXISTS
          (SELECT 1 FROM provider_active_permits p WHERE p.project_id=project_render_jobs.project_id AND p.kind='render' AND p.expires_at>?)`)
          .run(timestamp, timestamp, timestamp - grace, timestamp);
    }
    catch {
        // Schema might not be initialized yet during early test runs
    }
}
