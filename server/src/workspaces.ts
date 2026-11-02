import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { MASTER_KEY, PREVIOUS_MASTER_KEY } from "./config.js";
import { deriveVaultKey, randomId, sha256Hex } from "./crypto.js";
import { db, now, withTransaction } from "./db.js";
import { getReservedArtifactCapacity } from "./providerBudget.js";
import { organizationAudit } from "./organization.js";
import { canWriteProject, getProjectAccess, type ProjectAccess, type ProjectRole } from "./projectAccess.js";
export const WORKSPACE_KINDS = ["engineering", "exchange", "geometry"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_PROJECT_ARTIFACTS = 128;
const MAX_WORKSPACE_HISTORY = 32;
const vaultKey = deriveVaultKey(MASTER_KEY);
const previousVaultKey = PREVIOUS_MASTER_KEY ? deriveVaultKey(PREVIOUS_MASTER_KEY) : null;
export const artifactIdSchema = z.string().regex(/^[a-f0-9]{32}$/, "Invalid artifact ID");
export const workspaceSaveSchema = z.object({
    baseWorkspaceRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    sourceRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    payloadArtifactId: artifactIdSchema,
    referencedArtifactIds: z.array(artifactIdSchema).max(16).default([]),
    requireCurrentSource: z.boolean().optional(),
}).strict().superRefine((value, context) => {
    if (new Set(value.referencedArtifactIds).size !== value.referencedArtifactIds.length || value.referencedArtifactIds.includes(value.payloadArtifactId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Referenced artifacts must be distinct and exclude the payload artifact" });
    }
});
type WorkspaceSave = z.infer<typeof workspaceSaveSchema>;
export interface WorkspaceActor {
    userId: string;
    sessionId: string;
}
export interface WorkspaceSnapshot {
    kind: WorkspaceKind;
    revision: number;
    sourceRevision: number;
    payloadArtifactId: string;
    referencedArtifactIds: string[];
    updatedAt: number;
    updatedBy: string | null;
}
export interface WorkspaceState {
    project: {
        id: string;
        name: string;
        revision: number;
        role: ProjectRole;
    };
    workspace: WorkspaceSnapshot | null;
    history: WorkspaceSnapshot[];
}
export interface WorkspaceArtifact {
    id: string;
    kind: WorkspaceKind;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    createdAt: number;
}
interface ArtifactRow {
    id: string;
    kind: WorkspaceKind;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    created_at: number;
}
interface StoredArtifact extends ArtifactRow {
    iv: Uint8Array;
    tag: Uint8Array;
    ciphertext: Uint8Array;
}
interface SnapshotRow {
    kind: WorkspaceKind;
    revision: number;
    source_revision: number;
    payload_artifact_id: string;
    referenced_artifact_ids: string;
    updated_at: number;
    updated_by: string | null;
}
interface ProjectRow {
    id: string;
    name: string;
    revision: number;
}
export class WorkspaceError extends Error {
    constructor(public readonly status: number, message: string, public readonly code: string, public readonly currentRevision?: number) {
        super(message);
        this.name = "WorkspaceError";
    }
}
/** Repeat the session and membership check within every atomic operation, including after multipart reception. */
async function authorize(projectId: string, actor: WorkspaceActor, write = false): Promise<{
    access: ProjectAccess;
    project: ProjectRow;
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
    const project = await db.prepare("SELECT id,name,revision FROM projects WHERE id=?").get(projectId) as ProjectRow | undefined;
    if (!project)
        throw new WorkspaceError(404, "Project not found", "PROJECT_NOT_FOUND");
    if (!Number.isSafeInteger(project.revision) || project.revision < 0)
        throw new WorkspaceError(500, "Project revision cannot be read safely", "STORAGE_ERROR");
    return { access, project };
}
function artifactMetadata(row: ArtifactRow): WorkspaceArtifact {
    return { id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at };
}
function snapshotMetadata(row: SnapshotRow): WorkspaceSnapshot {
    let ids: unknown;
    try {
        ids = JSON.parse(row.referenced_artifact_ids);
    }
    catch {
        throw new WorkspaceError(500, "Workspace artifact references cannot be read", "STORAGE_ERROR");
    }
    const parsed = z.array(artifactIdSchema).max(16).safeParse(ids);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length || parsed.data.includes(row.payload_artifact_id)) {
        throw new WorkspaceError(500, "Workspace artifact references cannot be read", "STORAGE_ERROR");
    }
    return {
        kind: row.kind, revision: row.revision, sourceRevision: row.source_revision, payloadArtifactId: row.payload_artifact_id,
        referencedArtifactIds: parsed.data, updatedAt: row.updated_at, updatedBy: row.updated_by,
    };
}
async function state(project: ProjectRow, access: ProjectAccess, kind: WorkspaceKind): Promise<WorkspaceState> {
    const rows = await db.prepare("SELECT kind,revision,source_revision,payload_artifact_id,referenced_artifact_ids,updated_at,updated_by FROM project_workspace_snapshots WHERE project_id=? AND kind=? ORDER BY revision DESC LIMIT ?")
        .all(project.id, kind, MAX_WORKSPACE_HISTORY) as unknown as SnapshotRow[];
    const current = await db.prepare("SELECT current_revision FROM project_workspaces WHERE project_id=? AND kind=?").get(project.id, kind) as {
        current_revision: number;
    } | undefined;
    const history = rows.map(snapshotMetadata);
    const workspace = current ? history.find((item) => item.revision === current.current_revision) : null;
    if ((current && !workspace) || (!current && history.length))
        throw new WorkspaceError(500, "Workspace history is inconsistent", "STORAGE_ERROR");
    return { project: { ...project, role: access.role }, workspace: workspace ?? null, history };
}
async function tenantAudit(access: ProjectAccess, actor: WorkspaceActor, action: string, detail: Record<string, unknown>): Promise<void> {
    if (access.organizationId)
        await organizationAudit(access.organizationId, actor.userId, action, { projectId: access.projectId, ...detail });
}
export async function readWorkspace(projectId: string, kind: WorkspaceKind, actor: WorkspaceActor): Promise<WorkspaceState> {
    return await withTransaction(async () => {
        const { access, project } = await authorize(projectId, actor);
        return await state(project, access, kind);
    });
}
export async function saveWorkspace(projectId: string, kind: WorkspaceKind, actor: WorkspaceActor, input: WorkspaceSave): Promise<WorkspaceState> {
    return await withTransaction(async () => {
        const { access, project } = await authorize(projectId, actor, true);
        const latest = await db.prepare("SELECT current_revision FROM project_workspaces WHERE project_id=? AND kind=?").get(projectId, kind) as {
            current_revision: number;
        } | undefined;
        const currentRevision = latest?.current_revision ?? 0;
        if (currentRevision !== input.baseWorkspaceRevision)
            throw new WorkspaceError(409, "Workspace changed. Reload or preserve a separate copy before saving.", "WORKSPACE_CONFLICT", currentRevision);
        if (!Number.isSafeInteger(currentRevision) || currentRevision >= Number.MAX_SAFE_INTEGER)
            throw new WorkspaceError(409, "Workspace revision capacity reached", "REVISION_CAPACITY", currentRevision);
        if (input.sourceRevision > project.revision)
            throw new WorkspaceError(409, "Workspace source revision is ahead of the saved project", "SOURCE_REVISION_AHEAD", project.revision);
        if (input.requireCurrentSource && input.sourceRevision !== project.revision)
            throw new WorkspaceError(409, "Project geometry changed while generated artifacts were being prepared. Reimport the current source before saving.", "SOURCE_REVISION_CHANGED", project.revision);
        const count = await db.prepare("SELECT COUNT(*) AS count FROM project_workspace_snapshots WHERE project_id=? AND kind=?").get(projectId, kind) as {
            count: number;
        };
        if (count.count >= MAX_WORKSPACE_HISTORY)
            throw new WorkspaceError(409, "Workspace history is full. Prune earlier revisions before saving.", "HISTORY_CAPACITY", currentRevision);
        const artifactIds = [input.payloadArtifactId, ...input.referencedArtifactIds];
        const artifacts = await db.prepare(`SELECT id FROM project_workspace_artifacts WHERE project_id=? AND kind=? AND id IN (${artifactIds.map(() => "?").join(",")})`)
            .all(projectId, kind, ...artifactIds);
        if (artifacts.length !== artifactIds.length)
            throw new WorkspaceError(400, "A workspace artifact is missing or belongs to another project or module", "ARTIFACT_INVALID");
        const revision = currentRevision + 1;
        await db.prepare("INSERT INTO project_workspace_snapshots(project_id,kind,revision,source_revision,payload_artifact_id,referenced_artifact_ids,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)")
            .run(projectId, kind, revision, input.sourceRevision, input.payloadArtifactId, JSON.stringify(input.referencedArtifactIds), actor.userId, now());
        if (input.referencedArtifactIds.length)
            await db.prepare(`INSERT INTO project_workspace_artifact_refs(project_id,kind,revision,artifact_id) VALUES ${input.referencedArtifactIds.map(() => "(?,?,?,?)").join(",")}`)
                .run(...input.referencedArtifactIds.flatMap((artifactId) => [projectId, kind, revision, artifactId]));
        await db.prepare("INSERT INTO project_workspaces(project_id,kind,current_revision) VALUES (?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET current_revision=excluded.current_revision")
            .run(projectId, kind, revision);
        await tenantAudit(access, actor, "workspace.save", { kind, revision, sourceRevision: input.sourceRevision, referenceCount: input.referencedArtifactIds.length });
        return await state(project, access, kind);
    });
}
export async function pruneWorkspaceHistory(projectId: string, kind: WorkspaceKind, actor: WorkspaceActor, beforeRevision: number): Promise<WorkspaceState & {
    deleted: number;
}> {
    return await withTransaction(async () => {
        const { access, project } = await authorize(projectId, actor, true);
        const deleted = Number((await db.prepare("DELETE FROM project_workspace_snapshots WHERE project_id=? AND kind=? AND revision<? AND revision<>COALESCE((SELECT current_revision FROM project_workspaces WHERE project_id=? AND kind=?),0) AND NOT EXISTS (SELECT 1 FROM project_native_jobs j WHERE j.project_id=project_workspace_snapshots.project_id AND j.workspace_kind=project_workspace_snapshots.kind AND j.source_workspace_revision=project_workspace_snapshots.revision)")
            .run(projectId, kind, beforeRevision, projectId, kind)).changes);
        await tenantAudit(access, actor, "workspace.prune", { kind, beforeRevision, deleted });
        return { ...await state(project, access, kind), deleted };
    });
}
function artifactAad(ownerId: string, projectId: string, artifactId: string): Buffer {
    return Buffer.from(`groundwork:workspace-artifact:${ownerId}:${projectId}:${artifactId}`, "utf8");
}
function safeName(name: string): string {
    const basename = name.replace(/\\/g, "/").split("/").pop() ?? "artifact.bin";
    return basename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "artifact.bin";
}
export async function listWorkspaceArtifacts(projectId: string, actor: WorkspaceActor, kind?: WorkspaceKind): Promise<{
    artifacts: WorkspaceArtifact[];
    storedBytes: number;
    maximumBytes: number;
    maximumArtifacts: number;
}> {
    return await withTransaction(async () => {
        await authorize(projectId, actor);
        const rows = await db.prepare(`SELECT id,kind,name,mime,size,sha256,created_at FROM project_workspace_artifacts WHERE project_id=?${kind ? " AND kind=?" : ""} ORDER BY created_at DESC,id LIMIT ?`)
            .all(projectId, ...(kind ? [kind] : []), MAX_PROJECT_ARTIFACTS) as unknown as ArtifactRow[];
        const total = await db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM project_workspace_artifacts WHERE project_id=?").get(projectId) as {
            bytes: number;
        };
        return { artifacts: rows.map(artifactMetadata), storedBytes: total.bytes, maximumBytes: MAX_PROJECT_BYTES, maximumArtifacts: MAX_PROJECT_ARTIFACTS };
    });
}
export async function createWorkspaceArtifact(projectId: string, kind: WorkspaceKind, actor: WorkspaceActor, name: string, bytes: Buffer): Promise<WorkspaceArtifact> {
    if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES)
        throw new WorkspaceError(413, "Artifact must contain between 1 byte and 64 MiB", "ARTIFACT_SIZE");
    return await withTransaction(async () => {
        const { access } = await authorize(projectId, actor, true);
        const totals = await db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM project_workspace_artifacts WHERE project_id=?").get(projectId) as {
            count: number;
            bytes: number;
        };
        const reserved = await getReservedArtifactCapacity(projectId);
        if (totals.count + reserved.count >= MAX_PROJECT_ARTIFACTS || totals.bytes + reserved.bytes + bytes.length > MAX_PROJECT_BYTES) {
            throw new WorkspaceError(409, "Project artifact capacity reached. Delete unreferenced artifacts before uploading.", "ARTIFACT_CAPACITY");
        }
        const id = randomId();
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", vaultKey, iv);
        cipher.setAAD(artifactAad(access.ownerId, projectId, id));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        const tag = cipher.getAuthTag();
        const artifact: WorkspaceArtifact = { id, kind, name: safeName(name), mime: "application/octet-stream", size: bytes.length, sha256: sha256Hex(bytes), createdAt: now() };
        await db.prepare("INSERT INTO project_workspace_artifacts(id,project_id,kind,name,mime,size,sha256,iv,tag,ciphertext,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(id, projectId, kind, artifact.name, artifact.mime, artifact.size, artifact.sha256, iv, tag, ciphertext, actor.userId, artifact.createdAt);
        await tenantAudit(access, actor, "workspace.artifact.create", { artifactId: id, kind, size: artifact.size });
        return artifact;
    });
}
export async function readWorkspaceArtifact(projectId: string, artifactId: string, actor: WorkspaceActor): Promise<{
    artifact: WorkspaceArtifact;
    bytes: Buffer;
}> {
    return await withTransaction(async () => {
        const { access } = await authorize(projectId, actor);
        const row = await db.prepare("SELECT id,kind,name,mime,size,sha256,created_at,iv,tag,ciphertext FROM project_workspace_artifacts WHERE id=? AND project_id=?").get(artifactId, projectId) as unknown as StoredArtifact | undefined;
        if (!row)
            throw new WorkspaceError(404, "Artifact not found", "ARTIFACT_NOT_FOUND");
        if (row.size <= 0 || row.size > MAX_ARTIFACT_BYTES || row.ciphertext.byteLength !== row.size || row.iv.byteLength !== 12 || row.tag.byteLength !== 16) {
            throw new WorkspaceError(500, "Artifact storage is invalid", "STORAGE_ERROR");
        }
        const decrypt = (key: Buffer): Buffer => {
            const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv));
            decipher.setAAD(artifactAad(access.ownerId, projectId, artifactId));
            decipher.setAuthTag(Buffer.from(row.tag));
            return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
        };
        let bytes: Buffer;
        try {
            bytes = decrypt(vaultKey);
        }
        catch {
            if (!previousVaultKey)
                throw new WorkspaceError(500, "Artifact cannot be decrypted", "ARTIFACT_DECRYPTION");
            try {
                bytes = decrypt(previousVaultKey);
            }
            catch {
                throw new WorkspaceError(500, "Artifact cannot be decrypted", "ARTIFACT_DECRYPTION");
            }
        }
        if (bytes.length !== row.size || sha256Hex(bytes) !== row.sha256)
            throw new WorkspaceError(500, "Artifact integrity check failed", "ARTIFACT_INTEGRITY");
        return { artifact: artifactMetadata(row), bytes };
    });
}
export async function deleteWorkspaceArtifact(projectId: string, artifactId: string, actor: WorkspaceActor): Promise<void> {
    await withTransaction(async () => {
        const { access } = await authorize(projectId, actor, true);
        const artifact = await db.prepare("SELECT kind,size FROM project_workspace_artifacts WHERE id=? AND project_id=?").get(artifactId, projectId) as {
            kind: WorkspaceKind;
            size: number;
        } | undefined;
        if (!artifact)
            throw new WorkspaceError(404, "Artifact not found", "ARTIFACT_NOT_FOUND");
        const referenced = await db.prepare("SELECT 1 AS found FROM project_workspace_snapshots WHERE project_id=? AND payload_artifact_id=? UNION ALL SELECT 1 AS found FROM project_workspace_artifact_refs WHERE project_id=? AND artifact_id=? UNION ALL SELECT 1 AS found FROM project_native_jobs WHERE project_id=? AND input_artifact_id=? UNION ALL SELECT 1 AS found FROM project_native_job_artifacts WHERE project_id=? AND artifact_id=? UNION ALL SELECT 1 AS found FROM project_render_jobs WHERE project_id=? AND (source_image_artifact_id=? OR output_artifact_id=?) LIMIT 1")
            .get(projectId, artifactId, projectId, artifactId, projectId, artifactId, projectId, artifactId, projectId, artifactId, artifactId);
        if (referenced)
            throw new WorkspaceError(409, "Artifact is referenced by saved workspace history, a native job, or a render job", "ARTIFACT_REFERENCED");
        await db.prepare("DELETE FROM project_workspace_artifacts WHERE id=? AND project_id=?").run(artifactId, projectId);
        await tenantAudit(access, actor, "workspace.artifact.delete", { artifactId, kind: artifact.kind, size: artifact.size });
    });
}
