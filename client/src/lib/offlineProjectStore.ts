import type { Design, Project, ProjectType } from "../types";
import { captureLocalWrite, localWriteAllowed, subscribeLocalDataFence } from "./localDataFence";
import { CacheCapacityError, planCacheWrite } from "./cacheCapacity";
import { offlineQueueStore } from "./offlineQueue";
import { exportAccountDrafts } from "./offlineDraft";

export interface CachedProjectRecord {
  userId: string;
  accountBound: true;
  serverConfirmed?: true;
  projectId: string;
  name: string;
  projectType: ProjectType;
  revision: number;
  design: Design;
  hasPhoto: boolean;
  role: "owner" | "editor" | "viewer";
  cachedAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

export interface CachedSnapshotRecord {
  userId: string;
  projectId: string;
  snapshotId: string;
  revision: number;
  description: string;
  snapshotData: string;
  createdAt: number;
  sizeBytes: number;
}

export interface StorageQuotaInfo {
  totalBytes: number;
  maxBytes: number;
  projectCount: number;
  maxProjects: number;
  usagePercent: number;
}

const DB_NAME = "groundwork_offline_projects_v2";
const DB_VERSION = 2;
const STORE_PROJECTS = "cached_projects";
const STORE_SNAPSHOTS = "cached_snapshots";

export const MAX_USER_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_PROJECTS_PER_USER = 50;
export const MAX_SNAPSHOTS_PER_PROJECT = 10;

class OfflineProjectStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryCache = new Map<string, CachedProjectRecord>();

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof window === "undefined" || !("indexedDB" in window)) {
        reject(new Error("IndexedDB is not supported in this environment"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("Browser cache did not open. Close older Groundwork tabs and retry.")), 10_000);
      request.onblocked = () => fail(new Error("An older Groundwork tab is blocking the browser cache update. Close it and retry."));

      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          const projectStore = db.createObjectStore(STORE_PROJECTS, {
            keyPath: ["userId", "projectId"],
          });
          projectStore.createIndex("by_user", "userId", { unique: false });
          projectStore.createIndex("by_user_accessed", ["userId", "lastAccessedAt"], { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          const snapshotStore = db.createObjectStore(STORE_SNAPSHOTS, {
            keyPath: ["userId", "projectId", "snapshotId"],
          });
          snapshotStore.createIndex("by_user_project", ["userId", "projectId"], { unique: false });
          snapshotStore.createIndex("by_created", "createdAt", { unique: false });
        }
        const snapshots = request.transaction!.objectStore(STORE_SNAPSHOTS);
        if (!snapshots.indexNames.contains("by_user")) snapshots.createIndex("by_user", "userId", { unique: false });
      };

      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timeout);
        request.result.onversionchange = () => { request.result.close(); if (this.dbPromise === opening) this.dbPromise = null; };
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
    });
    this.dbPromise = opening;
    void opening.catch(() => { if (this.dbPromise === opening) this.dbPromise = null; });
    return opening;
  }

  private estimateSize(obj: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(obj)).length;
    } catch {
      return 1024;
    }
  }

  /**
   * Account-scoped project caching with LRU eviction and storage limits.
   */
  async cacheProject(
    userId: string,
    project: Pick<Project, "id" | "name" | "projectType" | "revision" | "hasPhoto" | "role">,
    design: Design,
    protectedProjectIds: Set<string> = new Set(),
  ): Promise<void> {
    if (!userId || !project.id) return;
    const write = captureLocalWrite(userId);
    if (write === null) return;

    const sizeBytes = this.estimateSize({ project, design });

    const now = Date.now();
    const record: CachedProjectRecord = {
      userId,
      accountBound: true,
      serverConfirmed: true,
      projectId: project.id,
      name: project.name,
      projectType: (project.projectType || "house") as ProjectType,
      revision: project.revision ?? 0,
      design,
      hasPhoto: Boolean(project.hasPhoto),
      role: (project.role || "owner") as "owner" | "editor" | "viewer",
      cachedAt: now,
      lastAccessedAt: now,
      sizeBytes,
    };

    const cacheKey = `${userId}:${project.id}`;
    let protectedIds: Set<string> | undefined;
    try {
      protectedIds = await this.collectProtectedProjectIds(userId, protectedProjectIds);
      const db = await this.getDB();
      if (!localWriteAllowed(userId, write)) return;
      await this.persistEntry(db, userId, write, { project: record }, protectedIds);
    } catch (err) {
      if (protectedIds && (typeof window === "undefined" || !("indexedDB" in window))) {
        try {
          const current = this.memoryCache.get(cacheKey);
          if (current?.serverConfirmed && current.revision > record.revision) return;
          const plan = planCacheWrite(this.exportUserMemory(userId), [], { project: record }, protectedIds, this.budget);
          if (!localWriteAllowed(userId, write)) return;
          for (const id of plan.removeProjects) this.memoryCache.delete(`${userId}:${id}`);
          this.memoryCache.set(cacheKey, record);
        } catch { /* Preserve existing recovery copies when capacity is unavailable. */ }
      }
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineProjectStore] Could not persist project to IndexedDB:", err);
      }
    }
  }

  /**
   * Retrieve cached project strictly scoped to the active account.
   */
  async getCachedProject(userId: string, projectId: string): Promise<CachedProjectRecord | null> {
    if (!userId || !projectId) return null;
    const write = captureLocalWrite(userId);
    if (write === null) return null;

    const cacheKey = `${userId}:${projectId}`;
    const inMem = this.memoryCache.get(cacheKey);
    if (inMem?.serverConfirmed && inMem.userId === userId) {
      inMem.lastAccessedAt = Date.now();
      return inMem;
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_PROJECTS, "readwrite");
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.get([userId, projectId]);

      const record = await new Promise<CachedProjectRecord | null>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as CachedProjectRecord) || null);
        req.onerror = () => reject(req.error);
      });

      // Earlier releases could cache a draft as if it were the saved project.
      // An online read refreshes the saved copy while keeping recovery records.
      if (record?.accountBound === true && record.serverConfirmed === true && record.userId === userId && localWriteAllowed(userId, write)) {
        record.lastAccessedAt = Date.now();
        store.put(record);
        this.memoryCache.set(cacheKey, record);
        return record;
      }
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineProjectStore] Could not read cached project:", err);
      }
    }

    return null;
  }

  /**
   * List all projects cached for the given user ID.
   */
  async listCachedProjects(userId: string): Promise<CachedProjectRecord[]> {
    if (!userId) return [];

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_PROJECTS, "readonly");
      const store = tx.objectStore(STORE_PROJECTS);
      const index = store.index("by_user");
      const req = index.getAll(userId);

      const records = await new Promise<CachedProjectRecord[]>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as CachedProjectRecord[]) || []);
        req.onerror = () => reject(req.error);
      });

      return records.filter((r) => r.userId === userId && r.accountBound === true);
    } catch {
      return Array.from(this.memoryCache.values()).filter((r) => r.userId === userId);
    }
  }

  /**
   * Cache a snapshot for a project, bounded by max snapshots per project.
   */
  async cacheSnapshot(
    userId: string,
    projectId: string,
    snapshot: { id: string; revision: number; description?: string; snapshotData: string },
    protectedProjectIds: Set<string> = new Set(),
  ): Promise<void> {
    const write = captureLocalWrite(userId);
    if (write === null) return;
    if (!userId || !projectId || !snapshot.id) return;

    const sizeBytes = this.estimateSize(snapshot);
    const now = Date.now();
    const record: CachedSnapshotRecord = {
      userId,
      projectId,
      snapshotId: snapshot.id,
      revision: snapshot.revision,
      description: snapshot.description || "",
      snapshotData: snapshot.snapshotData,
      createdAt: now,
      sizeBytes,
    };

    try {
      const protectedIds = await this.collectProtectedProjectIds(userId, protectedProjectIds);
      const db = await this.getDB();
      if (!localWriteAllowed(userId, write)) return;
      await this.persistEntry(db, userId, write, { snapshot: record }, protectedIds);
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineProjectStore] Could not cache snapshot:", err);
      }
    }
  }

  /**
   * List cached snapshots for a project.
   */
  async listCachedSnapshots(userId: string, projectId: string): Promise<CachedSnapshotRecord[]> {
    if (!userId || !projectId) return [];

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
      const store = tx.objectStore(STORE_SNAPSHOTS);
      const index = store.index("by_user_project");
      const req = index.getAll([userId, projectId]);

      const items = await new Promise<CachedSnapshotRecord[]>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as CachedSnapshotRecord[]) || []);
        req.onerror = () => reject(req.error);
      });

      return items.filter((item) => item.userId === userId && item.projectId === projectId);
    } catch {
      return [];
    }
  }

  /**
   * Calculate storage quota and usage for the user.
   */
  async getStorageUsage(userId: string): Promise<StorageQuotaInfo> {
    const projects = await this.listCachedProjects(userId);
    let totalBytes = 0;
    for (const p of projects) {
      totalBytes += p.sizeBytes || 0;
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
      const store = tx.objectStore(STORE_SNAPSHOTS);
      const cursorReq = store.openCursor();
      await new Promise<void>((resolve) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const row = cursor.value as CachedSnapshotRecord;
            if (row.userId === userId) totalBytes += row.sizeBytes || 0;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      });
    } catch {
      /* ignore */
    }

    const usagePercent = Math.min(100, Math.round((totalBytes / MAX_USER_STORAGE_BYTES) * 100));
    return {
      totalBytes,
      maxBytes: MAX_USER_STORAGE_BYTES,
      projectCount: projects.length,
      maxProjects: MAX_PROJECTS_PER_USER,
      usagePercent,
    };
  }

  /**
   * Ensure user's cached storage stays within bounded limits using LRU eviction.
   * Never evicts projects that have pending offline queue items (`protectedProjectIds`).
   */
  private readonly budget = { maxBytes: MAX_USER_STORAGE_BYTES, maxProjects: MAX_PROJECTS_PER_USER, maxSnapshots: MAX_SNAPSHOTS_PER_PROJECT };

  /** Callers cannot accidentally evict recovery copies by omitting the optional set. */
  private async collectProtectedProjectIds(userId: string, explicit: ReadonlySet<string>): Promise<Set<string>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const queue = await Promise.race([
        offlineQueueStore.listQueue(userId, undefined, { requireDurable: true }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Recovery queue could not be checked; browser cache was left unchanged.")), 10_000); }),
      ]);
      const protectedIds = new Set(explicit);
      for (const item of queue) if (item.userId === userId && item.status !== "completed" && item.status !== "superseded") protectedIds.add(item.projectId);
      this.protectDraftProjects(userId, protectedIds);
      return protectedIds;
    } finally { clearTimeout(timeout); }
  }

  private protectDraftProjects(userId: string, protectedIds: Set<string>): void {
    const prefix = `groundwork:draft:v2:${encodeURIComponent(userId)}:`, legacyPrefix = `groundwork:draft:${userId}:`;
    // Keys alone protect even a damaged recovery record; cache eviction must not discard its base.
    for (const draft of exportAccountDrafts(userId)) {
      if (draft.key.startsWith(prefix)) {
        const project = draft.key.slice(prefix.length).split(":")[0];
        try { if (project) protectedIds.add(decodeURIComponent(project)); } catch { throw new Error("A recovery key could not be checked; browser cache was left unchanged."); }
      } else if (draft.key.startsWith(legacyPrefix)) protectedIds.add(draft.key.slice(legacyPrefix.length));
    }
  }

  /** Read, plan, evict and insert under one serialized IndexedDB transaction. */
  private persistEntry(db: IDBDatabase, userId: string, write: NonNullable<ReturnType<typeof captureLocalWrite>>,
    incoming: { project?: CachedProjectRecord; snapshot?: CachedSnapshotRecord }, protectedIds: Set<string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PROJECTS, STORE_SNAPSHOTS], "readwrite");
      const pStore = tx.objectStore(STORE_PROJECTS), sStore = tx.objectStore(STORE_SNAPSHOTS);
      const pRequest = pStore.index("by_user").getAll(userId), sRequest = sStore.index("by_user").getAll(userId);
      let remaining = 2, failure: unknown, plan: ReturnType<typeof planCacheWrite> | undefined;
      let savedProject: CachedProjectRecord | undefined;
      const prepare = () => {
        if (--remaining) return;
        try {
          if (!localWriteAllowed(userId, write)) throw new Error("Local cache write was cancelled during account transition.");
          const projects = (pRequest.result as CachedProjectRecord[]).filter(item => item.userId === userId);
          const snapshots = (sRequest.result as CachedSnapshotRecord[]).filter(item => item.userId === userId);
          const current = projects.find(item => item.projectId === incoming.project?.projectId);
          if (incoming.project && current?.serverConfirmed && current.revision > incoming.project.revision) return;
          this.protectDraftProjects(userId, protectedIds);
          plan = planCacheWrite(projects, snapshots, incoming, protectedIds, this.budget);
          for (const id of plan.removeProjects) pStore.delete([userId, id]);
          for (const item of plan.removeSnapshots) sStore.delete([userId, item.projectId, item.snapshotId]);
          if (incoming.project) {
            pStore.put(incoming.project);
            savedProject = incoming.project;
          }
          if (incoming.snapshot) sStore.put(incoming.snapshot);
        } catch (error) { failure = error; tx.abort(); }
      };
      pRequest.onsuccess = prepare; sRequest.onsuccess = prepare;
      tx.oncomplete = () => {
        if (localWriteAllowed(userId, write)) {
          for (const id of plan?.removeProjects ?? []) this.memoryCache.delete(`${userId}:${id}`);
          if (savedProject) this.memoryCache.set(`${userId}:${savedProject.projectId}`, savedProject);
        }
        resolve();
      };
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new CacheCapacityError());
    });
  }

  /**
   * Isolate and clear user memory cache on logout.
   */
  clearActiveUserSession(userId: string): void {
    for (const [key, record] of this.memoryCache.entries()) {
      if (record.userId === userId || key.startsWith(`${userId}:`)) {
        this.memoryCache.delete(key);
      }
    }
  }

  exportUserMemory(userId: string): CachedProjectRecord[] {
    return Array.from(this.memoryCache.values()).filter(record => record.userId === userId);
  }

  /**
   * Purge all cached data for a user (e.g., explicit privacy cleanup).
   */
  async deleteUserCache(userId: string): Promise<void> {
    this.clearActiveUserSession(userId);

    try {
      const db = await this.getDB();
      const tx = db.transaction([STORE_PROJECTS, STORE_SNAPSHOTS], "readwrite");
      const pStore = tx.objectStore(STORE_PROJECTS);
      const sStore = tx.objectStore(STORE_SNAPSHOTS);

      const pReq = pStore.index("by_user").getAllKeys(userId);
      pReq.onsuccess = () => {
        for (const k of pReq.result) pStore.delete(k);
      };

      const sCursor = sStore.openCursor();
      sCursor.onsuccess = () => {
        const cursor = sCursor.result;
        if (cursor) {
          const row = cursor.value as CachedSnapshotRecord;
          if (row.userId === userId) cursor.delete();
          cursor.continue();
        }
      };

      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineProjectStore] Could not delete user cache:", err);
      }
    }
  }
}

export const offlineProjectStore = new OfflineProjectStore();
subscribeLocalDataFence((userId, fence) => { if (fence.remove) offlineProjectStore.clearActiveUserSession(userId); });
