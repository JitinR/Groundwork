import { routeParam } from "../routeParams.js";
import { Router } from "express";
import { z } from "zod";
import { MASTER_KEY, PREVIOUS_MASTER_KEY, SERVERLESS } from "../config.js";
import { decryptAesGcm, deriveVaultKey, encryptAesGcm, randomId } from "../crypto.js";
import { db, now, withTransaction } from "../db.js";
import { asyncHandler, AuthedRequest, resolveSession } from "../security.js";
import { canManageProject, canReadProject, canWriteProject, getProjectAccess, readableProjectUsers } from "../projectAccess.js";
import { writeSse } from "../sse.js";
import { collaborationInstanceId, collaborationItemId, emitProjectEvent, presenceSnapshot, replayProjectEvents, subscribeProject, reserveProjectSubscription, releaseProjectSubscription, CollaborationSubscriptionError } from "../collaboration.js";
import { conflictingDesignLock } from "../designLocks.js";
import { validateDesignComplexity, MAX_DESIGN_BYTES } from "../designValidation.js";
import syncRouter from "./sync.js";
import { readRedisProjectEvents, redisPresence, redisTransportConfigured } from "../redisTransport.js";
import { serverlessStreamDeadline } from "../serverlessRuntime.js";
import { waitUntil } from "@vercel/functions";

const router = Router();
const vaultKey = deriveVaultKey(MASTER_KEY);
const previousVaultKey = PREVIOUS_MASTER_KEY ? deriveVaultKey(PREVIOUS_MASTER_KEY) : null;

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
router.use("/:projectId/sync", syncRouter);

function encryptProjectText(plaintext: string, ownerId: string): string {
  return JSON.stringify(encryptAesGcm(plaintext, vaultKey, `groundwork:project:${ownerId}`));
}

function decryptProjectText(payloadJson: string, ownerId: string): string {
  const payload = JSON.parse(payloadJson) as { iv?: string; tag?: string; data?: string };
  if (!payload.iv || !payload.tag || !payload.data) return payloadJson;
  try {
    return decryptAesGcm(payload as { iv: string; tag: string; data: string }, vaultKey, `groundwork:project:${ownerId}`);
  } catch (error) {
    if (!previousVaultKey) throw error;
    return decryptAesGcm(payload as { iv: string; tag: string; data: string }, previousVaultKey, `groundwork:project:${ownerId}`);
  }
}

function encryptItemBody(body: string, ownerId: string, projectId: string): string {
  return JSON.stringify(encryptAesGcm(body, vaultKey, `groundwork:collaboration:${ownerId}:${projectId}`));
}

function decryptItemBody(payloadJson: string, ownerId: string, projectId: string): string {
  try {
    const payload = JSON.parse(payloadJson) as { iv?: string; tag?: string; data?: string; body?: string };
    if (typeof payload.body === "string") return payload.body;
    if (!payload.iv || !payload.tag || !payload.data) return payloadJson;
    try {
      return decryptAesGcm(payload as { iv: string; tag: string; data: string }, vaultKey, `groundwork:collaboration:${ownerId}:${projectId}`);
    } catch (error) {
      if (!previousVaultKey) throw error;
      return decryptAesGcm(payload as { iv: string; tag: string; data: string }, previousVaultKey, `groundwork:collaboration:${ownerId}:${projectId}`);
    }
  } catch {
    return payloadJson;
  }
}

router.get("/:projectId/events", asyncHandler(async (req: AuthedRequest, res) => {
  const projectId = routeParam(req, "projectId");
  const userId = req.user!.id;
  const access = await getProjectAccess(projectId, userId);
  if (!canReadProject(access)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  let reservation: Awaited<ReturnType<typeof reserveProjectSubscription>>;
  try { reservation = await reserveProjectSubscription(projectId, userId); }
  catch (error) {
    if (error instanceof CollaborationSubscriptionError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
  let unsubscribe: () => Promise<void> = () => releaseProjectSubscription(reservation);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let replay: ReturnType<typeof setInterval> | undefined;
  let stopDeadline = () => {};
  let cleaned = false;
  let cleanupFinished!: () => void;
  const cleanupCompletion = new Promise<void>((resolve) => { cleanupFinished = resolve; });
  // Register while the invocation is active: cancellation may suspend all work
  // except waitUntil promises. Lease deletion must still finish after close.
  if (SERVERLESS) waitUntil(cleanupCompletion);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    if (replay) clearInterval(replay);
    stopDeadline();
    void Promise.resolve().then(() => unsubscribe()).catch(() => {
      console.error(JSON.stringify({ type: "collaboration.cleanup_failed" }));
    }).finally(cleanupFinished);
  };
  res.once("close", cleanup);
  res.once("finish", cleanup);
  const requestedId = Number(req.get("Last-Event-ID") || req.query.after || 0);
  let lastEventId = Number.isSafeInteger(requestedId) && requestedId >= 0 ? requestedId : 0;
  let redisCursor = "0";
  let polling = false;
  const canReceive = async () => {
    const session = await resolveSession(req);
    return session?.status === "active" && session.user_id === userId && canReadProject(await getProjectAccess(projectId, userId));
  };
  // Database polling delivers events produced by other workers. A slow database
  // must not accumulate concurrent polls or leave rejected promises unhandled.
  const replayOnce = async (readDistributed: boolean) => {
    if (polling || res.writableEnded || res.destroyed) return;
    polling = true;
    try {
      lastEventId = await replayProjectEvents(projectId, res, lastEventId, canReceive);
      if (readDistributed && redisTransportConfigured && !res.writableEnded && !res.destroyed) {
        let result: Awaited<ReturnType<typeof readRedisProjectEvents>>;
        try { result = await readRedisProjectEvents(projectId, redisCursor); }
        catch {
          if (await canReceive()) writeSse(res, "transport-status", { backend: "redis-rest", degraded: true });
          else res.end();
          return;
        }
        if (!await canReceive()) { res.end(); return; }
        redisCursor = result.cursor;
        for (const event of result.events) {
          const parsed = z.object({ origin: z.string().max(120), eventId: z.string().max(120), projectId: z.string(), type: z.string().max(80), revision: z.number().int().min(0), createdAt: z.number().int(), actorId: z.string().max(120) }).safeParse(event);
          if (parsed.success && parsed.data.origin !== collaborationInstanceId && parsed.data.projectId === projectId && !writeSse(res, "distributed", parsed.data)) break;
        }
      }
    } finally {
      polling = false;
    }
  };
  try {
    if (res.destroyed || res.writableEnded) { cleanup(); return; }
    if (!await canReceive()) { res.status(404).json({ error: "Project not found" }); return; }
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    if (!writeSse(res, "ready", { projectId, role: access.role })) { cleanup(); return; }
    unsubscribe = await subscribeProject(projectId, userId, {
      response: res, canReceive, wake: () => { void replayOnce(false).catch(() => res.end()); },
    }, reservation);
    if (cleaned || res.destroyed || res.writableEnded) { await unsubscribe(); cleanup(); return; }
    await replayOnce(false);
    if (cleaned || res.destroyed || res.writableEnded) { cleanup(); return; }
    heartbeat = setInterval(() => { writeSse(res, "heartbeat"); }, 20_000);
    replay = setInterval(() => { void replayOnce(true).catch(() => { res.end(); }); }, 2000);
    heartbeat.unref?.(); replay.unref?.();
    stopDeadline = SERVERLESS ? serverlessStreamDeadline(res) : () => {};
    if (res.destroyed || res.writableEnded) cleanup();
  } catch (error) {
    cleanup();
    if (res.headersSent) { res.end(); return; }
    throw error;
  }
}));

router.get("/:projectId/presence", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
  if (redisTransportConfigured) {
    const presence = await redisPresence(routeParam(req, "projectId"));
    if ((await resolveSession(req))?.status !== "active" || !canReadProject((await getProjectAccess(routeParam(req, "projectId"), req.user!.id)))) { res.status(403).json({ error: "Project access changed during presence lookup" }); return; }
    const users: typeof presence.users = [];
    const readable = await readableProjectUsers(routeParam(req, "projectId"), presence.users.map((entry) => entry.userId));
    for (const entry of presence.users) {
      if (readable.has(entry.userId)) users.push(entry);
    }
    res.json({ projectId: routeParam(req, "projectId"), users, count: users.length, backend: "redis-rest" });
  } else res.json({ ...(await presenceSnapshot(routeParam(req, "projectId"))), backend: "sqlite" });
}));

router.get("/:projectId/items", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
  const rows = (await db.prepare("SELECT id, user_id, kind, body, status, created_at, updated_at FROM project_collaboration_items WHERE project_id = ? ORDER BY created_at DESC")
    .all(routeParam(req, "projectId"))) as { id: string; user_id: string; kind: string; body: string; status: string; created_at: number; updated_at: number }[];
  res.json({ items: rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    body: decryptItemBody(row.body, access.ownerId, routeParam(req, "projectId")),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) });
}));

const itemSchema = z.object({ kind: z.enum(["comment", "issue"]), body: z.string().trim().min(1).max(2000) });
router.post("/:projectId/items", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  const parsed = itemSchema.safeParse(req.body || {});
  if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid collaboration item" }); return; }
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  const id = collaborationItemId();
  const timestamp = now();
  (await db.prepare("INSERT INTO project_collaboration_items (id, project_id, user_id, kind, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, routeParam(req, "projectId"), req.user!.id, parsed.data.kind, encryptItemBody(parsed.data.body, access.ownerId, routeParam(req, "projectId")), timestamp, timestamp));
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, parsed.data.kind === "comment" ? "comment.created" : "issue.updated", project.revision, { itemId: id }));
  res.status(201).json({ id, userId: req.user!.id, kind: parsed.data.kind, body: parsed.data.body, status: "open", createdAt: timestamp, updatedAt: timestamp });
}));

router.patch("/:projectId/items/:itemId", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  const parsed = z.object({ status: z.enum(["open", "resolved"]) }).safeParse(req.body || {});
  if (!access || !(await canWriteProject(access))) { res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" }); return; }
  if (!parsed.success) { res.status(400).json({ error: "Status must be open or resolved" }); return; }
  const timestamp = now();
  const result = (await db.prepare("UPDATE project_collaboration_items SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?")
    .run(parsed.data.status, timestamp, routeParam(req, "itemId"), routeParam(req, "projectId")));
  if (!result.changes) { res.status(404).json({ error: "Collaboration item not found" }); return; }
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "issue.updated", project.revision, { itemId: routeParam(req, "itemId"), status: parsed.data.status }));
  res.json({ ok: true, status: parsed.data.status, updatedAt: timestamp });
}));

/* -------------------------- Project memberships -------------------------- */

router.get("/:projectId/members", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
  if (access.organizationId) {
    const members = (await db.prepare(`SELECT m.user_id AS userId,u.email,u.username,CASE WHEN m.role IN ('owner','admin') THEN 'owner' ELSE m.role END AS role,m.created_at AS createdAt
      FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY m.created_at`).all(access.organizationId));
    res.json({ members, currentRole: access.role, managedByOrganization: true }); return;
  }
  const owner = (await db.prepare("SELECT u.id, u.email, u.username FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = ?")
    .get(routeParam(req, "projectId"))) as { id: string; email: string; username: string | null };
  const rows = (await db.prepare("SELECT pm.user_id, pm.role, pm.created_at, u.email, u.username FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.created_at")
    .all(routeParam(req, "projectId"))) as { user_id: string; role: "editor" | "viewer"; created_at: number; email: string; username: string | null }[];
  res.json({ members: [
    { userId: owner.id, email: owner.email, username: owner.username, role: "owner", createdAt: 0 },
    ...rows.map((row) => ({ userId: row.user_id, email: row.email, username: row.username, role: row.role, createdAt: row.created_at })),
  ], currentRole: access.role });
}));

const memberSchema = z.object({ identifier: z.string().trim().min(3).max(254), role: z.enum(["editor", "viewer"]) });
router.post("/:projectId/members", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  const parsed = memberSchema.safeParse(req.body || {});
  if (!canManageProject(access)) { res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" }); return; }
  if (access.organizationId) { res.status(403).json({ error: "Manage membership in the organization workspace" }); return; }
  if (!parsed.success) { res.status(400).json({ error: "Enter a valid user and role" }); return; }
  const target = (await db.prepare("SELECT id, email, username FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1")
    .get(parsed.data.identifier, parsed.data.identifier)) as { id: string; email: string; username: string | null } | undefined;
  if (!target || target.id === access.ownerId) { res.status(404).json({ error: "Eligible Groundwork user not found" }); return; }
  (await db.prepare(`INSERT INTO project_members (project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`)
    .run(routeParam(req, "projectId"), target.id, parsed.data.role, req.user!.id, now()));
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "member.updated", project.revision, { userId: target.id, role: parsed.data.role }));
  res.status(201).json({ userId: target.id, email: target.email, username: target.username, role: parsed.data.role });
}));

router.patch("/:projectId/members/:userId", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  const parsed = z.object({ role: z.enum(["editor", "viewer"]) }).safeParse(req.body || {});
  if (!canManageProject(access)) { res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" }); return; }
  if (access.organizationId) { res.status(403).json({ error: "Manage membership in the organization workspace" }); return; }
  if (!parsed.success) { res.status(400).json({ error: "Role must be editor or viewer" }); return; }
  const result = (await db.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?")
    .run(parsed.data.role, routeParam(req, "projectId"), routeParam(req, "userId")));
  if (!result.changes) { res.status(404).json({ error: "Project member not found" }); return; }
  if (parsed.data.role === "viewer") (await db.prepare("DELETE FROM project_locks WHERE project_id = ? AND user_id = ?").run(routeParam(req, "projectId"), routeParam(req, "userId")));
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "member.updated", project.revision, { userId: routeParam(req, "userId"), role: parsed.data.role }));
  res.json({ ok: true });
}));

router.delete("/:projectId/members/:userId", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!canManageProject(access)) { res.status(access ? 403 : 404).json({ error: access ? "Owner access required" : "Project not found" }); return; }
  if (access.organizationId) { res.status(403).json({ error: "Manage membership in the organization workspace" }); return; }
  const result = (await db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(routeParam(req, "projectId"), routeParam(req, "userId")));
  (await db.prepare("DELETE FROM project_locks WHERE project_id = ? AND user_id = ?").run(routeParam(req, "projectId"), routeParam(req, "userId")));
  if (!result.changes) { res.status(404).json({ error: "Project member not found" }); return; }
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "member.updated", project.revision, { userId: routeParam(req, "userId"), removed: true }));
  res.json({ ok: true });
}));

/* ----------------------------- Object locks ------------------------------ */

async function clearExpiredLocks() {
  (await db.prepare("DELETE FROM project_locks WHERE expires_at <= ?").run(now()));
}

router.get("/:projectId/locks", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!canReadProject(access)) { res.status(404).json({ error: "Project not found" }); return; }
  (await clearExpiredLocks());
  const locks = (await db.prepare("SELECT object_id, user_id, expires_at, updated_at FROM project_locks WHERE project_id = ?")
    .all(routeParam(req, "projectId"))) as { object_id: string; user_id: string; expires_at: number; updated_at: number }[];
  res.json({ locks: locks.map((lock) => ({ objectId: lock.object_id, userId: lock.user_id, expiresAt: lock.expires_at, updatedAt: lock.updated_at })) });
}));

router.post("/:projectId/locks", asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = z.object({ objectId: z.string().trim().min(1).max(200), ttlSeconds: z.number().int().min(15).max(300).default(90) }).safeParse(req.body || {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid object lock request" }); return; }
  const outcome = await withTransaction(async () => {
    const access = await getProjectAccess(routeParam(req, "projectId"), req.user!.id);
    if (!access || !await canWriteProject(access)) return { status: access ? 403 : 404, body: { error: access ? "Editor access required" : "Project not found" } };
    const timestamp = now();
    const token = randomId();
    const expiresAt = timestamp + parsed.data.ttlSeconds;
    // Ownership and expiry are tested by the write itself. A second editor can
    // never replace a live lease after observing an earlier unlocked state.
    const acquired = await db.prepare(`INSERT INTO project_locks (project_id, object_id, user_id, token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, object_id) DO UPDATE SET user_id = excluded.user_id, token = excluded.token, expires_at = excluded.expires_at, updated_at = excluded.updated_at
      WHERE project_locks.user_id = excluded.user_id OR project_locks.expires_at <= ?`)
      .run(routeParam(req, "projectId"), parsed.data.objectId, req.user!.id, token, expiresAt, timestamp, timestamp);
    if (!acquired.changes) {
      const existing = await db.prepare("SELECT user_id, expires_at FROM project_locks WHERE project_id = ? AND object_id = ?")
        .get(routeParam(req, "projectId"), parsed.data.objectId) as { user_id: string; expires_at: number };
      return { status: 423, body: { error: "Object is locked by another editor", userId: existing.user_id, expiresAt: existing.expires_at } };
    }
    const project = await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId")) as { revision: number };
    await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "lock.updated", project.revision, { objectId: parsed.data.objectId, userId: req.user!.id, expiresAt });
    return { status: 201, body: { objectId: parsed.data.objectId, userId: req.user!.id, token, expiresAt, updatedAt: timestamp } };
  });
  res.status(outcome.status).json(outcome.body);
}));

router.delete("/:projectId/locks/:objectId", asyncHandler(async (req: AuthedRequest, res) => {
  const access = (await getProjectAccess(routeParam(req, "projectId"), req.user!.id));
  if (!access || !(await canWriteProject(access))) { res.status(access ? 403 : 404).json({ error: access ? "Editor access required" : "Project not found" }); return; }
  const result = access.role === "owner"
    ? (await db.prepare("DELETE FROM project_locks WHERE project_id = ? AND object_id = ?").run(routeParam(req, "projectId"), routeParam(req, "objectId")))
    : (await db.prepare("DELETE FROM project_locks WHERE project_id = ? AND object_id = ? AND user_id = ?").run(routeParam(req, "projectId"), routeParam(req, "objectId"), req.user!.id));
  if (!result.changes) { res.status(404).json({ error: "Object lock not found" }); return; }
  const project = (await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId"))) as { revision: number };
  (await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "lock.updated", project.revision, { objectId: routeParam(req, "objectId"), released: true }));
  res.json({ ok: true });
}));

/* ------------------------- Conflict-safe operations ---------------------- */

const safePathKey = z.string().min(1).max(100).refine((key) => !["__proto__", "prototype", "constructor"].includes(key), "Unsafe path");
const operationSchema = z.object({
  operationId: z.string().trim().min(8).max(120),
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  kind: z.enum(["set", "merge", "delete"]),
  path: z.array(safePathKey).min(1).max(16),
  value: z.unknown().optional(),
});

function applyOperation(root: unknown, kind: "set" | "merge" | "delete", path: string[], value: unknown): unknown {
  const cloned = root && typeof root === "object" ? JSON.parse(JSON.stringify(root)) as Record<string, unknown> : {};
  let cursor: Record<string, unknown> = cloned;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = cursor[key];
    if (!next || typeof next !== "object") throw new Error("Operation parent path does not exist");
    if (Array.isArray(cursor) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("Array path requires an index");
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) throw new Error("Operation parent path does not exist");
    cursor = cursor[key] as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  if (Array.isArray(cursor)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cursor.length) throw new Error("Array index is out of range");
    if (kind === "delete") { cursor.splice(Number(key), 1); return cloned; }
  }
  if (kind === "delete") {
    if (path.length === 1 && ["room", "furniture", "version"].includes(key)) throw new Error("Required design fields cannot be deleted");
    delete cursor[key];
  }
  else if (kind === "merge") {
    const current = cursor[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Merge value must be an object");
    cursor[key] = { ...(current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {}), ...(value as Record<string, unknown>) };
  } else {
    if (value === undefined) throw new Error("Set requires a value");
    cursor[key] = value;
  }
  return cloned;
}

router.post("/:projectId/operations", asyncHandler(async (req: AuthedRequest, res) => {
  const parsed = operationSchema.safeParse(req.body || {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid collaboration operation" }); return; }
  const outcome = await withTransaction(async () => {
    const access = await getProjectAccess(routeParam(req, "projectId"), req.user!.id);
    if (!access || !await canWriteProject(access)) return { status: access ? 403 : 404, body: { error: access ? "Editor access required" : "Project not found" } };
    const prior = await db.prepare("SELECT result_revision FROM project_operations WHERE project_id = ? AND operation_id = ?")
      .get(routeParam(req, "projectId"), parsed.data.operationId) as { result_revision: number } | undefined;
    if (prior) return { status: 200, body: { ok: true, revision: prior.result_revision, duplicate: true } };
    const project = await db.prepare("SELECT design_data, revision FROM projects WHERE id = ?").get(routeParam(req, "projectId")) as { design_data: string | null; revision: number };
    if (project.revision !== parsed.data.baseRevision) return { status: 409, body: { error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: project.revision } };
    const design: unknown = project.design_data ? JSON.parse(decryptProjectText(project.design_data, access.ownerId)) : {};
    let next: unknown;
    try {
      validateDesignComplexity(design);
      validateDesignComplexity(parsed.data.value);
      next = applyOperation(design, parsed.data.kind, parsed.data.path, parsed.data.value);
      validateDesignComplexity(next);
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "Operation failed" } };
    }
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_DESIGN_BYTES || Buffer.byteLength(serialized, "utf8") > MAX_DESIGN_BYTES) return { status: 413, body: { error: "Resulting design is too large" } };
    const lockedObject = await conflictingDesignLock(routeParam(req, "projectId"), req.user!.id, design, next);
    if (lockedObject) return { status: 423, body: { error: "Object is locked by another editor", objectId: lockedObject } };
    const nextRevision = project.revision + 1;
    const updated = await db.prepare("UPDATE projects SET design_data = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(encryptProjectText(serialized, access.ownerId), nextRevision, now(), routeParam(req, "projectId"), project.revision);
    if (!updated.changes) {
      const latest = await db.prepare("SELECT revision FROM projects WHERE id = ?").get(routeParam(req, "projectId")) as { revision: number };
      return { status: 409, body: { error: "Project changed elsewhere", code: "REVISION_CONFLICT", currentRevision: latest.revision } };
    }
    await db.prepare("INSERT INTO project_operations (project_id, user_id, operation_id, base_revision, result_revision, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(routeParam(req, "projectId"), req.user!.id, parsed.data.operationId, project.revision, nextRevision, parsed.data.kind, JSON.stringify({ path: parsed.data.path }), now());
    await emitProjectEvent(routeParam(req, "projectId"), req.user!.id, "operation.applied", nextRevision, { operationId: parsed.data.operationId, kind: parsed.data.kind, path: parsed.data.path });
    return { status: 201, body: { ok: true, revision: nextRevision, duplicate: false } };
  });
  res.status(outcome.status).json(outcome.body);
}));

export default router;
