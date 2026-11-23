import assert from "node:assert/strict";
import { test } from "node:test";
import { getMe, logout, request, setCsrfToken } from "../src/api.ts";
import { fetchJsonResponse, readResponseJson, retryAfterDelay, syncRetryDelay, withRequestTimeout } from "../src/lib/requestResilience.ts";
import { CoordinationSync } from "../src/lib/operationSync.ts";

test("finite browser requests compose cancellation and retain credentials and CSRF", async () => {
  const original = globalThis.fetch; const caller = new AbortController();
  setCsrfToken("isolated-token");
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), "isolated-token");
    signal = init?.signal;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    assert.deepEqual(await request("/api/test", { method: "POST", body: "{}", signal: caller.signal }), { ok: true });
    caller.abort(); assert.equal(signal?.aborted, false, "finished requests remove caller listeners");
    await logout();
  } finally { globalThis.fetch = original; setCsrfToken(null); }
});

test("a browser deadline cancels an ignored connection and a stalled streamed body", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(withRequestTimeout(async deadline => { signal = deadline; return new Promise(() => undefined); }, undefined, 10), /timed out/);
  assert.equal(signal?.aborted, true);
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); }, cancel() { cancelled = true; } }));
  await assert.rejects(withRequestTimeout(deadline => readResponseJson(stalled, deadline), undefined, 10), /timed out/);
  assert.equal(cancelled, true);
  const caller = new AbortController();
  caller.abort(new Error("account changed"));
  let started = false;
  await assert.rejects(withRequestTimeout(async () => { started = true; }, caller.signal), /account changed/);
  assert.equal(started, false);
});

test("browser HTTP errors preserve Retry-After and ordinary 401 bootstrap behavior", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "retry-after": "7" } })) as typeof fetch;
  try {
    await assert.rejects(request("/api/test"), (error: unknown) => error instanceof Error && "retryAfterMs" in error && error.retryAfterMs === 7000 && error.message === "slow down");
    globalThis.fetch = (async () => Response.json({ error: "signed out" }, { status: 401 })) as typeof fetch;
    assert.equal(await getMe(), null);
    const result = await fetchJsonResponse("/api/test"); assert.equal(result.response.status, 401);
  } finally { globalThis.fetch = original; }
});

test("synchronization backoff is bounded and honors server recovery intervals", () => {
  assert.equal(syncRetryDelay(1, 0, () => 0), 250);
  assert.equal(syncRetryDelay(2, 0, () => 1), 2250);
  assert.equal(syncRetryDelay(100, 0, () => 1), 60250);
  assert.equal(syncRetryDelay(2, 15000, () => 0), 15000);
  assert.equal(syncRetryDelay(2, 3600000), Number.POSITIVE_INFINITY, "long server pauses require explicit retry instead of shortening Retry-After");
  assert.equal(retryAfterDelay("2"), 2000);
  assert.equal(retryAfterDelay("invalid"), undefined);
});

test("coordination synchronization caps automatic retries while preserving queued edits and permits explicit recovery", async context => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), originalFetch = globalThis.fetch;
  const values = new Map<string, string>();
  const userId = "retry-user", projectId = "retry-project";
  const operation = { operationId: "operation-123", clientId: "client-123", logicalClock: 1, entityId: "issue", field: "title", value: "retained edit" };
  values.set(`groundwork:coordination-operation:v1:${userId}:${projectId}:${operation.operationId}`, JSON.stringify(operation));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ error: "busy" }, { status: 503 }); }) as typeof fetch;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sync = new CoordinationSync(userId, projectId, () => undefined);
  try {
    await sync.start();
    for (let attempt = 1; attempt < 6; attempt += 1) { context.mock.timers.tick(61_000); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(calls, 6); assert.equal(sync.status().pending, 1); assert.match(sync.status().error ?? "", /automatic retries paused/);
    context.mock.timers.tick(61_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 6);
    await sync.synchronize(); assert.equal(calls, 7); assert.equal(sync.status().pending, 1);
    assert.match(sync.exportQueue(), /retained edit/);
  } finally {
    sync.stop(); context.mock.timers.reset(); globalThis.fetch = originalFetch;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a lost offline save acknowledgement rechecks server revision before sending again", async () => {
  const { offlineQueueStore } = await import("../src/lib/offlineQueue.ts");
  const { offlineSyncManager } = await import("../src/lib/offlineSyncManager.ts");
  const originalFetch = globalThis.fetch, userId = "lost-save-user", projectId = "lost-save-project";
  let reads = 0, patches = 0;
  const queued = await offlineQueueStore.enqueue(userId, projectId, "project_save", { name: "retain uncertain save" }, 3);
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/auth/me") return Response.json({ user: { id: userId } });
    if (init?.method === "PATCH") { patches += 1; throw new TypeError("connection lost after commit"); }
    reads += 1;
    return Response.json({ id: projectId, name: "server", revision: reads === 1 ? 3 : 4 });
  }) as typeof fetch;
  let unsubscribe = () => undefined;
  try {
    offlineSyncManager.setActiveUser(userId);
    await new Promise<void>(resolve => { unsubscribe = offlineSyncManager.subscribe(status => { if (!status.isSyncing) resolve(); }); });
    assert.equal((await offlineQueueStore.getPendingQueue(userId))[0].status, "queued");
    await offlineSyncManager.synchronize(userId, true);
    assert.equal(patches, 1, "an ambiguous PATCH must not be blindly replayed"); assert.equal(reads, 2);
    const saved = (await offlineQueueStore.listQueue(userId)).find(item => item.id === queued.id);
    assert.equal(saved?.status, "conflicted"); assert.equal(saved?.payload.name, "retain uncertain save");
  } finally { unsubscribe(); offlineSyncManager.setActiveUser(null); globalThis.fetch = originalFetch; }
});
