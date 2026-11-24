import { captureLocalWrite, localWriteAllowed, subscribeLocalDataFence } from "./localDataFence";

export type OfflineOperationType =
  | "project_save"
  | "snapshot_create"
  | "native_job_submit"
  | "render_job_submit"
  | "artifact_upload";

export type OfflineQueueStatus =
  | "queued"
  | "syncing"
  | "completed"
  | "failed"
  | "conflicted"
  | "superseded";

export interface ConflictDetails {
  serverRevision: number;
  localRevision: number;
  reason: string;
  serverUpdatedAt?: number;
}

export interface OfflineQueueItem {
  id: string;
  userId: string;
  projectId: string;
  type: OfflineOperationType;
  payload: Record<string, unknown>;
  expectedRevision: number;
  status: OfflineQueueStatus;
  createdAt: number;
  updatedAt: number;
  errorMessage?: string;
  conflictDetails?: ConflictDetails;
}

const DB_NAME = "groundwork_offline_queue_v2";
const DB_VERSION = 1;
const STORE_QUEUE = "queue_items";

class OfflineQueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryQueue = new Map<string, OfflineQueueItem>();

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof window === "undefined" || !("indexedDB" in window)) {
        reject(new Error("IndexedDB is not supported in this environment"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          const store = db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
          store.createIndex("by_user", "userId", { unique: false });
          store.createIndex("by_user_status", ["userId", "status"], { unique: false });
          store.createIndex("by_user_project", ["userId", "projectId"], { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /**
   * Enqueue an operation immutably.
   * If a new project save is enqueued, older unsaved operations for the same project are superseded.
   */
  async enqueue(
    userId: string,
    projectId: string,
    type: OfflineOperationType,
    payload: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<OfflineQueueItem> {
    const write = captureLocalWrite(userId);
    const now = Date.now();
    const id = crypto.randomUUID();

    // If enqueueing a new project_save, mark any older queued saves as superseded
    if (write !== null && type === "project_save") {
      const existing = await this.listQueue(userId);
      for (const item of existing) {
        if (item.projectId === projectId && item.type === "project_save" && item.status === "queued") {
          await this.updateStatus(item.id, "superseded", undefined, undefined);
        }
      }
    }

    const item: OfflineQueueItem = {
      id,
      userId,
      projectId,
      type,
      payload,
      expectedRevision,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    if (!localWriteAllowed(userId, write)) return { ...item, status: "failed", errorMessage: "Local account writes are paused during sign-out." };

    this.memoryQueue.set(id, item);

    try {
      const db = await this.getDB();
      if (!localWriteAllowed(userId, write)) return { ...item, status: "failed", errorMessage: "Local account writes are paused during sign-out." };
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      tx.objectStore(STORE_QUEUE).put(item);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineQueue] Error storing item in IndexedDB:", err);
      }
    }

    return item;
  }

  /**
   * Update queue item status and record error/conflict details.
   */
  async updateStatus(
    id: string,
    status: OfflineQueueStatus,
    errorMessage?: string,
    conflictDetails?: ConflictDetails,
  ): Promise<void> {
    const now = Date.now();

    const memItem = this.memoryQueue.get(id);
    const write = memItem ? captureLocalWrite(memItem.userId) : undefined;
    if (write === null) return;
    if (memItem) {
      memItem.status = status;
      memItem.updatedAt = now;
      if (errorMessage !== undefined) memItem.errorMessage = errorMessage;
      if (conflictDetails !== undefined) memItem.conflictDetails = conflictDetails;
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      const store = tx.objectStore(STORE_QUEUE);
      const req = store.get(id);

      req.onsuccess = () => {
        const item = req.result as OfflineQueueItem | undefined;
        if (item) {
          if (!localWriteAllowed(item.userId, write === undefined ? captureLocalWrite(item.userId) : write)) return;
          item.status = status;
          item.updatedAt = now;
          if (errorMessage !== undefined) item.errorMessage = errorMessage;
          if (conflictDetails !== undefined) item.conflictDetails = conflictDetails;
          store.put(item);
        }
      };

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineQueue] Error updating status:", err);
      }
    }
  }

  /**
   * List all queue items for the given user, optionally filtered by status.
   */
  async listQueue(userId: string, filterStatus?: OfflineQueueStatus, options: { requireDurable?: boolean } = {}): Promise<OfflineQueueItem[]> {
    if (!userId) return [];

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_QUEUE, "readonly");
      const store = tx.objectStore(STORE_QUEUE);
      const index = store.index("by_user");
      const req = index.getAll(userId);

      const items = await new Promise<OfflineQueueItem[]>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as OfflineQueueItem[]) || []);
        req.onerror = () => reject(req.error);
      });

      let filtered = items.filter((item) => item.userId === userId);
      if (filterStatus) {
        filtered = filtered.filter((item) => item.status === filterStatus);
      }
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      // Eviction callers must not mistake a partial memory view for an empty durable queue.
      if (options.requireDurable && typeof window !== "undefined" && "indexedDB" in window) throw error;
      let filtered = Array.from(this.memoryQueue.values()).filter((item) => item.userId === userId);
      if (filterStatus) {
        filtered = filtered.filter((item) => item.status === filterStatus);
      }
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  /**
   * Get pending queued operations in FIFO order for synchronization.
   */
  async getPendingQueue(userId: string): Promise<OfflineQueueItem[]> {
    // Interrupted sends retain their bodies; revision checks safely detect a prior commit.
    const items = await this.listQueue(userId);
    return items.filter(item => item.status === "queued" || item.status === "syncing").sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Return set of project IDs that have pending or conflicted operations.
   */
  async getProtectedProjectIds(userId: string): Promise<Set<string>> {
    const items = await this.listQueue(userId);
    const protectedIds = new Set<string>();
    for (const item of items) {
      if (["queued", "syncing", "conflicted"].includes(item.status)) {
        protectedIds.add(item.projectId);
      }
    }
    return protectedIds;
  }

  /**
   * Discard or remove a specific queue item (e.g., dismissed conflict or canceled item).
   */
  async discardItem(id: string): Promise<void> {
    this.memoryQueue.delete(id);

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      tx.objectStore(STORE_QUEUE).delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      if (typeof window !== "undefined" && "indexedDB" in window) {
        console.warn("[OfflineQueue] Error discarding item:", err);
      }
    }
  }

  /** Remove unsaved project edits while the caller holds the replay lock. */
  async discardProjectSaves(userId: string, projectId: string): Promise<void> {
    const write = captureLocalWrite(userId);
    const isUnsavedProjectEdit = (item: OfflineQueueItem) => item.userId === userId
      && item.projectId === projectId && item.type === "project_save" && item.status !== "completed";
    if (write === null) throw new Error("Local changes cannot be discarded during sign-out.");
    if (typeof window !== "undefined" && "indexedDB" in window) {
      const db = await this.getDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_QUEUE, "readwrite");
        const store = transaction.objectStore(STORE_QUEUE);
        const request = store.index("by_user_project").getAll([userId, projectId]);
        request.onsuccess = () => {
          if (!localWriteAllowed(userId, write)) { transaction.abort(); return; }
          for (const item of request.result as OfflineQueueItem[]) {
            if (isUnsavedProjectEdit(item)) store.delete(item.id);
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("Discarding the queued changes was interrupted."));
        transaction.onerror = () => reject(transaction.error);
      });
    }
    for (const [id, item] of this.memoryQueue) {
      if (isUnsavedProjectEdit(item)) this.memoryQueue.delete(id);
    }
  }

  /**
   * Clean up all completed and superseded items for the user.
   */
  async clearCompleted(userId: string): Promise<void> {
    const items = await this.listQueue(userId);
    for (const item of items) {
      if (item.status === "completed" || item.status === "superseded") {
        await this.discardItem(item.id);
      }
    }
  }

  /**
   * Isolate and clear memory references on logout.
   */
  clearActiveUserSession(userId: string): void {
    for (const [id, item] of this.memoryQueue.entries()) {
      if (item.userId === userId) {
        this.memoryQueue.delete(id);
      }
    }
  }

  exportUserMemory(userId: string): OfflineQueueItem[] {
    return Array.from(this.memoryQueue.values()).filter(item => item.userId === userId);
  }
}

export const offlineQueueStore = new OfflineQueueStore();
subscribeLocalDataFence((userId, fence) => { if (fence.remove) offlineQueueStore.clearActiveUserSession(userId); });
