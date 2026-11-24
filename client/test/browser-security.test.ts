import { strict as assert } from "node:assert";
import { test } from "node:test";
import JSZip from "jszip";
import { BcfImportLimitError, inflateBcfArchive, MAX_BCF_XML_BYTES } from "../src/lib/bcfArchive.ts";
import { captureAuthenticationFences, captureLocalWrite, confirmLocalSignOut, fenceLocalAccount, localAccountFence, localWriteAllowed, registerLocalDraftFlush, resumeAuthenticatedLocalAccount, resumeLocalAccount, subscribeLocalDataFence, synchronizeLocalAccountFence } from "../src/lib/localDataFence.ts";
import { draftMatchesSavedProject, exportAccountDrafts, persistPendingDraft, readPendingDraftResult, removeAccountDrafts, type PendingDraft } from "../src/lib/offlineDraft.ts";
import { recoverLocalAccountAfterSignIn, signOutAccount } from "../src/lib/signOutAccount.ts";
import { offlineQueueStore } from "../src/lib/offlineQueue.ts";
import { offlineProjectStore } from "../src/lib/offlineProjectStore.ts";
import { writeWorkspaceDraft, type WorkspaceDraft } from "../src/lib/workspaceDraft.ts";
import { offlineSyncManager } from "../src/lib/offlineSyncManager.ts";
import { removeLocalAccountData } from "../src/lib/accountLocalData.ts";
import { ApiError, assertHostedRequestSize, logout as requestLogout, setCsrfToken } from "../src/api.ts";

test("hosted request limits count UTF-8 bytes rather than characters", () => {
  assert.doesNotThrow(() => assertHostedRequestSize("a".repeat(4_000_000), "POST", "vercel"));
  assert.throws(() => assertHostedRequestSize("é".repeat(2_000_001), "PATCH", "vercel"), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 413);
    assert.match(error.message, /4 MB.*smaller file or design/);
    return true;
  });
});

test("hosted multipart limits combine file and field bytes with overhead", () => {
  const body = new FormData();
  body.append("artifact", new Blob([new Uint8Array(3_900_000)]), "model.glb");
  body.append("description", "é".repeat(50_000));
  assert.throws(() => assertHostedRequestSize(body, "PUT", "vercel"), { status: 413 });
  body.set("description", "small model");
  assert.doesNotThrow(() => assertHostedRequestSize(body, "PUT", "vercel"));
});

test("hosted limits handle binary bodies and preserve ordinary deployments", () => {
  const body = new Blob([new Uint8Array(4_000_001)]);
  assert.throws(() => assertHostedRequestSize(body, "post", "vercel"), { status: 413 });
  assert.throws(() => assertHostedRequestSize(new Uint8Array(4_000_001), "PUT", "vercel"), { status: 413 });
  assert.doesNotThrow(() => assertHostedRequestSize(body, "POST", undefined));
  assert.doesNotThrow(() => assertHostedRequestSize(body, "GET", "vercel"));
});

class TestStorage {
  values = new Map<string, string>();
  failWrites = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("storage unavailable"); this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
const durable = new TestStorage(), session = new TestStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: durable });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
const draft = (name: string): PendingDraft => ({ design: { room: { widthMm: 1000, depthMm: 1000 }, furniture: [] } as PendingDraft["design"], name, projectType: "house", baseRevision: 1, savedAt: Date.now() });

async function archive(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
function forgeExpandedLengths(bytes: Uint8Array, declared: number): Uint8Array {
  const forged = bytes.slice(), view = new DataView(forged.buffer);
  for (let index = 0; index + 46 <= forged.length; index++) {
    if (view.getUint32(index, true) === 0x02014b50) view.setUint32(index + 24, declared, true);
  }
  return forged;
}

test("BCF preserves bounded XML and binary attachments", async () => {
  const files = await inflateBcfArchive(await archive({ "topic/markup.bcf": "<Markup/>", "topic/snapshot.png": new Uint8Array([1, 2, 3]) }));
  assert.equal(new TextDecoder().decode(files.find(file => file.name.endsWith("markup.bcf"))!.bytes), "<Markup/>");
  assert.deepEqual(files.find(file => file.name.endsWith("snapshot.png"))!.bytes, new Uint8Array([1, 2, 3]));
});

test("BCF forged expanded length is stopped during output, before the entry finishes", async () => {
  const expanded = 2 * MAX_BCF_XML_BYTES;
  const forged = forgeExpandedLengths(await archive({ "topic/markup.bcf": "a".repeat(expanded) }), 1);
  assert.ok(forged.length < 5000);
  await assert.rejects(inflateBcfArchive(forged), error => {
    assert.ok(error instanceof BcfImportLimitError, "must reject at the streaming limit, not JSZip's eventual size mismatch");
    assert.ok(error.entryBytes > MAX_BCF_XML_BYTES);
    assert.ok(error.entryBytes <= MAX_BCF_XML_BYTES + 16 * 1024);
    assert.ok(error.entryBytes < expanded);
    return true;
  });
});

test("BCF counts actual output across separate entries", async () => {
  const maximum = 96 * 1024;
  await assert.rejects(inflateBcfArchive(await archive({ "a.bin": "a".repeat(64 * 1024), "b.bin": "b".repeat(64 * 1024) }), undefined, maximum), error => {
    assert.ok(error instanceof BcfImportLimitError);
    assert.ok(error.totalBytes > maximum && error.totalBytes <= maximum + 16 * 1024);
    return true;
  });
});

test("BCF cancellation rejects before archive loading", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inflateBcfArchive(await archive({ "markup.bcf": "<Markup/>" }), controller.signal), { name: "AbortError" });
});

test("BCF rejects unsafe paths before any expansion", async () => {
  await assert.rejects(inflateBcfArchive(await archive({ "../markup.bcf": "<Markup/>" })), /unsafe or duplicate paths/);
});

test("failed logout flushes the newest draft, keeps local data, and permits a retry", async () => {
  const userId = "logout-failure", projectId = "project";
  persistPendingDraft(userId, projectId, draft("old"));
  let requests = 0;
  const unregister = registerLocalDraftFlush(userId, async () => { persistPendingDraft(userId, projectId, draft("latest")); });
  try {
    await assert.rejects(signOutAccount(userId, "preserve", async () => {
      requests++;
      assert.equal(captureLocalWrite(userId), null);
      assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "latest");
      throw new TypeError("Network unavailable");
    }), /Sign-out was not confirmed; you are still signed in/);
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "latest");
    assert.notEqual(captureLocalWrite(userId), null);
    await signOutAccount(userId, "preserve", async () => { requests++; });
    assert.equal(requests, 2);
    assert.equal(captureLocalWrite(userId), null);
    assert.ok(exportAccountDrafts(userId).length > 0);
  } finally { unregister(); }
});

test("keep-local logout retains memory-only recovery when durable browser storage fails", async () => {
  const userId = "memory-only", projectId = "project";
  durable.failWrites = true; session.failWrites = true;
  try {
    assert.equal(persistPendingDraft(userId, projectId, draft("unsaved memory")).stored, false);
    await signOutAccount(userId, "preserve", async () => { assert.equal(captureLocalWrite(userId), null); });
    assert.equal(captureLocalWrite(userId), null);
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "unsaved memory");
    assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), true);
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "unsaved memory");
  } finally { durable.failWrites = false; session.failWrites = false; }
});

test("explicit removal purges only the selected account and blocks late writes", async () => {
  const userId = "remove-account", other = "retain-account", projectId = "project";
  persistPendingDraft(userId, projectId, draft("remove"));
  persistPendingDraft(other, projectId, draft("retain"));
  await offlineQueueStore.enqueue(userId, projectId, "project_save", { name: "queued" }, 1);
  const token = captureLocalWrite(userId);
  await signOutAccount(userId, "remove", async () => undefined);
  assert.deepEqual(exportAccountDrafts(userId), []);
  assert.deepEqual(offlineQueueStore.exportUserMemory(userId), []);
  assert.equal(readPendingDraftResult(other, projectId).draft?.name, "retain");
  assert.equal(persistPendingDraft(userId, projectId, draft("late")).stored, false);
  resumeLocalAccount(userId);
  const late: WorkspaceDraft = { key: `${userId}:${projectId}:geometry:late`, version: 1, userId, projectId, kind: "geometry", baseRevision: 1, sourceRevision: 1, content: "{}", updatedAt: Date.now(), files: [], referencedArtifactIds: [] };
  await assert.rejects(writeWorkspaceDraft(late, token), /paused during sign-out/);
  assert.deepEqual(exportAccountDrafts(userId), []);
});

test("a stale authentication response cannot reopen a removal or completed sign-out fence", () => {
  const userId = "stale-auth", started = captureAuthenticationFences();
  const fence = fenceLocalAccount(userId, true);
  assert.equal(resumeAuthenticatedLocalAccount(userId, started), false);
  assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), false, "even a new refresh cannot interrupt a pending server logout");
  confirmLocalSignOut(userId, fence);
  assert.equal(resumeAuthenticatedLocalAccount(userId, started), false);
  assert.equal(captureLocalWrite(userId), null);
  assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), true, "a fresh verified sign-in can resume its account");
});

test("an older failed logout cannot unblock another tab's newer removal fence", () => {
  const userId = "parallel-logout";
  const first = fenceLocalAccount(userId, false), second = fenceLocalAccount(userId, true);
  assert.equal(resumeLocalAccount(userId, first), false);
  confirmLocalSignOut(userId, first);
  assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), false);
  assert.equal(captureLocalWrite(userId), null);
  assert.equal(resumeLocalAccount(userId, second), true);
});

test("destructive cleanup fails closed when an account fence cannot be shared across tabs", async () => {
  const userId = "storage-removal-failure", projectId = "project";
  persistPendingDraft(userId, projectId, draft("keep until safe"));
  durable.failWrites = true;
  let requested = false;
  try {
    await assert.rejects(signOutAccount(userId, "remove", async () => { requested = true; }), /cannot safely be removed across tabs/);
    assert.equal(requested, false);
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "keep until safe");
  } finally { durable.failWrites = false; }
});

test("interrupted queued sends retain their bodies for revision-checked recovery", async () => {
  const userId = "interrupted-queue";
  const item = await offlineQueueStore.enqueue(userId, "project", "project_save", { name: "pending" }, 3);
  await offlineQueueStore.updateStatus(item.id, "syncing");
  const pending = await offlineQueueStore.getPendingQueue(userId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.name, "pending");
  assert.equal(pending[0].expectedRevision, 3);
});

test("discarding project edits removes interrupted saves without touching other projects or accounts", async () => {
  const userId = "discard-queued-edit";
  const discarded = await offlineQueueStore.enqueue(userId, "project", "project_save", { name: "discarded" }, 3);
  await offlineQueueStore.updateStatus(discarded.id, "syncing");
  const otherProject = await offlineQueueStore.enqueue(userId, "other-project", "project_save", { name: "kept" }, 3);
  const otherAccount = await offlineQueueStore.enqueue("keep-queued-edit", "project", "project_save", { name: "kept" }, 3);
  await offlineSyncManager.discardProjectSaves(userId, "project");
  assert.deepEqual((await offlineQueueStore.getPendingQueue(userId)).map(item => item.id), [otherProject.id]);
  assert.deepEqual((await offlineQueueStore.getPendingQueue("keep-queued-edit")).map(item => item.id), [otherAccount.id]);
});

test("offline sync saves the exact draft through the flat project API and acknowledges the new revision", async () => {
  const userId = "offline-sync-success", projectId = "project", originalFetch = globalThis.fetch;
  const pending = { ...draft("synced edit"), baseRevision: 3 };
  const designData = JSON.stringify(pending.design);
  const queued = await offlineQueueStore.enqueue(userId, projectId, "project_save", {
    name: pending.name, projectType: pending.projectType, widthMm: 4200, depthMm: 3700, designData, design: pending.design,
  }, pending.baseRevision);
  const oldProject = { id: projectId, accountId: userId, name: "server", projectType: pending.projectType, revision: 3, role: "editor", updatedAt: 1, design: null };
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/auth/me") return Response.json({ user: { id: userId } });
    assert.equal(String(input), "/api/projects/project");
    if (init?.method !== "PATCH") {
      assert.equal(new Headers(init?.headers).get("x-groundwork-account"), userId);
      return Response.json(oldProject);
    }
    body = JSON.parse(String(init.body));
    return Response.json({ ok: true, revision: 4 });
  }) as typeof fetch;
  let unsubscribeStatus: () => void = () => undefined;
  let acknowledge: { revision: number; exact: boolean; newer: boolean } | undefined;
  const unsubscribeSave = offlineSyncManager.subscribeProjectSaves((accountId, project, design) => {
    assert.equal(accountId, userId);
    acknowledge = {
      revision: project.revision,
      exact: draftMatchesSavedProject(pending, { ...project, design }),
      newer: draftMatchesSavedProject({ ...pending, name: "newer unsaved edit" }, { ...project, design }),
    };
  });
  try {
    offlineSyncManager.setActiveUser(userId);
    await new Promise<void>(resolve => {
      unsubscribeStatus = offlineSyncManager.subscribe(status => { if (!status.isSyncing) resolve(); });
    });
    assert.deepEqual(body, { name: pending.name, projectType: pending.projectType, widthMm: 4200, depthMm: 3700, designData, baseRevision: 3, expectedAccountId: userId });
    assert.deepEqual(acknowledge, { revision: 4, exact: true, newer: false });
    assert.equal((await offlineQueueStore.listQueue(userId)).find(item => item.id === queued.id)?.status, "completed");
    const cached = await offlineProjectStore.getCachedProject(userId, projectId);
    assert.equal(cached?.revision, 4);
    assert.equal(cached?.role, "editor");
    assert.equal(cached?.accountBound, true);
  } finally {
    unsubscribeSave(); unsubscribeStatus(); offlineSyncManager.setActiveUser(null); globalThis.fetch = originalFetch;
  }
});

test("a delayed synchronization response cannot recreate data after removal and resume", async () => {
  const userId = "late-sync", projectId = "project", originalFetch = globalThis.fetch;
  const body = draft("late response");
  await offlineQueueStore.enqueue(userId, projectId, "project_save", { name: body.name, design: body.design, projectType: "house" }, 3);
  let finishPatch!: (response: Response) => void, started!: () => void;
  const patchStarted = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/auth/me") return Response.json({ user: { id: userId } });
    if (init?.method === "PATCH") {
      started();
      // Deliberately ignore AbortSignal: a completed network response can still be delayed.
      return new Promise<Response>(resolve => { finishPatch = resolve; });
    }
    return Response.json({ id: projectId, accountId: userId, name: "server", revision: 3, projectType: "house" });
  }) as typeof fetch;
  let unsubscribe: () => void = () => undefined;
  try {
    offlineSyncManager.setActiveUser(userId);
    await patchStarted;
    const fence = fenceLocalAccount(userId, true);
    await removeLocalAccountData(userId);
    resumeLocalAccount(userId, fence);
    const finished = new Promise<void>(resolve => {
      unsubscribe = offlineSyncManager.subscribe(status => {
        if (!status.isSyncing) { offlineSyncManager.setActiveUser(null); resolve(); }
      });
    });
    finishPatch(Response.json({ ok: true, revision: 4 }));
    await finished;
    assert.deepEqual(offlineProjectStore.exportUserMemory(userId), []);
    assert.deepEqual(offlineQueueStore.exportUserMemory(userId), []);
    assert.deepEqual(exportAccountDrafts(userId), []);
  } finally {
    unsubscribe(); offlineSyncManager.setActiveUser(null); globalThis.fetch = originalFetch;
  }
});

test("a stalled logout request times out while keeping authenticated local recovery", async context => {
  const userId = "logout-timeout", originalFetch = globalThis.fetch;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  persistPendingDraft(userId, "project", draft("retain on timeout"));
  context.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  })) as typeof fetch;
  try {
    const rejected = assert.rejects(signOutAccount(userId, "preserve", requestLogout), /Sign-out was not confirmed; you are still signed in.*timed out/);
    await requestStarted;
    context.mock.timers.tick(20_000);
    await rejected;
    assert.notEqual(captureLocalWrite(userId), null);
    assert.equal(readPendingDraftResult(userId, "project").draft?.name, "retain on timeout");
  } finally { context.mock.timers.reset(); globalThis.fetch = originalFetch; }
});

test("a confirmed logout clears its deadline and retains CSRF protection", async context => {
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  setCsrfToken("test-csrf");
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, "/api/auth/logout");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), "test-csrf");
    signal = init?.signal;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    assert.deepEqual(await requestLogout(), { ok: true });
    context.mock.timers.tick(20_000);
    assert.equal(signal?.aborted, false);
  } finally { context.mock.timers.reset(); globalThis.fetch = originalFetch; setCsrfToken(null); }
});

test("a deliberate fresh sign-in recovers a cold-start unfinished keep-local fence", async () => {
  const userId = "cold-keep", projectId = "project";
  persistPendingDraft(userId, projectId, draft("crash recovery"));
  // A unique account has no in-memory fence: only the interrupted prior page's durable record survives.
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "previous-page", blocked: true, remove: false, signedOut: false }));
  const started = captureAuthenticationFences();
  assert.equal(resumeAuthenticatedLocalAccount(userId, started), false, "ordinary background refresh must not reopen a pending operation");
  assert.equal(await recoverLocalAccountAfterSignIn(userId, started), true);
  assert.notEqual(captureLocalWrite(userId), null);
  assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "crash recovery");
});

test("cold-start sign-in completes a previously consented removal before enabling writes", async () => {
  const userId = "cold-remove", other = "cold-retain", projectId = "project";
  persistPendingDraft(userId, projectId, draft("prior removal"));
  persistPendingDraft(other, projectId, draft("other account"));
  await offlineQueueStore.enqueue(userId, projectId, "project_save", { name: "prior queue" }, 1);
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "crashed-purge", blocked: true, remove: true, signedOut: false }));
  assert.equal(await recoverLocalAccountAfterSignIn(userId, captureAuthenticationFences()), true);
  assert.notEqual(captureLocalWrite(userId), null);
  assert.deepEqual(exportAccountDrafts(userId), []);
  assert.deepEqual(offlineQueueStore.exportUserMemory(userId), []);
  assert.equal(readPendingDraftResult(other, projectId).draft?.name, "other account");
});

test("duplicate sign-in recovery does not reopen a newer operation", async () => {
  const userId = "duplicate-recovery";
  fenceLocalAccount(userId, true);
  const started = captureAuthenticationFences();
  const first = recoverLocalAccountAfterSignIn(userId, started), second = recoverLocalAccountAfterSignIn(userId, started);
  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.notEqual(captureLocalWrite(userId), null);
});

test("a superseded live purge cannot delete fresh data after sign-in recovery", async () => {
  const userId = "purge-race", original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const opens: { release: () => void }[] = [], values = new Map<string, Record<string, unknown>>();
  const storesByDatabase: Record<string, string[]> = {
    groundwork_offline_projects_v2: ["cached_projects", "cached_snapshots"],
    groundwork_offline_queue_v2: ["queue_items"],
    "groundwork-workspaces": ["drafts"],
  };
  for (const [database, stores] of Object.entries(storesByDatabase)) for (const store of stores) values.set(`${database}/${store}`, { userId, content: "old data" });
  const factory = {
    open(database: string) {
      const request: Record<string, any> = {};
      const db = {
        objectStoreNames: { contains: (store: string) => storesByDatabase[database].includes(store) }, close() {},
        transaction(stores: string[]) {
          let remaining = stores.length, aborted = false;
          const tx: Record<string, any> = {
            abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
            objectStore(store: string) {
              return { openCursor() {
                const cursorRequest: Record<string, any> = {}, key = `${database}/${store}`;
                const step = () => {
                  if (aborted) return;
                  const value = values.get(key);
                  cursorRequest.result = value ? { key: [userId, "project"], value, delete: () => values.delete(key), continue: () => queueMicrotask(step) } : null;
                  cursorRequest.onsuccess?.();
                  if (!value && --remaining === 0) queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); });
                };
                queueMicrotask(step); return cursorRequest;
              } };
            },
          };
          return tx;
        },
      };
      opens.push({ release: () => queueMicrotask(() => { request.result = db; request.onsuccess?.(); }) });
      return request;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  try {
    const oldToken = fenceLocalAccount(userId, true);
    const oldPurge = removeLocalAccountData(userId, oldToken);
    const oldRejected = assert.rejects(oldPurge, /superseded by a newer account operation/);
    assert.equal(opens.length, 3);
    const recovery = recoverLocalAccountAfterSignIn(userId, captureAuthenticationFences());
    assert.equal(opens.length, 6);
    assert.equal(captureLocalWrite(userId), null, "writes remain blocked throughout replacement cleanup");
    for (const open of opens.slice(3)) open.release();
    assert.equal(await recovery, true);
    values.set("groundwork-workspaces/drafts", { userId, content: "fresh sign-in data" });
    for (const open of opens.slice(0, 3)) open.release();
    await oldRejected;
    assert.equal(values.get("groundwork-workspaces/drafts")?.content, "fresh sign-in data");
    confirmLocalSignOut(userId, oldToken);
    assert.equal(resumeLocalAccount(userId, oldToken), false);
    assert.notEqual(captureLocalWrite(userId), null);
    assert.equal(values.get("groundwork-workspaces/drafts")?.content, "fresh sign-in data");
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("delayed removal notifications clear stale tab recovery while preserving fresh shared data", () => {
  const userId = "suspended-tab", projectId = "project";
  persistPendingDraft(userId, projectId, draft("stale memory"));
  const oldWrite = captureLocalWrite(userId);
  const oldLocal = exportAccountDrafts(userId).find(record => record.storage === "local")!;
  session.setItem(`groundwork:draft:${userId}:${projectId}`, JSON.stringify(draft("stale session")));
  // Other tab's completed purge removed shared old records, then its fresh sign-in wrote new ones.
  durable.removeItem(oldLocal.key);
  const freshKey = `groundwork:draft:v2:${userId}:${projectId}:fresh-tab`;
  durable.setItem(freshKey, JSON.stringify({ ...draft("fresh shared recovery"), savedAt: Date.now() + 1 }));
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "new-sign-in", blocked: false, remove: false, signedOut: false, lastRemoval: "removed-while-suspended" }));
  let staleNotices = 0;
  const unsubscribe = subscribeLocalDataFence((account, fence) => { if (account === userId && fence.localOnly) staleNotices++; });
  try {
    // Both queued browser storage events now see the same latest resumed durable fence.
    synchronizeLocalAccountFence(userId); synchronizeLocalAccountFence(userId);
    assert.equal(staleNotices, 1);
    assert.equal(session.getItem(`groundwork:draft:${userId}:${projectId}`), null);
    assert.ok(durable.getItem(freshKey), "new shared recovery must survive delayed notification handling");
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "fresh shared recovery");
    assert.equal(captureLocalWrite(userId), null, "stale tab writes wait for verified authentication");
    assert.equal(localWriteAllowed(userId, oldWrite), false);
    assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), true);
    assert.equal(captureLocalWrite(userId), "new-sign-in");
    assert.equal(localAccountFence(userId).lastRemoval, "removed-while-suspended");
  } finally { unsubscribe(); }
});

test("lazy recovery subscriptions replay a remembered removal without touching shared storage", () => {
  const userId = "lazy-recovery";
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "resumed", blocked: false, remove: false, signedOut: false, lastRemoval: "prior-removal" }));
  localAccountFence(userId);
  resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences());
  let replayed = false;
  const unsubscribe = subscribeLocalDataFence((account, fence) => {
    if (account !== userId) return;
    assert.equal(fence.localOnly, true); assert.equal(fence.remove, true); assert.equal(fence.signedOut, false);
    replayed = true;
  }, true);
  unsubscribe();
  assert.equal(replayed, true);
  assert.equal(localAccountFence(userId).lastRemoval, "prior-removal");
});

test("a fresh session-only draft survives reload after an earlier completed removal", () => {
  const userId = "fresh-session-reload", projectId = "project";
  // Emulate a prior page's quota fallback, with a brand-new in-memory account identity on this page.
  const fresh = { ...draft("newer session recovery"), removalGeneration: "completed-earlier-removal" };
  session.setItem(`groundwork:draft:${userId}:${projectId}`, JSON.stringify(fresh));
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "verified-resume", blocked: false, remove: false, signedOut: false, lastRemoval: fresh.removalGeneration }));
  const started = captureAuthenticationFences();
  assert.equal(resumeAuthenticatedLocalAccount(userId, started), true);
  const recovered = readPendingDraftResult(userId, projectId);
  assert.equal(recovered.source, "session");
  assert.equal(recovered.draft?.name, fresh.name);
  assert.equal(recovered.draft?.removalGeneration, fresh.removalGeneration);
  assert.ok(session.getItem(`groundwork:draft:${userId}:${projectId}`));
});

test("quota fallback stamps fresh session recovery without requiring an acknowledgement write", () => {
  const userId = "quota-generation", projectId = "project", removal = "earlier-removal";
  durable.setItem(`groundwork:local-data-fence:v1:${userId}`, JSON.stringify({ token: "resumed-after-removal", blocked: false, remove: false, signedOut: false, lastRemoval: removal }));
  assert.equal(resumeAuthenticatedLocalAccount(userId, captureAuthenticationFences()), true);
  durable.failWrites = true;
  try {
    const saved = persistPendingDraft(userId, projectId, draft("fresh quota fallback"));
    assert.equal(saved.stored, true); assert.equal(saved.durable, false);
    const record = exportAccountDrafts(userId).find(value => value.storage === "session")!;
    assert.equal(JSON.parse(record.value).removalGeneration, removal);
    const unsubscribe = subscribeLocalDataFence((account, fence) => {
      if (account === userId && fence.localOnly) removeAccountDrafts(account, true, fence.lastRemoval);
    }, true);
    unsubscribe();
    assert.ok(session.getItem(record.key));
    assert.equal(readPendingDraftResult(userId, projectId).draft?.name, "fresh quota fallback");
  } finally { durable.failWrites = false; }
});
