import type { Response } from "express";
import { deriveVaultKey, encryptAesGcm, randomId } from "./crypto.js";
import { MASTER_KEY } from "./config.js";
import { db, now, withTransaction, afterCommit } from "./db.js";
import { getProjectAccess, readableProjectUsers } from "./projectAccess.js";
import { writeSse } from "./sse.js";
import { publishRedisProjectEvent, redisPresence, redisTransportConfigured } from "./redisTransport.js";
const key = deriveVaultKey(MASTER_KEY);
type ProjectConnection = {
    response: Response;
    canReceive: () => Promise<boolean>;
    wake: () => void;
};
const connections = new Map<string, Set<ProjectConnection>>();
export const collaborationInstanceId = randomId();
let drainingOutbox = false;
async function drainRedisOutbox() {
    if (!redisTransportConfigured || drainingOutbox)
        return;
    drainingOutbox = true;
    try {
        for (let index = 0; index < 50; index += 1) {
            const row = await withTransaction(async () => {
                const next = await db.prepare("SELECT event_id,project_id,body,attempts FROM project_event_outbox WHERE next_attempt_at<=? AND claim_until<=? ORDER BY event_id LIMIT 1")
                    .get(now(), now()) as {
                    event_id: number;
                    project_id: string;
                    body: string;
                    attempts: number;
                } | undefined;
                if (next)
                    await db.prepare("UPDATE project_event_outbox SET claim_owner=?,claim_until=? WHERE event_id=?").run(collaborationInstanceId, now() + 15, next.event_id);
                return next;
            });
            if (!row)
                break;
            try {
                await publishRedisProjectEvent(row.project_id, JSON.parse(row.body) as unknown);
                await db.prepare("DELETE FROM project_event_outbox WHERE event_id=? AND claim_owner=?").run(row.event_id, collaborationInstanceId);
            }
            catch {
                await db.prepare("UPDATE project_event_outbox SET attempts=attempts+1,next_attempt_at=?,claim_until=0,claim_owner=NULL WHERE event_id=? AND claim_owner=?")
                    .run(now() + Math.min(60, 2 ** Math.min(row.attempts + 1, 6)), row.event_id, collaborationInstanceId);
                await broadcast(row.project_id, "transport-status", { backend: "redis-rest", degraded: true });
                break;
            }
        }
    }
    finally {
        drainingOutbox = false;
    }
}
if (redisTransportConfigured)
    setInterval(() => { void drainRedisOutbox().catch(() => undefined); }, 5000).unref();
function encrypt(userId: string, value: unknown): string {
    return JSON.stringify(encryptAesGcm(JSON.stringify(value), key, `groundwork:project:${userId}`));
}
export type CollaborationType = "design.updated" | "snapshot.created" | "comment.created" | "issue.updated" | "operation.applied" | "lock.updated" | "member.updated";
async function writeProjectState({ response, canReceive }: ProjectConnection, event: "presence" | "transport-status", data: unknown) {
    if (response.destroyed || response.writableEnded) return;
    if (!await canReceive().catch(() => false)) { response.end(); return; }
    writeSse(response, event, data);
}
async function broadcast(projectId: string, event: "presence" | "transport-status", data: unknown) {
    await Promise.all(Array.from(connections.get(projectId) ?? [], connection => writeProjectState(connection, event, data)));
}
export async function emitProjectEvent(projectId: string, userId: string, type: CollaborationType, revision: number, payload: unknown) {
    const createdAt = now();
    await withTransaction(async () => {
        const rowId = (await db.prepare("INSERT INTO project_collaboration_events (project_id, user_id, event_type, revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, userId, type, revision, encrypt(userId, payload), createdAt)).lastInsertRowid;
        if (redisTransportConfigured) {
            await db.prepare("INSERT INTO project_event_outbox (event_id,project_id,body,next_attempt_at) VALUES (?,?,?,?)")
                .run(rowId, projectId, JSON.stringify({ origin: collaborationInstanceId, eventId: randomId(), projectId, type, revision, createdAt, actorId: userId }), now());
            // Notification history is bounded; the authoritative design/revision and
            // coordination operation journals remain available for resynchronization.
            await db.prepare("DELETE FROM project_event_outbox WHERE event_id IN (SELECT event_id FROM project_event_outbox ORDER BY event_id DESC LIMIT 2147483647 OFFSET 100000)").run();
        }
    });
    // Local notifications carry no event data. Each stream replays through its
    // own authorized cursor, just as it does for events committed elsewhere.
    await afterCommit(() => {
        for (const connection of connections.get(projectId) ?? []) connection.wake();
    });
}
export async function presenceSnapshot(projectId: string) {
    const rows = await db.prepare("SELECT user_id,COUNT(*) AS connections FROM project_presence WHERE project_id=? AND expires_at>? GROUP BY user_id LIMIT 2000")
        .all(projectId, now()) as {
        user_id: string;
        connections: number;
    }[];
    const users: {
        userId: string;
        connections: number;
    }[] = [];
    const readable = await readableProjectUsers(projectId, rows.map((row) => row.user_id));
    for (const row of rows) {
        if (readable.has(row.user_id)) {
            users.push({ userId: row.user_id, connections: Number(row.connections) });
        }
    }
    return { projectId, users, count: users.length };
}
async function broadcastPresence(projectId: string) {
    await broadcast(projectId, "presence", await presenceSnapshot(projectId));
}
export interface ProjectSubscriptionLease { connectionId: string; projectId: string; userId: string; }
export class CollaborationSubscriptionError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}
/** Reserve before sending SSE headers, under the shared cross-instance write fence. */
export async function reserveProjectSubscription(projectId: string, userId: string): Promise<ProjectSubscriptionLease> {
    return await withTransaction(async () => {
        if (!await getProjectAccess(projectId, userId)) throw new CollaborationSubscriptionError(404, "Project not found");
        const timestamp = now();
        await db.prepare("DELETE FROM project_presence WHERE expires_at<=?").run(timestamp);
        const count = await db.prepare("SELECT COUNT(*) AS count FROM project_presence WHERE project_id=? AND user_id=? AND expires_at>?").get(projectId, userId, timestamp) as { count: number };
        if (count.count >= 10) throw new CollaborationSubscriptionError(429, "Too many active collaboration connections for this project");
        const connectionId = randomId();
        await db.prepare("INSERT INTO project_presence(connection_id,project_id,user_id,expires_at) VALUES(?,?,?,?)").run(connectionId, projectId, userId, timestamp + 45);
        return { connectionId, projectId, userId };
    });
}
export async function releaseProjectSubscription(lease: ProjectSubscriptionLease): Promise<void> {
    await db.prepare("DELETE FROM project_presence WHERE connection_id=? AND project_id=? AND user_id=?").run(lease.connectionId, lease.projectId, lease.userId);
}
export async function subscribeProject(projectId: string, userId: string, connection: ProjectConnection, reserved?: ProjectSubscriptionLease) {
    const { response } = connection;
    const reservation = reserved || await reserveProjectSubscription(projectId, userId);
    if (reservation.projectId !== projectId || reservation.userId !== userId) throw new Error("Invalid collaboration reservation");
    const connectionId = reservation.connectionId;
    const redisMember = `${userId}|${connectionId}`;
    let closed = false;
    let renewing = false;
    let closing: Promise<void> | undefined;
    let lease: ReturnType<typeof setInterval> | undefined;
    let project: Set<ProjectConnection> | undefined;
    const onClose = () => { void unsubscribe().catch(() => undefined); };
    const unsubscribe = (): Promise<void> => {
        if (closing) return closing;
        closed = true;
        if (lease) clearInterval(lease);
        response.off("close", onClose);
        response.off("finish", onClose);
        project?.delete(connection);
        if (project?.size === 0) connections.delete(projectId);
        closing = (async () => {
            await releaseProjectSubscription(reservation);
            if (redisTransportConfigured) await redisPresence(projectId, redisMember).catch(() => undefined);
            if (project?.size) await broadcastPresence(projectId);
        })();
        return closing;
    };
    // Install cleanup before the first asynchronous renewal or presence write.
    response.once("close", onClose);
    response.once("finish", onClose);
    const renew = async () => {
        if (closed || renewing)
            return;
        renewing = true;
        try {
            // Expired reservations never resurrect after another connection has
            // claimed the released capacity.
            const renewed = await db.prepare("UPDATE project_presence SET expires_at=? WHERE connection_id=? AND project_id=? AND user_id=? AND expires_at>?")
                .run(now() + 45, connectionId, projectId, userId, now());
            if (!renewed.changes) { response.end(); await unsubscribe(); return; }
            if (closed) {
                await db.prepare("DELETE FROM project_presence WHERE connection_id=?").run(connectionId);
                return;
            }
            if (redisTransportConfigured) {
                const presence = await redisPresence(projectId, redisMember, now() + 45).catch(async () => {
                    await writeProjectState(connection, "transport-status", { backend: "redis-rest", degraded: true });
                    return null;
                });
                if (!presence) return;
                const users: typeof presence.users = [];
                const readable = await readableProjectUsers(projectId, presence.users.map((entry) => entry.userId));
                for (const entry of presence.users) {
                    if (readable.has(entry.userId))
                        users.push(entry);
                }
                if (closed) {
                    await redisPresence(projectId, redisMember);
                    return;
                }
                // Every stream renews independently. A renewal only refreshes
                // that stream to avoid reauthorizing every viewer on each lease.
                await writeProjectState(connection, "presence", { projectId, users, count: users.length });
            }
        }
        finally {
            renewing = false;
        }
    };
    try {
        if (response.destroyed || response.writableEnded) { await unsubscribe(); return unsubscribe; }
        await renew();
        if (closed || response.destroyed || response.writableEnded) { await unsubscribe(); return unsubscribe; }
        project = connections.get(projectId);
        if (!project) { project = new Set<ProjectConnection>(); connections.set(projectId, project); }
        project.add(connection);
        lease = setInterval(() => {
            void renew().catch(() => writeProjectState(connection, "transport-status", { backend: redisTransportConfigured ? "redis-rest" : "database", degraded: true }));
        }, 15000);
        lease.unref?.();
        await broadcastPresence(projectId);
        if (response.destroyed || response.writableEnded) await unsubscribe();
    }
    catch (error) {
        await unsubscribe().catch(() => undefined);
        throw error;
    }
    return unsubscribe;
}
export async function replayProjectEvents(projectId: string, response: Response, afterId: number, canReceive: ProjectConnection["canReceive"]) {
    const rows = await db.prepare("SELECT id, user_id, event_type, revision, created_at FROM project_collaboration_events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT 500").all(projectId, afterId) as {
        id: number;
        user_id: string;
        event_type: string;
        revision: number;
        created_at: number;
    }[];
    if (!await canReceive()) { response.end(); return afterId; }
    let cursor = afterId;
    for (const row of rows) {
        if (!writeSse(response, "collaboration", { id: row.id, projectId, type: row.event_type, revision: row.revision, createdAt: row.created_at, actorId: row.user_id }, row.id)) break;
        cursor = row.id;
    }
    return cursor;
}
export function collaborationItemId() {
    return randomId();
}
