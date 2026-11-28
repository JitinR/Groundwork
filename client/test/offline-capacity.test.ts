import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CacheCapacityError, planCacheWrite, type CapacityProject } from "../src/lib/cacheCapacity.ts";
import { offlineProjectStore } from "../src/lib/offlineProjectStore.ts";
import type { Design, Project } from "../src/types.ts";
import { offlineQueueStore } from "../src/lib/offlineQueue.ts";
import { persistPendingDraft, removeAccountDrafts } from "../src/lib/offlineDraft.ts";

const budget = { maxBytes: 1000, maxProjects: 50, maxSnapshots: 10 };
const project = (index: number, sizeBytes = 10): CapacityProject => ({ projectId: `p${index}`, sizeBytes, lastAccessedAt: index });
for (const count of [49, 50, 51]) test(`new cache entry at ${count} removes only the excess oldest projects`, () => {
  const records = Array.from({ length: count }, (_, index) => project(index));
  const plan = planCacheWrite(records, [], { project: project(100) }, new Set(), budget);
  assert.equal(plan.projectedCount, 50);
  assert.deepEqual(plan.removeProjects, Array.from({ length: Math.max(0, count + 1 - 50) }, (_, i) => `p${i}`));
  assert.equal(records.length, count, "planning never mutates retained records");
});
test("replacement counts only the size delta and never evicts itself", () => {
  const records = Array.from({ length: 50 }, (_, i) => project(i));
  assert.deepEqual(planCacheWrite(records, [], { project: project(0, 500) }, new Set(), budget).removeProjects, []);
  const plan = planCacheWrite(records, [], { project: project(0, 530) }, new Set(), budget);
  assert.deepEqual(plan.removeProjects, ["p1", "p2"]);
  assert.equal(plan.projectedBytes, 1000);
});
test("snapshot bytes participate in capacity and leave protected projects intact", () => {
  const records = [project(0, 300), project(1, 300)];
  const snapshots = [{ projectId: "p0", snapshotId: "s0", sizeBytes: 300, createdAt: 1 }];
  const plan = planCacheWrite(records, snapshots, { project: project(2, 200) }, new Set(["p1"]), budget);
  assert.deepEqual(plan.removeProjects, ["p0"]);
  assert.deepEqual(plan.removeSnapshots, snapshots);
  assert.equal(plan.projectedBytes, 500);
});
test("an impossible budget fails before deleting any recovery copy", () => {
  const records = Array.from({ length: 50 }, (_, i) => project(i));
  assert.throws(() => planCacheWrite(records, [], { project: project(100) }, new Set(records.map(p => p.projectId)), budget), CacheCapacityError);
  assert.throws(() => planCacheWrite(records, [], { project: project(100, 1001) }, new Set(), budget), CacheCapacityError);
  assert.equal(records.length, 50);
});
test("snapshot replacement preserves count; new snapshots retire only the oldest", () => {
  const snapshots = Array.from({ length: 10 }, (_, i) => ({ projectId: "p0", snapshotId: `s${i}`, sizeBytes: 10, createdAt: i }));
  assert.deepEqual(planCacheWrite([project(0)], snapshots, { snapshot: { ...snapshots[0], sizeBytes: 20 } }, new Set(), budget).removeSnapshots, []);
  const next = { projectId: "p0", snapshotId: "s10", sizeBytes: 20, createdAt: 10 };
  assert.deepEqual(planCacheWrite([project(0)], snapshots, { snapshot: next }, new Set(), budget).removeSnapshots.map(s => s.snapshotId), ["s0"]);
  assert.throws(() => planCacheWrite([project(0)], snapshots, { snapshot: next }, new Set(["p0"]), budget), CacheCapacityError);
});
test("repeated memory-only cache writes stay bounded and account scoped", async () => {
  const userId = "cache-boundary-owner", other = "cache-boundary-other";
  const design = { room: { widthMm: 5000, depthMm: 4000 }, furniture: [] } as unknown as Design;
  const fixture = (id: string) => ({ id, name: id, projectType: "house", revision: 1, role: "owner" }) as Project;
  await offlineProjectStore.cacheProject(other, fixture("private-other"), design);
  for (let i = 0; i < 55; i++) await offlineProjectStore.cacheProject(userId, fixture(`owned-${i}`), design);
  assert.equal(offlineProjectStore.exportUserMemory(userId).length, 50);
  assert.equal(offlineProjectStore.exportUserMemory(other).length, 1);
  for (let i = 5; i < 55; i++) await offlineProjectStore.cacheProject(userId, fixture(`owned-${i}`), design);
  assert.equal(offlineProjectStore.exportUserMemory(userId).length, 50, "replacing fifty records does not evict any");
  offlineProjectStore.clearActiveUserSession(userId); offlineProjectStore.clearActiveUserSession(other);
});

test("ordinary cache writes automatically retain queued, failed and draft recovery projects", async () => {
  const userId = "cache-automatic-recovery-owner";
  const design = { room: { widthMm: 5000, depthMm: 4000 }, furniture: [] } as unknown as Design;
  const fixture = (id: string) => ({ id, name: id, projectType: "house", revision: 1, role: "owner" }) as Project;
  for (let i = 0; i < 50; i++) await offlineProjectStore.cacheProject(userId, fixture(`recovery-${i}`), design);
  const queued = await offlineQueueStore.enqueue(userId, "recovery-0", "project_save", { design }, 1);
  const failed = await offlineQueueStore.enqueue(userId, "recovery-1", "project_save", { design }, 1);
  await offlineQueueStore.updateStatus(failed.id, "failed", "Needs a manual retry");
  persistPendingDraft(userId, "recovery-2", { design, name: "Unsaved draft", projectType: "house", baseRevision: 1, savedAt: Date.now() });
  // The draft is still protected when durable/session storage is unavailable and it exists only in memory.
  await offlineProjectStore.cacheProject(userId, fixture("incoming"), design);
  const retained = new Set(offlineProjectStore.exportUserMemory(userId).map(item => item.projectId));
  assert.equal(retained.size, 50);
  assert.ok(retained.has("recovery-0")); assert.ok(retained.has("recovery-1")); assert.ok(retained.has("recovery-2"));
  assert.ok(retained.has("incoming"), "an eligible old copy makes room without evicting a recovery project");
  await offlineQueueStore.discardItem(queued.id); await offlineQueueStore.discardItem(failed.id);
  removeAccountDrafts(userId); offlineProjectStore.clearActiveUserSession(userId);
});

test("offline loads require an account-bound and server-confirmed project copy", async () => {
  const userId = "cached-project-owner";
  const legacy = { userId, projectId: "legacy-copy" };
  const possiblyUnsaved = { userId, projectId: "old-bound-copy", accountBound: true, lastAccessedAt: 1 };
  const verified = { userId, projectId: "verified-copy", accountBound: true, serverConfirmed: true, lastAccessedAt: 1 };
  const stored = [legacy, possiblyUnsaved, verified];
  const request = (result: unknown) => {
    const pending: { result: unknown; onsuccess?: () => void } = { result };
    queueMicrotask(() => pending.onsuccess?.());
    return pending;
  };
  const store = {
    get: ([, projectId]: string[]) => request(stored.find(record => record.projectId === projectId)),
    index: () => ({ getAll: () => request(stored) }),
    put: () => undefined,
  };
  const db = { transaction: () => ({ objectStore: () => store }), close: () => undefined, onversionchange: () => undefined };
  const factory = { open: () => request(db) };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { indexedDB: factory } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  try {
    assert.equal(await offlineProjectStore.getCachedProject(userId, legacy.projectId), null);
    assert.equal(await offlineProjectStore.getCachedProject(userId, possiblyUnsaved.projectId), null);
    assert.equal((await offlineProjectStore.getCachedProject(userId, verified.projectId))?.projectId, verified.projectId);
    const listed = await offlineProjectStore.listCachedProjects(userId);
    assert.deepEqual(listed.map(project => project.projectId), [possiblyUnsaved.projectId, verified.projectId]);
  } finally {
    db.onversionchange();
    offlineProjectStore.clearActiveUserSession(userId);
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB); else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("a later cache write cannot replace a more recently saved project revision", async () => {
  const userId = "cached-project-revision-owner";
  const design = { room: { widthMm: 5000, depthMm: 4000 }, furniture: [] } as unknown as Design;
  const project = { id: "cache-project", name: "Saved project", projectType: "house", revision: 8, role: "editor", hasPhoto: true } as const;
  try {
    await offlineProjectStore.cacheProject(userId, project, design);
    await offlineProjectStore.cacheProject(userId, { ...project, revision: 7, name: "Older response", hasPhoto: false }, design);
    const cached = await offlineProjectStore.getCachedProject(userId, project.id);
    assert.equal(cached?.revision, 8);
    assert.equal(cached?.name, "Saved project");
    assert.equal(cached?.role, "editor");
    assert.equal(cached?.hasPhoto, true);
  } finally { offlineProjectStore.clearActiveUserSession(userId); }
});

test("an unreadable durable queue preserves every cached copy instead of evicting from a partial memory view", async (context) => {
  const userId = "cache-unreadable-queue-owner";
  const design = { room: { widthMm: 5000, depthMm: 4000 }, furniture: [] } as unknown as Design;
  const fixture = (id: string) => ({ id, name: id, projectType: "house", revision: 1, role: "owner" }) as Project;
  for (let i = 0; i < 50; i++) await offlineProjectStore.cacheProject(userId, fixture(`retained-${i}`), design);
  const before = offlineProjectStore.exportUserMemory(userId).map(item => item.projectId);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  // The queue's IndexedDB opening is unavailable; ordinary list consumers may still use memory.
  const factory = { open: () => { throw new Error("Durable recovery queue unavailable"); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { indexedDB: factory } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  context.mock.method(console, "warn", () => {});
  try {
    assert.deepEqual(await offlineQueueStore.listQueue(userId), []);
    await assert.rejects(offlineQueueStore.listQueue(userId, undefined, { requireDurable: true }));
    await offlineProjectStore.cacheProject(userId, fixture("incoming"), design);
    assert.deepEqual(offlineProjectStore.exportUserMemory(userId).map(item => item.projectId), before);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB); else Reflect.deleteProperty(globalThis, "indexedDB");
    offlineProjectStore.clearActiveUserSession(userId);
  }
});

test("a blocked cache upgrade settles promptly, closes a late connection and allows retry", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const requests: Record<string, unknown>[] = [];
  const factory = { open: () => { const request: Record<string, unknown> = {}; requests.push(request); return request; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { indexedDB: factory } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  try {
    const result = offlineProjectStore.listCachedProjects("blocked-upgrade-owner");
    (requests[0].onblocked as () => void)();
    assert.deepEqual(await result, []);
    let closed = 0;
    requests[0].result = { close: () => { closed++; } };
    (requests[0].onsuccess as () => void)();
    assert.equal(closed, 1, "a connection received after rejection is never retained");
    const retry = offlineProjectStore.listCachedProjects("blocked-upgrade-owner");
    assert.equal(requests.length, 2);
    (requests[1].onerror as () => void)();
    assert.deepEqual(await retry, []);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB); else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("an unresponsive browser cache open times out without retaining its promise", async (context) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let opens = 0;
  const factory = { open: () => { opens++; return {}; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { indexedDB: factory } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  try {
    const result = offlineProjectStore.listCachedProjects("timed-out-owner");
    context.mock.timers.tick(10_000);
    assert.deepEqual(await result, []);
    const retry = offlineProjectStore.listCachedProjects("timed-out-owner");
    assert.equal(opens, 2);
    context.mock.timers.tick(10_000);
    assert.deepEqual(await retry, []);
  } finally {
    context.mock.timers.reset();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB); else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
