import { routeParam } from "../routeParams.js";
import { Router, type Request } from "express";
import { boundedUpload } from "../uploads.js";
import { logAudit } from "../audit.js";
import { deriveVaultKey, decryptAesGcm, encryptAesGcm, randomId, randomToken, sha256Hex } from "../crypto.js";
import { MASTER_KEY, PREVIOUS_MASTER_KEY } from "../config.js";
import { db, now, withTransaction } from "../db.js";
import { asyncHandler, AuthedRequest, resolveSession } from "../security.js";
import { z } from "zod";
import { emitProjectEvent } from "../collaboration.js";
import { conflictingDesignLock } from "../designLocks.js";
import { parseDesignInput } from "../designValidation.js";
import { canManageProject, canReadProject, canWriteProject, getProjectAccess } from "../projectAccess.js";
import { organizationAudit } from "../organization.js";

const router = Router();
const VAULT_KEY = deriveVaultKey(MASTER_KEY);
const PREVIOUS_VAULT_KEY = PREVIOUS_MASTER_KEY ? deriveVaultKey(PREVIOUS_MASTER_KEY) : null;
const PROJECT_AAD = "groundwork:project";
const FILE_AAD = "groundwork:file";

const uploadPhoto = boundedUpload("photo", { fileSize: 25 * 1024 * 1024, fields: 0, fieldSize: 0, parts: 1 });

router.use(asyncHandler(async (req: AuthedRequest, res, next) => {
  const session = (await resolveSession(req));
  if (!session || session.status !== "active") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.user = { id: session.user_id, email: "" };
  req.session = session;
  req.csrfToken = session.csrf_token;
  next();
}));

function encryptForUser(plaintext: string, userId: string): string {
  const payload = encryptAesGcm(plaintext, VAULT_KEY, `${PROJECT_AAD}:${userId}`);
  return JSON.stringify(payload);
}

function decryptForUser(payloadJson: string, userId: string): string {
  const payload = JSON.parse(payloadJson) as {
    iv: string;
    tag: string;
    data: string;
  };
  /* Projects created before encrypted design storage may contain plain JSON. */
  if (!payload.iv || !payload.tag || !payload.data) return payloadJson;
  try {
    return decryptAesGcm(payload, VAULT_KEY, `${PROJECT_AAD}:${userId}`);
  } catch (currentError) {
    if (!PREVIOUS_VAULT_KEY) throw currentError;
    return decryptAesGcm(payload, PREVIOUS_VAULT_KEY, `${PROJECT_AAD}:${userId}`);
  }
}

function sniffMime(buf: Buffer): string | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length > 4 && buf.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  return null;
}

export const PROJECT_TYPES = [
  "house",
  "residential",
  "villa-community",
  "townhouse",
  "commercial",
  "highway",
  "airport",
  "ports",
  "dams",
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

const projectTypeSchema = z.enum(PROJECT_TYPES);

const projectNameSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(80),
  projectType: projectTypeSchema.optional(),
});

const projectMetaSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  projectType: projectTypeSchema.optional(),
  widthMm: z.number().int().min(1000).max(30000).optional(),
  depthMm: z.number().int().min(1000).max(30000).optional(),
  folder: z.string().trim().max(80).optional(),
  archived: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
});

const designSchema = z.object({
  designData: z.string().min(2).max(4_000_000),
});
const baseRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);

const revisionSchema = z.object({ name: z.string().trim().min(1).max(80), designData: z.string().min(2).max(4_000_000).optional() });
const shareLinkSchema = z.object({ expiresInHours: z.number().int().min(1).max(24 * 30).default(24 * 7) });

async function projectForUser(projectId: string, userId: string) {
  const access = (await getProjectAccess(projectId, userId));
  if (!canReadProject(access)) return undefined;
  const row = (await db.prepare("SELECT id, user_id, name, project_type, design_data, width_mm, depth_mm, revision, photo_file_id, folder, archived, is_template, created_at, updated_at FROM projects WHERE id = ?")
    .get(projectId)) as {
      id: string; user_id: string; name: string; project_type: string; design_data: string | null; width_mm: number; depth_mm: number; revision: number;
      photo_file_id: string | null; folder: string; archived: number; is_template: number; created_at: number; updated_at: number;
    } | undefined;
  return row ? { ...row, ownerId: access.ownerId, role: access.role, organizationId: access.organizationId } : undefined;
}

function revisionResponse(row: { id: string; name: string; project_type: string; width_mm: number; depth_mm: number; created_at: number }) {
  return { id: row.id, name: row.name, projectType: row.project_type, widthMm: row.width_mm, depthMm: row.depth_mm, createdAt: row.created_at };
}

/** All creation paths share the advertised free-plan active-project allowance. */
async function canAddActiveProject(userId: string): Promise<boolean> {
  const user = (await db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").get(userId)) as { plan: string; plan_expires_at: number | null } | undefined;
  if (!user) return false;
  if (["pro", "studio"].includes(user.plan) && (user.plan_expires_at === null || user.plan_expires_at > now())) return true;
  const row = (await db.prepare("SELECT COUNT(*) AS count FROM projects WHERE user_id = ? AND organization_id IS NULL AND archived = 0").get(userId)) as { count: number };
  return Number(row.count) < 1;
}

const ACTIVE_PROJECT_LIMIT = "The Free plan allows one active owned project. Archive an existing project or upgrade before creating or restoring another.";

/* GET /api/projects */
router.get("/", asyncHandler(async (req: AuthedRequest, res) => {
  const rows = (await db.prepare(
    `SELECT p.id, p.name, p.project_type, p.width_mm, p.depth_mm, p.created_at, p.updated_at, p.photo_file_id, p.revision, p.folder, p.archived, p.is_template, 'owner' AS role
     FROM projects p WHERE p.user_id = ? AND p.organization_id IS NULL
     UNION ALL
     SELECT p.id, p.name, p.project_type, p.width_mm, p.depth_mm, p.created_at, p.updated_at, p.photo_file_id, p.revision, p.folder, p.archived, p.is_template, pm.role AS role
     FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? AND p.organization_id IS NULL
     UNION ALL
     SELECT p.id, p.name, p.project_type, p.width_mm, p.depth_mm, p.created_at, p.updated_at, p.photo_file_id, p.revision, p.folder, p.archived, p.is_template,
       CASE WHEN om.role IN ('owner','admin') THEN 'owner' ELSE om.role END AS role
     FROM organization_members om JOIN projects p ON p.organization_id=om.organization_id WHERE om.user_id=?
     ORDER BY updated_at DESC`,
  ).all(req.user!.id, req.user!.id, req.user!.id)) as {
    id: string; name: string; project_type: string; width_mm: number; depth_mm: number; created_at: number; updated_at: number;
    photo_file_id: string | null; revision: number; folder: string; archived: number; is_template: number; role: "owner" | "editor" | "viewer";
  }[];
  res.json({
    projects: rows.map((p) => ({
      id: p.id, name: p.name, projectType: p.project_type, widthMm: p.width_mm, depthMm: p.depth_mm,
      createdAt: p.created_at, updatedAt: p.updated_at, hasPhoto: Boolean(p.photo_file_id), revision: p.revision, role: p.role,
      folder: p.folder, archived: Boolean(p.archived), isTemplate: Boolean(p.is_template),
    })),
  });
}));

/* POST /api/projects */
router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = projectNameSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
      return;
    }
    const id = randomId();
    const t = now();
    const created = (await withTransaction(async () => {
      if (!(await canAddActiveProject(req.user!.id))) return false;
      (await db.prepare(
        `INSERT INTO projects (id, user_id, name, project_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, req.user!.id, parsed.data.name, parsed.data.projectType || "house", t, t));
      return true;
    }));
    if (!created) { res.status(403).json({ error: ACTIVE_PROJECT_LIMIT, code: "ACTIVE_PROJECT_LIMIT" }); return; }
    (await logAudit(req.user!.id, "project.created", { name: parsed.data.name, projectType: parsed.data.projectType || "house" }, req));
    res.status(201).json({
      id,
      name: parsed.data.name,
      projectType: parsed.data.projectType || "house",
      widthMm: 6000,
      depthMm: 4000,
      createdAt: t,
      updatedAt: t,
      revision: 0,
      role: "owner", folder: "", archived: false, isTemplate: false,
    });
  }),
);

/* GET /api/projects/:id */
router.get("/:id", asyncHandler(async (req: AuthedRequest, res) => {
  const expectedAccountId = req.get("X-Groundwork-Account");
  if (expectedAccountId !== undefined && expectedAccountId !== req.user!.id) {
    res.status(409).json({ error: "The signed-in account changed. Refresh your session before opening this project.", code: "ACCOUNT_CHANGED" });
    return;
  }
  const row = (await projectForUser(routeParam(req, "id"), req.user!.id));
  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  let design: unknown = null;
  if (row.design_data) {
    try {
      design = JSON.parse(decryptForUser(row.design_data, row.ownerId));
    } catch (error) {
      console.error(`[groundwork] Could not open project ${row.id}:`, error);
      res.status(422).json({ error: "This project cannot be opened because its stored design data is unreadable. Contact support." });
      return;
    }
  }
  res.json({
    accountId: req.user!.id,
    id: row.id,
    name: row.name,
    projectType: row.project_type,
    design,
    widthMm: row.width_mm,
    depthMm: row.depth_mm,
    hasPhoto: Boolean(row.photo_file_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    role: row.role,
    folder: row.folder, archived: Boolean(row.archived), isTemplate: Boolean(row.is_template),
  });
}));

/* POST /api/projects/:id/duplicate — read access is required even for templates. */
router.post("/:id/duplicate", asyncHandler(async (req: AuthedRequest, res) => {
  const sourceId = routeParam(req, "id");
  const userId = req.user!.id;
  const duplicate = await withTransaction(async () => {
    // Membership and project-scope updates share this transaction boundary.
    const source = await projectForUser(sourceId, userId);
    if (!source) return { status: 404, body: { error: "Project not found" } } as const;
    if (source.organizationId) {
      return { status: 403, body: { error: "Tenant projects cannot be duplicated into a personal workspace" } } as const;
    }
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body || {});
    if (!parsed.success) return { status: 400, body: { error: "A project name of 1–80 characters is required" } } as const;
    if (!(await canAddActiveProject(userId))) return { status: 403, body: { error: ACTIVE_PROJECT_LIMIT, code: "ACTIVE_PROJECT_LIMIT" } } as const;
    let designData: string | null = null;
    try {
      if (source.design_data) {
        const plaintext = decryptForUser(source.design_data, source.ownerId);
        if (plaintext.length > 4_000_000) throw new Error("Design exceeds the project size limit");
        JSON.parse(plaintext);
        designData = encryptForUser(plaintext, userId);
      }
    } catch {
      return { status: 422, body: { error: "The source design cannot be copied because its stored data is unreadable or too large" } } as const;
    }
    const id = randomId();
    const t = now();
    const name = parsed.data.name;
    await db.prepare("INSERT INTO projects (id, user_id, name, project_type, design_data, width_mm, depth_mm, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, name, source.project_type, designData, source.width_mm, source.depth_mm, t, t);
    return {
      status: 201, fromTemplate: Boolean(source.is_template),
      body: { id, name, projectType: source.project_type, widthMm: source.width_mm, depthMm: source.depth_mm,
        createdAt: t, updatedAt: t, hasPhoto: false, revision: 0, role: "owner", folder: "", archived: false, isTemplate: false },
    } as const;
  });
  if (duplicate.status !== 201) { res.status(duplicate.status).json(duplicate.body); return; }
  // Photos, team permissions, share links, history, locks and operations stay with the source.
  await logAudit(userId, "project.duplicated", { projectId: duplicate.body.id, sourceProjectId: sourceId, name: duplicate.body.name, fromTemplate: duplicate.fromTemplate }, req);
  res.status(201).json(duplicate.body);
}));

/* PATCH /api/projects/:id — name, dims, or encrypted design data */
router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    // Offline bodies retain their initiating account even if the browser's
    // shared session cookie changes while a request is in flight.
    const expectedAccountId = (req.body as Record<string, unknown> | undefined)?.expectedAccountId;
    if (expectedAccountId !== undefined && expectedAccountId !== req.user!.id) {
      res.status(409).json({ error: "This queued change belongs to a different signed-in account", code: "ACCOUNT_CHANGED" });
      return;
    }
    const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
    if (!access || !(await canWriteProject(access))) {
      res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" });
      return;
    }
    const row = (await db.prepare("SELECT id, name, revision, archived FROM projects WHERE id = ?").get(routeParam(req, "id"))) as { id: string; name: string; revision: number; archived: number };

    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = (req.body as Record<string, unknown>) || {};
    } catch {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const hasDesign = Object.prototype.hasOwnProperty.call(parsedBody, "designData");
    const expectedRevision = typeof parsedBody.baseRevision === "number" ? parsedBody.baseRevision : null;
    const meta = projectMetaSchema.partial().safeParse(parsedBody);
    if (!meta.success) {
      res.status(400).json({ error: meta.error.issues[0]?.message || "Invalid project metadata" });
      return;
    }
    const hasLibraryMetadata = meta.data.folder !== undefined || meta.data.archived !== undefined || meta.data.isTemplate !== undefined;
    if (hasLibraryMetadata && !canManageProject(access)) {
      res.status(403).json({ error: "Owner access required to organize, archive or designate templates" });
      return;
    }

    let designPayload: string | null = null;
    let nextDesign: unknown;
    if (hasDesign) {
      const parsed = designSchema.safeParse(parsedBody);
      if (!parsed.success) {
        res.status(400).json({ error: "Design data is invalid" });
        return;
      }
      nextDesign = parseDesignInput(parsed.data.designData);
      designPayload = encryptForUser(parsed.data.designData, access.ownerId);
    }
    if ((hasDesign || parsedBody.baseRevision !== undefined) && !baseRevisionSchema.safeParse(parsedBody.baseRevision).success) {
      res.status(400).json({ error: "A valid baseRevision is required for design changes", code: "BASE_REVISION_REQUIRED" });
      return;
    }

    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (meta.data.name !== undefined) {
      fields.push("name = ?");
      values.push(meta.data.name);
    }
    if (meta.data.projectType !== undefined) {
      fields.push("project_type = ?");
      values.push(meta.data.projectType);
    }
    if (meta.data.widthMm !== undefined) {
      fields.push("width_mm = ?");
      values.push(meta.data.widthMm);
    }
    if (meta.data.depthMm !== undefined) {
      fields.push("depth_mm = ?");
      values.push(meta.data.depthMm);
    }
    if (meta.data.folder !== undefined) {
      fields.push("folder = ?"); values.push(meta.data.folder);
    }
    if (meta.data.archived !== undefined) {
      fields.push("archived = ?"); values.push(Number(meta.data.archived));
    }
    if (meta.data.isTemplate !== undefined) {
      fields.push("is_template = ?"); values.push(Number(meta.data.isTemplate));
    }
    if (designPayload !== null) {
      fields.push("design_data = ?");
      values.push(designPayload);
    }
    if (fields.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    fields.push("updated_at = ?");
    values.push(now());
    values.push(routeParam(req, "id"));

    fields.push("revision = revision + 1");
    const result = await withTransaction(async () => {
      const currentAccess = await getProjectAccess(routeParam(req, "id"), req.user!.id);
      if (!currentAccess || !await canWriteProject(currentAccess)) return { status: currentAccess ? 403 : 404, error: currentAccess ? "Editor access required" : "Project not found" };
      if (hasLibraryMetadata && !canManageProject(currentAccess)) return { status: 403, error: "Owner access required to organize, archive or designate templates" };
      const stored = await db.prepare("SELECT archived,revision,design_data FROM projects WHERE id = ?").get(routeParam(req, "id")) as { archived: number; revision: number; design_data: string | null };
      if (expectedRevision !== null && stored.revision !== expectedRevision) return { status: 409, error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: stored.revision };
      if (!Number.isSafeInteger(stored.revision) || stored.revision >= Number.MAX_SAFE_INTEGER) return { status: 409, error: "Project revision capacity reached", code: "REVISION_CAPACITY", currentRevision: stored.revision };
      if (stored.archived && meta.data.archived === false && !currentAccess.organizationId && !await canAddActiveProject(currentAccess.ownerId)) {
        return { status: 403, error: ACTIVE_PROJECT_LIMIT, code: "ACTIVE_PROJECT_LIMIT" };
      }
      if (designPayload !== null) {
        const before: unknown = stored.design_data ? JSON.parse(decryptForUser(stored.design_data, access.ownerId)) : null;
        const lockedObject = await conflictingDesignLock(routeParam(req, "id"), req.user!.id, before, nextDesign);
        if (lockedObject) return { status: 423, error: "Object is locked by another editor", objectId: lockedObject };
      }
      const updated = await db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? AND revision = ?`).run(...values, stored.revision);
      if (!updated.changes) {
        const latest = await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "id")) as { revision: number };
        return { status: 409, error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: latest.revision };
      }
      const revision = stored.revision + 1;
      await emitProjectEvent(routeParam(req, "id"), req.user!.id, designPayload !== null ? "design.updated" : "snapshot.created", revision, { designChanged: designPayload !== null });
      return { status: 200, revision };
    });
    if (result.status !== 200) {
      const { status, ...body } = result;
      res.status(status).json(body);
      return;
    }

    if (designPayload !== null) {
      (await logAudit(req.user!.id, "project.updated", { name: row.name }, req));
    }
    if (hasLibraryMetadata) {
      (await logAudit(req.user!.id, "project.library_updated", { projectId: routeParam(req, "id"), folder: meta.data.folder, archived: meta.data.archived, isTemplate: meta.data.isTemplate }, req));
    }
    const revision = result.revision!;
    if (access.organizationId) (await organizationAudit(access.organizationId, req.user!.id, "project.updated", { projectId: routeParam(req, "id"), revision, designChanged: designPayload !== null }));
    res.json({ ok: true, revision });
  }),
);

/* GET /api/projects/:id/revisions */
router.get("/:id/revisions", asyncHandler(async (req: AuthedRequest, res) => {
  if (!(await projectForUser(routeParam(req, "id"), req.user!.id))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const rows = (await db.prepare(
    "SELECT id, name, project_type, width_mm, depth_mm, created_at FROM project_revisions WHERE project_id = ? ORDER BY created_at DESC",
  ).all(routeParam(req, "id"))) as { id: string; name: string; project_type: string; width_mm: number; depth_mm: number; created_at: number }[];
  res.json({ revisions: rows.map(revisionResponse) });
}));

/* POST /api/projects/:id/revisions — a named, encrypted snapshot of the current project */
router.post("/:id/revisions", asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = revisionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid snapshot name" });
    return;
  }
  const project = (await projectForUser(routeParam(req, "id"), req.user!.id));
  const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
  if (!project || !(await canWriteProject(access))) {
    res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" });
    return;
  }
  const revision = {
    id: randomId(), name: parsed.data.name, project_type: project.project_type,
    width_mm: project.width_mm, depth_mm: project.depth_mm, created_at: now(),
  };
  if (parsed.data.designData) parseDesignInput(parsed.data.designData);
  const snapshotData = parsed.data.designData
    ? encryptForUser(parsed.data.designData, project.ownerId)
    : encryptForUser(
        project.design_data ? decryptForUser(project.design_data, project.ownerId) : "null",
        project.ownerId,
      );
  (await db.prepare(
    "INSERT INTO project_revisions (id, project_id, user_id, name, design_data, project_type, width_mm, depth_mm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(revision.id, project.id, req.user!.id, revision.name, snapshotData, revision.project_type, revision.width_mm, revision.depth_mm, revision.created_at));
  (await emitProjectEvent(project.id, req.user!.id, "snapshot.created", project.revision, { revisionId: revision.id, name: revision.name }));
  (await logAudit(req.user!.id, "project.revision_created", { projectId: project.id, name: revision.name }, req));
  res.status(201).json(revisionResponse(revision));
}));

/* POST /api/projects/:id/revisions/:revisionId/restore */
router.post("/:id/revisions/:revisionId/restore", asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = z.object({ baseRevision: baseRevisionSchema }).safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: "A valid baseRevision is required to restore a snapshot", code: "BASE_REVISION_REQUIRED" });
    return;
  }
  const outcome = await withTransaction(async () => {
    const project = await projectForUser(routeParam(req, "id"), req.user!.id);
    const access = await getProjectAccess(routeParam(req, "id"), req.user!.id);
    if (!access || !await canWriteProject(access)) return { status: access ? 403 : 404, body: { error: access ? "Editor access required" : "Project or snapshot not found" } };
    const revision = await db.prepare("SELECT * FROM project_revisions WHERE id = ? AND project_id = ?").get(routeParam(req, "revisionId"), routeParam(req, "id")) as {
      id: string; name: string; design_data: string; project_type: string; width_mm: number; depth_mm: number;
    } | undefined;
    if (!project || !revision) return { status: 404, body: { error: "Project or snapshot not found" } };
    if (project.revision !== parsed.data.baseRevision) return { status: 409, body: { error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: project.revision } };
    const before = project.design_data ? JSON.parse(decryptForUser(project.design_data, project.ownerId)) : null;
    const restored = parseDesignInput(decryptForUser(revision.design_data, project.ownerId));
    const lockedObject = await conflictingDesignLock(project.id, req.user!.id, before, restored);
    if (lockedObject) return { status: 423, body: { error: "Object is locked by another editor", objectId: lockedObject } };
    // Reseal a restored snapshot using the current configured key as well.
    const updated = await db.prepare("UPDATE projects SET design_data = ?, project_type = ?, width_mm = ?, depth_mm = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(encryptForUser(JSON.stringify(restored), project.ownerId), revision.project_type, revision.width_mm, revision.depth_mm, now(), project.id, parsed.data.baseRevision);
    if (!updated.changes) {
      const latest = await db.prepare("SELECT revision FROM projects WHERE id = ?").get(project.id) as { revision: number };
      return { status: 409, body: { error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: latest.revision } };
    }
    const nextRevision = project.revision + 1;
    await emitProjectEvent(project.id, req.user!.id, "design.updated", nextRevision, { restoredRevisionId: revision.id });
    await logAudit(req.user!.id, "project.revision_restored", { projectId: project.id, revisionId: revision.id }, req);
    return { status: 200, body: { ok: true, revision: nextRevision, name: revision.name, projectType: revision.project_type, widthMm: revision.width_mm, depthMm: revision.depth_mm, design: restored } };
  });
  res.status(outcome.status).json(outcome.body);
}));

/* GET /api/projects/:id/share-links */
router.get("/:id/share-links", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
  if (!canManageProject(access)) {
    res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" });
    return;
  }
  const rows = (await db.prepare("SELECT id, expires_at, revoked_at, created_at FROM project_share_links WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC")
    .all(routeParam(req, "id"), access.ownerId)) as { id: string; expires_at: number; revoked_at: number | null; created_at: number }[];
  res.json({ links: rows.map((row) => ({ id: row.id, expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at, active: !row.revoked_at && row.expires_at > now() })) });
}));

/* POST /api/projects/:id/share-links */
router.post("/:id/share-links", asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = shareLinkSchema.safeParse(req.body || {});
  const project = (await projectForUser(routeParam(req, "id"), req.user!.id));
  const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
  if (!parsed.success) {
    res.status(400).json({ error: "Expiry must be between 1 hour and 30 days" });
    return;
  }
  if (!project || !canManageProject(access)) {
    res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" });
    return;
  }
  if (access.organizationId) { res.status(403).json({ error: "Public share links are disabled for organization projects" }); return; }
  const token = randomToken(32);
  const id = randomId();
  const createdAt = now();
  const expiresAt = createdAt + parsed.data.expiresInHours * 3600;
  (await db.prepare("INSERT INTO project_share_links (id, project_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, project.id, access.ownerId, sha256Hex(token), expiresAt, createdAt));
  (await logAudit(req.user!.id, "project.share_link_created", { projectId: project.id, expiresAt }, req));
  res.status(201).json({ id, token, expiresAt, url: `/share/${token}` });
}));

/* DELETE /api/projects/:id/share-links/:linkId */
router.delete("/:id/share-links/:linkId", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
  if (!canManageProject(access)) { res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" }); return; }
  const result = (await db.prepare("UPDATE project_share_links SET revoked_at = ? WHERE id = ? AND project_id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(now(), routeParam(req, "linkId"), routeParam(req, "id"), access.ownerId));
  if (!result.changes) {
    res.status(404).json({ error: "Share link not found" });
    return;
  }
  (await logAudit(req.user!.id, "project.share_link_revoked", { projectId: routeParam(req, "id"), linkId: routeParam(req, "linkId") }, req));
  res.json({ ok: true });
}));

/* POST /api/projects/:id/photo */
router.post(
  "/:id/photo",
  asyncHandler(async (req: AuthedRequest, res, next) => {
    const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
    if (!access || !(await canWriteProject(access))) {
      res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" }); return;
    }
    next();
  }),
  uploadPhoto,
  asyncHandler(async (req: AuthedRequest, res) => {
    const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
    if (!access || !(await canWriteProject(access))) {
      res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No photo uploaded" });
      return;
    }
    const mime = sniffMime(req.file.buffer);
    if (!mime) {
      res.status(415).json({ error: "Unsupported file type. Use PNG, JPEG, WebP or GIF." });
      return;
    }

    const payload = encryptAesGcm(
      req.file.buffer.toString("base64"),
      VAULT_KEY,
      `${FILE_AAD}:${access.ownerId}`,
    );
    const fileId = randomId();
    (await db.prepare(
      "INSERT INTO files (id, user_id, mime, iv, tag, ciphertext, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(fileId, access.ownerId, mime, payload.iv, payload.tag, payload.data, req.file.size, now()));

    const oldFile = (
      (await db.prepare("SELECT photo_file_id FROM projects WHERE id = ?").get(
        routeParam(req, "id"),
      )) as { photo_file_id: string | null }
    ).photo_file_id;

    (await db.prepare("UPDATE projects SET photo_file_id = ?, updated_at = ? WHERE id = ?").run(
      fileId,
      now(),
      routeParam(req, "id"),
    ));

    if (oldFile) {
      (await db.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").run(oldFile, access.ownerId));
    }
    (await logAudit(req.user!.id, "project.photo_uploaded", { mime, size: req.file.size }, req));
    res.json({ ok: true, fileId });
  }),
);

/* GET /api/projects/:id/photo */
router.get("/:id/photo", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
  if (!canReadProject(access)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const row = (await db.prepare("SELECT photo_file_id FROM projects WHERE id = ?").get(routeParam(req, "id"))) as { photo_file_id: string | null } | undefined;
  if (!row?.photo_file_id) {
    res.status(404).json({ error: "No photo" });
    return;
  }
  const file = (await db.prepare("SELECT mime, iv, tag, ciphertext FROM files WHERE id = ? AND user_id = ?")
    .get(row.photo_file_id, access.ownerId)) as { mime: string; iv: string; tag: string; ciphertext: string } | undefined;
  if (!file) {
    res.status(404).json({ error: "No photo" });
    return;
  }
  const base64 = decryptAesGcm({ iv: file.iv, tag: file.tag, data: file.ciphertext }, VAULT_KEY, `${FILE_AAD}:${access.ownerId}`);
  res.set("Content-Type", file.mime);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(base64, "base64"));
}));

/* POST /api/projects/:id/export — records an export event (Downloaded client-side) */
router.post(
  "/:id/export",
  asyncHandler(async (req: AuthedRequest, res) => {
    const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
    if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
    const row = (await db.prepare("SELECT name FROM projects WHERE id = ?").get(routeParam(req, "id"))) as { name: string };
    const format =
      typeof req.body?.format === "string" && /^[a-z0-9-]{1,20}$/i.test(req.body.format)
        ? String(req.body.format).toUpperCase()
        : "UNKNOWN";
    (await logAudit(req.user!.id, "project.exported", { name: row.name, format }, req));
    res.json({ ok: true });
  }),
);

/* DELETE /api/projects/:id */
router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const access = (await getProjectAccess(routeParam(req, "id"), req.user!.id));
    if (!canManageProject(access)) {
      res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" });
      return;
    }
    const row = (await db.prepare("SELECT id, name, photo_file_id FROM projects WHERE id = ?").get(routeParam(req, "id"))) as { id: string; name: string; photo_file_id: string | null };
    if (row.photo_file_id) {
      (await db.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").run(row.photo_file_id, access.ownerId));
    }
    (await db.prepare("DELETE FROM projects WHERE id = ?").run(routeParam(req, "id")));
    if (access.organizationId) (await organizationAudit(access.organizationId, req.user!.id, "project.deleted", { projectId: routeParam(req, "id"), name: row.name }));
    (await logAudit(req.user!.id, "project.deleted", { name: row.name }, req));
    res.json({ ok: true });
  }),
);

// Kept for reference: request typing helper
export type { Request };
export default router;
