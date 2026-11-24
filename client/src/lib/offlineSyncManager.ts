import { useEffect, useState } from "react";
import { ApiError, assertHostedRequestSize, getCsrfToken, getProject } from "../api";
import { offlineProjectStore } from "./offlineProjectStore";
import { offlineQueueStore, type OfflineQueueItem } from "./offlineQueue";
import { captureLocalWrite, localWriteAllowed, subscribeLocalDataFence } from "./localDataFence";
import type { Design, Project, ProjectDetail, ProjectType } from "../types";
import { fetchJsonResponse, isTransientStatus, RequestTimeoutError, retryAfterDelay, syncRetryDelay } from "./requestResilience";

export interface SyncManagerStatus {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  conflictedCount: number;
  lastSyncTime: number | null;
  lastError: string | null;
}

type SyncListener = (status: SyncManagerStatus) => void;
type ProjectSaveListener = (userId: string, project: Project, design: Design) => void;
const transientSyncError = (error: unknown) => error instanceof ApiError ? isTransientStatus(error.status) : error instanceof TypeError || error instanceof RequestTimeoutError;
const responseError = (response: Response, message: string) => new ApiError(response.status, message, retryAfterDelay(response.headers.get("retry-after")));
const REPLAY_LOCK = "offline-sync-lock";

class OfflineSyncManager {
  private isOnline = typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : true;
  private isSyncing = false;
  private isDiscarding = false;
  private lastSyncTime: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<SyncListener>();
  private projectSaveListeners = new Set<ProjectSaveListener>();
  private activeUserId: string | null = null;
  private syncController: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor() {
    subscribeLocalDataFence((userId, fence) => {
      if (userId !== this.activeUserId) return;
      if (fence.blocked) this.syncController?.abort();
      else if (this.isOnline) void this.synchronize(userId);
    });
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.isOnline = true;
        this.failures = 0;
        this.notify();
        if (this.activeUserId) {
          void this.synchronize(this.activeUserId);
        }
      });

      window.addEventListener("offline", () => {
        this.isOnline = false;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.notify();
      });
    }
  }

  setActiveUser(userId: string | null): void {
    if (userId !== this.activeUserId) {
      this.syncController?.abort(); this.failures = 0;
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    }
    this.activeUserId = userId;
    if (userId && this.isOnline) {
      void this.synchronize(userId);
    }
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  subscribeProjectSaves(listener: ProjectSaveListener): () => void {
    this.projectSaveListeners.add(listener);
    return () => this.projectSaveListeners.delete(listener);
  }

  private notify(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  getStatus(): SyncManagerStatus {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: 0,
      conflictedCount: 0,
      lastSyncTime: this.lastSyncTime,
      lastError: this.lastError,
    };
  }

  async getQueueCounts(userId: string): Promise<{ pending: number; conflicted: number }> {
    const pending = (await offlineQueueStore.listQueue(userId, "queued")).length;
    const conflicted = (await offlineQueueStore.listQueue(userId, "conflicted")).length;
    return { pending, conflicted };
  }

  async discardProjectSaves(userId: string, projectId: string): Promise<void> {
    if (this.isSyncing || this.isDiscarding) throw new Error("Wait for synchronization to finish, then try again.");
    this.isDiscarding = true;
    try {
      if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request(REPLAY_LOCK, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error("Another tab is synchronizing. Try again after it finishes.");
          await offlineQueueStore.discardProjectSaves(userId, projectId);
        });
      } else {
        await offlineQueueStore.discardProjectSaves(userId, projectId);
      }
    } finally {
      this.isDiscarding = false;
      this.notify();
    }
  }

  /**
   * Run synchronization process for the given account.
   */
  async synchronize(userId: string, manual = false): Promise<void> {
    if (!userId || userId !== this.activeUserId || this.isSyncing || this.isDiscarding || !this.isOnline || captureLocalWrite(userId) === null) return;
    if (manual) { this.failures = 0; if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; } }
    else if (this.retryTimer || this.failures >= 6) return;

    const performSync = async () => {
      const write = captureLocalWrite(userId);
      if (!localWriteAllowed(userId, write) || userId !== this.activeUserId || this.isSyncing || this.isDiscarding) return;
      const controller = new AbortController();
      this.syncController = controller;
      const assertCurrent = () => {
        if (controller.signal.aborted || userId !== this.activeUserId || !localWriteAllowed(userId, write)) throw new DOMException("Synchronization paused during account sign-out.", "AbortError");
      };
      this.isSyncing = true;
      this.lastError = null;
      this.notify();

      try {
        // 1. Re-validate authentication and session permissions
        const { response: authRes, data: authData } = await fetchJsonResponse<{ user?: { id: string } }>("/api/auth/me", { credentials: "same-origin", signal: controller.signal });
        assertCurrent();
        if (!authRes.ok) {
          throw responseError(authRes, authRes.status === 401 || authRes.status === 403 ? "Session expired; please sign in before synchronizing" : `Session check failed (${authRes.status})`);
        }
        assertCurrent();
        if (authData.user?.id !== userId) {
          throw new Error("Account mismatch during synchronization");
        }

        // 2. Fetch pending queue items in FIFO order
        const pendingItems = await offlineQueueStore.getPendingQueue(userId);
        assertCurrent();

        for (const item of pendingItems) {
          assertCurrent();
          if (item.userId !== userId) break;
          await this.processItem(userId, item, controller.signal, assertCurrent);
        }

        this.lastSyncTime = Date.now();
        this.failures = 0;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : "Sync error";
        if (!controller.signal.aborted && transientSyncError(err)) {
          this.failures += 1;
          const delay = syncRetryDelay(this.failures, err instanceof ApiError ? err.retryAfterMs : undefined);
          if (this.failures < 6 && Number.isFinite(delay) && typeof window !== "undefined") {
            this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.synchronize(userId); }, delay);
          } else if (this.failures >= 6 || !Number.isFinite(delay)) {
            this.failures = 6;
            this.lastError += "; automatic retries paused. Use Sync now to retry.";
          }
        }
      } finally {
        if (this.syncController === controller) this.syncController = null;
        this.isSyncing = false;
        this.notify();
        if (controller.signal.aborted && this.activeUserId === userId && captureLocalWrite(userId) !== null && this.isOnline) void this.synchronize(userId);
      }
    };

    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(REPLAY_LOCK, { ifAvailable: true }, async (lock) => {
        // If lock is null, another tab is already syncing. We simply return and let it finish.
        if (lock) await performSync();
      });
    } else {
      await performSync();
    }
  }

  private async processItem(userId: string, item: OfflineQueueItem, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    await offlineQueueStore.updateStatus(item.id, "syncing");

    try {
      switch (item.type) {
        case "project_save":
          await this.syncProjectSave(userId, item, signal, assertCurrent);
          break;
        default:
          throw new Error("This legacy queue operation has no verified dispatcher. Export it for recovery; artifact, snapshot and job queues require the new durable contract.");
      }
    } catch (err: unknown) {
      if (signal.aborted || err instanceof DOMException && err.name === "AbortError") throw err;
      assertCurrent();
      const errorMsg = err instanceof Error ? err.message : "Synchronization failed";
      if (transientSyncError(err) || err instanceof ApiError && err.code === "ACCOUNT_CHANGED") {
        // A timed-out PATCH may have committed. The next attempt always reads
        // the server revision again before deciding whether it can send.
        await offlineQueueStore.updateStatus(item.id, "queued", errorMsg);
        throw err;
      }
      await offlineQueueStore.updateStatus(item.id, "failed", errorMsg);
    }
  }

  private async syncProjectSave(userId: string, item: OfflineQueueItem, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    // Permission & Project verification check: inspect server state first
    let projectData: ProjectDetail;
    try {
      projectData = await getProject(item.projectId, userId, signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 && error.status !== 404) throw error;
      assertCurrent();
      const message = error.status === 403
        ? "Permission revoked on this project while offline"
        : "Project was deleted on server while offline";
      await offlineQueueStore.updateStatus(item.id, "failed", message);
      return;
    }
    assertCurrent();

    if (projectData?.id !== item.projectId || !Number.isSafeInteger(projectData.revision) || projectData.revision < 0) {
      throw new Error("Server returned an invalid project revision. The offline edit remains available for recovery.");
    }
    const { design: serverDesign, ...project } = projectData;

    // Revision conflict detection: verify server has not moved ahead
    if (project.revision !== item.expectedRevision) {
      await offlineQueueStore.updateStatus(
        item.id,
        "conflicted",
        "Server revision advanced while offline. Local changes retained to prevent silent overwrite.",
        {
          serverRevision: project.revision,
          localRevision: item.expectedRevision,
          reason: `Server is at revision ${project.revision}, but offline draft was based on revision ${item.expectedRevision}`,
          serverUpdatedAt: project.updatedAt,
        },
      );
      return;
    }

    // Server revision is clean — submit save patch
    const csrfToken = getCsrfToken();
    const { design: legacyDesign, ...payload } = item.payload;
    const designData = typeof payload.designData === "string"
      ? payload.designData
      : legacyDesign && typeof legacyDesign === "object" ? JSON.stringify(legacyDesign) : undefined;
    const body = JSON.stringify({ ...payload, designData, baseRevision: item.expectedRevision, expectedAccountId: userId });
    assertHostedRequestSize(body, "PATCH", import.meta.env?.VITE_HOSTING_MODE);
    const { response: patchRes, data: patchData } = await fetchJsonResponse<{ ok?: boolean; revision?: number; currentRevision?: number; code?: string; error?: string }>(`/api/projects/${encodeURIComponent(item.projectId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
      credentials: "same-origin",
      signal,
      body,
    });
    assertCurrent();

    if (patchRes.status === 409) {
      const conflictRes = patchData;
      assertCurrent();
      if (conflictRes.code === "ACCOUNT_CHANGED") {
        throw new ApiError(409, "The signed-in account changed during synchronization. The queued body remains retained for its original account.", undefined, conflictRes.code);
      }
      await offlineQueueStore.updateStatus(
        item.id,
        "conflicted",
        "Server reported a concurrent conflict during save.",
        {
          serverRevision: conflictRes.currentRevision ?? project.revision + 1,
          localRevision: item.expectedRevision,
          reason: "Concurrent edit conflict reported by server.",
        },
      );
      return;
    }

    if (!patchRes.ok) {
      const errJson = patchData;
      assertCurrent();
      throw responseError(patchRes, errJson.error || `Save failed (${patchRes.status})`);
    }

    const savedData = patchData;
    if (savedData.ok !== true || !Number.isSafeInteger(savedData.revision) || savedData.revision! <= item.expectedRevision) throw new Error("Server returned an invalid saved revision; local changes remain retained");
    assertCurrent();

    // Update offline project cache with new revision and design
    const updatedProject: Project = {
      ...project,
      name: (item.payload.name as string) || project.name,
      projectType: (item.payload.projectType as ProjectType) || project.projectType,
      widthMm: typeof payload.widthMm === "number" ? payload.widthMm : project.widthMm,
      depthMm: typeof payload.depthMm === "number" ? payload.depthMm : project.depthMm,
      revision: savedData.revision!,
      updatedAt: Date.now(),
    };

    const design = designData === undefined ? serverDesign : JSON.parse(designData) as Design;

    if (design) {
      await offlineProjectStore.cacheProject(userId, updatedProject, design);
    }

    await offlineQueueStore.updateStatus(item.id, "completed");
    assertCurrent();
    if (design) for (const listener of this.projectSaveListeners) listener(userId, updatedProject, design);
  }

}

export const offlineSyncManager = new OfflineSyncManager();

export function useOfflineSync(userId?: string) {
  const [status, setStatus] = useState<SyncManagerStatus>(offlineSyncManager.getStatus());
  const [counts, setCounts] = useState({ pending: 0, conflicted: 0 });

  useEffect(() => {
    let active = true;
    setCounts({ pending: 0, conflicted: 0 });
    offlineSyncManager.setActiveUser(userId || null);
    const unsubscribe = offlineSyncManager.subscribe((newStatus) => {
      setStatus(newStatus);
      if (userId) {
        void offlineSyncManager.getQueueCounts(userId).then(value => { if (active) setCounts(value); });
      }
    });

    if (userId) {
      void offlineSyncManager.getQueueCounts(userId).then(value => { if (active) setCounts(value); });
    }

    return () => { active = false; unsubscribe(); };
  }, [userId]);

  return {
    ...status,
    pendingCount: counts.pending,
    conflictedCount: counts.conflicted,
    syncNow: () => {
      if (userId) void offlineSyncManager.synchronize(userId, true);
    },
  };
}
