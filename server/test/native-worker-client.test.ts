import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startDedicatedNativeWorker, type NativeWorkerClaim, type NativeWorkerDiagnostic, type NativeWorkerExecutor, type NativeWorkerExecutorResult } from "../src/nativeWorkerClient.js";
import { NativeWorkerConfigurationError, readNativeWorkerClientConfiguration, requireUnprivilegedNativeWorkerStatus, validateNativeWorkerClientConfiguration } from "../src/nativeWorkerClientConfig.js";

const CHUNK = 256 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const configuration = {
  authorityOrigin: "https://authority.example.test", workerId: "worker-fixture", token: "t".repeat(43),
  kinds: ["dxf-to-dwg"] as const, executorSocketPath: "/run/groundwork-native/executor.sock",
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker client test exceeded its bounded wait")), 2500); })]); }
  finally { clearTimeout(timer); }
}
const onAbort = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
interface Call { url: string; init: RequestInit; body: Record<string, any>; suffix: string }
function fixture() {
  const input = Buffer.alloc(CHUNK + 19, 7), output = Buffer.alloc(CHUNK + 31, 11);
  const claim: NativeWorkerClaim = { version: 1, jobId: "a".repeat(32), projectId: "project-fixture", kind: "dxf-to-dwg", sourceArtifactId: "b".repeat(32), sourceSha256: hash(input), inputBytes: input.length, grant: "g".repeat(64) + "." + "s".repeat(43) };
  const result: NativeWorkerExecutorResult = { artifacts: [{ filename: "converted.dwg", mediaType: "image/vnd.dwg", bytes: output, sha256: hash(output) }],
    summary: { kind: claim.kind, adapter: "LibreDWG", declaredVersion: "0.13.4", sourceArtifactId: claim.sourceArtifactId, sourceSha256: claim.sourceSha256, verification: "computed-unvalidated", warnings: ["Synthetic fixture only"] } };
  const calls: Call[] = [], reports: NativeWorkerDiagnostic[] = [], uploaded: Buffer[] = [], succeeded = deferred<void>(), failed = deferred<void>(), unavailable = deferred<void>();
  let offered = false, active = true;
  const report = (code: NativeWorkerDiagnostic) => { reports.push(code); if (code === "job_succeeded") succeeded.resolve(); if (code === "job_failed" || code === "executor_unavailable") failed.resolve(); if (code === "authority_unavailable") unavailable.resolve(); };
  const request: typeof fetch = async (url, init = {}) => {
    const suffix = new URL(String(url)).pathname.replace("/api/native-worker/v1", "");
    const body = JSON.parse(String(init.body || "{}")) as Record<string, any>;
    calls.push({ url: String(url), init, body, suffix });
    if (suffix === "/claim") { const next = offered ? null : structuredClone(claim); offered = true; return Response.json({ claim: next }); }
    if (suffix.endsWith("/renew")) return Response.json({ active });
    if (suffix.endsWith("/input")) { const bytes = input.subarray(body.offset, body.offset + CHUNK); return Response.json({ offset: body.offset, bytes: bytes.toString("base64"), sha256: hash(bytes), totalBytes: input.length }); }
    if (suffix.endsWith("/output")) { const bytes = Buffer.from(body.bytes, "base64"); uploaded.push(bytes); return Response.json({ accepted: true, nextOffset: body.offset + bytes.length }); }
    if (suffix.endsWith("/complete") || suffix.endsWith("/fail")) return Response.json({ accepted: true });
    assert.fail("Unexpected fixture request");
  };
  return { input, output, claim, result, calls, reports, uploaded, request, report, succeeded, failed, unavailable, loseLease() { active = false; } };
}

test("worker transfers measured chunks, publishes only validated outputs and never gives the executor queue authority", async t => {
  const f = fixture(); let executed: unknown;
  const worker = startDedicatedNativeWorker(configuration, { request: f.request, report: f.report, execute: async request => { executed = request; return f.result; }, pollMs: 1000 });
  t.after(() => worker.stop());
  await within(f.succeeded.promise); await worker.stop();
  assert.deepEqual(Buffer.concat(f.uploaded), f.output);
  assert.equal(f.calls.filter(call => call.suffix.endsWith("/input")).length, 2);
  assert.equal(f.calls.filter(call => call.suffix.endsWith("/output")).length, 2);
  assert.equal(f.calls.filter(call => call.suffix.endsWith("/complete")).length, 1);
  assert.equal(f.calls.some(call => call.suffix.endsWith("/fail")), false);
  assert.deepEqual(executed, { version: 1, jobId: f.claim.jobId, kind: f.claim.kind, input: { bytes: f.input, sourceArtifactId: f.claim.sourceArtifactId, sha256: f.claim.sourceSha256 } });
  const serialized = JSON.stringify(executed);
  for (const secret of [configuration.token, f.claim.grant, f.claim.projectId]) assert.equal(serialized.includes(secret), false);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, configuration.authorityOrigin);
    assert.equal(call.init.method, "POST"); assert.equal(call.init.redirect, "error"); assert.equal(call.init.credentials, "omit");
    assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${configuration.token}`);
    assert.equal(new Headers(call.init.headers).get("x-groundwork-worker-id"), configuration.workerId);
    assert.equal(new Headers(call.init.headers).has("cookie"), false);
  }
});

test("publication uses byte/summary snapshots even if the executor retains mutable result objects", async t => {
  const f = fixture(), expected = Buffer.from(f.output);
  const request: typeof fetch = async (url, init) => {
    const response = await f.request(url, init);
    if (String(url).endsWith("/output")) { f.output.fill(55); f.result.summary.sourceSha256 = "f".repeat(64); }
    return response;
  };
  const worker = startDedicatedNativeWorker(configuration, { request, report: f.report, execute: async () => f.result });
  t.after(() => worker.stop()); await within(f.succeeded.promise); await worker.stop();
  assert.deepEqual(Buffer.concat(f.uploaded), expected);
  assert.equal(f.calls.find(call => call.suffix.endsWith("/complete"))!.body.summary.sourceSha256, f.claim.sourceSha256);
});

test("invalid input sequence, base64, chunk hash and whole-source binding never reach the executor", async () => {
  for (const mutation of [
    (value: Record<string, any>) => { value.offset++; },
    (value: Record<string, any>) => { value.bytes += "\n"; },
    (value: Record<string, any>) => { value.sha256 = "f".repeat(64); },
    (value: Record<string, any>) => { value.totalBytes++; },
  ]) {
    const f = fixture(); let executed = false;
    const worker = startDedicatedNativeWorker(configuration, { report: f.report, request: async (url, init) => {
      const response = await f.request(url, init);
      if (String(url).endsWith("/input")) { const value = await response.json() as Record<string, any>; mutation(value); return Response.json(value); }
      return response;
    }, execute: async () => { executed = true; return f.result; } });
    try {
      await within(f.failed.promise);
      assert.equal(executed, false);
      assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false);
      assert.equal(f.calls.find(call => call.suffix.endsWith("/fail"))!.body.code, "INPUT_INVALID");
    } finally { await worker.stop(); }
  }
  const f = fixture(); f.claim.sourceSha256 = "e".repeat(64); let executed = false;
  const worker = startDedicatedNativeWorker(configuration, { request: f.request, report: f.report, execute: async () => { executed = true; return f.result; } });
  try { await within(f.failed.promise); assert.equal(executed, false); }
  finally { await worker.stop(); }
});

test("malformed or out-of-scope claims are refused before allocation or execution", async () => {
  for (const mutation of [
    { inputBytes: 32 * 1024 * 1024 + 1 }, { kind: "opensees-static" }, { sourceArtifactId: "../source" },
    { grant: "a.b.c" }, { submittingSession: "must-not-enter-worker" },
  ]) {
    const f = fixture(); Object.assign(f.claim, mutation); let executed = false;
    const worker = startDedicatedNativeWorker(configuration, { request: f.request, report: f.report, execute: async () => { executed = true; return f.result; } });
    try { await within(f.unavailable.promise); assert.equal(executed, false); assert.equal(f.calls.length, 1); }
    finally { await worker.stop(); }
  }
});

test("invalid output hashes, source bindings, filenames and result verification are never uploaded", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.result.artifacts[0].sha256 = "f".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.result.artifacts[0].filename = "../private"; },
    (f: ReturnType<typeof fixture>) => { f.result.artifacts[0].mediaType = "application/x-executable"; },
    (f: ReturnType<typeof fixture>) => { f.result.summary.sourceArtifactId = "f".repeat(32); },
    (f: ReturnType<typeof fixture>) => { (f.result.summary as any).verification = "certified"; },
    (f: ReturnType<typeof fixture>) => { f.result.artifacts = Array.from({ length: 9 }, () => f.result.artifacts[0]); },
  ]) {
    const f = fixture(); mutate(f);
    const worker = startDedicatedNativeWorker(configuration, { request: f.request, report: f.report, execute: async () => f.result });
    try { await within(f.failed.promise); assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false); }
    finally { await worker.stop(); }
  }
});

test("lease loss aborts executor work and fences all output publication", async t => {
  const f = fixture(), executing = deferred<void>(); let observedAbort = false;
  const worker = startDedicatedNativeWorker(configuration, { request: f.request, report: f.report, heartbeatMs: 2, execute: async (_request, signal) => {
    executing.resolve(); await onAbort(signal); observedAbort = signal.aborted; return f.result;
  } });
  t.after(() => worker.stop()); await within(executing.promise); f.loseLease(); await within(f.failed.promise); await worker.stop();
  assert.equal(observedAbort, true); assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false);
  assert.equal(f.calls.find(call => call.suffix.endsWith("/fail"))!.body.code, "WORKER_STOPPED");
});

test("stopping during an input body cancels the read and leaves no executor or publication request", async t => {
  const f = fixture(), receiving = deferred<void>(); let cancelled = false, executed = false;
  const worker = startDedicatedNativeWorker(configuration, { report: f.report, request: async (url, init) => {
    if (!String(url).endsWith("/input")) return f.request(url, init);
    receiving.resolve(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("{")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  }, execute: async () => { executed = true; return f.result; } });
  t.after(() => worker.stop()); await within(receiving.promise); const first = worker.stop(); assert.equal(worker.stop(), first); await within(first);
  assert.equal(cancelled, true); assert.equal(executed, false); assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false);
});

test("request deadline covers a stalled connection or streamed body, with one attempt and fixed diagnostics", async () => {
  for (const stalledBody of [false, true]) {
    const f = fixture(); let calls = 0, cancelled = false, connectionSignal: AbortSignal | undefined;
    const diagnostics: unknown[][] = [];
    const worker = startDedicatedNativeWorker(configuration, { requestTimeoutMs: 10, report: (...args) => { diagnostics.push(args); f.report(args[0]); }, request: async (_url, init) => {
      calls++; connectionSignal = init?.signal as AbortSignal;
      if (!stalledBody) return new Promise<Response>(() => undefined);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"private":"provider-credential')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    }, execute: async () => f.result });
    try {
      await within(f.unavailable.promise);
      assert.equal(calls, 1); assert.equal(connectionSignal?.aborted, true); if (stalledBody) assert.equal(cancelled, true);
      assert.ok(diagnostics.every(args => args.length === 1));
      assert.equal(JSON.stringify(diagnostics).includes("provider-credential"), false);
      assert.equal(JSON.stringify(diagnostics).includes(configuration.token), false);
    } finally { await worker.stop(); }
  }
});

test("a response arriving after its request deadline still has its body cancelled", async () => {
  const f = fixture(), response = deferred<Response>(), cancelled = deferred<void>();
  const worker = startDedicatedNativeWorker(configuration, { requestTimeoutMs: 10, report: f.report, request: async () => response.promise, execute: async () => f.result });
  try {
    await within(f.unavailable.promise);
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } }), { headers: { "content-type": "application/json" } }));
    await within(cancelled.promise);
    assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false);
  } finally { await worker.stop(); }
});

test("OpenSees results require the declared planar dimension and load-combination binding", async () => {
  for (const missing of ["dimension", "combinationId"] as const) {
    const f = fixture(); f.claim.kind = "opensees-static";
    Object.assign(f.result.summary, { kind: "opensees-static", adapter: "OpenSees", declaredVersion: "3.8.0", dimension: "planar-2d", combinationId: "fixture-case" });
    delete f.result.summary[missing];
    const worker = startDedicatedNativeWorker({ ...configuration, kinds: ["opensees-static"] }, { request: f.request, report: f.report, execute: async () => f.result });
    try { await within(f.failed.promise); assert.equal(f.calls.some(call => /\/(output|complete)$/.test(call.suffix)), false); }
    finally { await worker.stop(); }
  }
});

test("oversized and redirected authority responses are rejected without follow-up requests", async () => {
  for (const bad of ["stream", "redirect", "origin"] as const) {
    const f = fixture(); let calls = 0, cancelled = false;
    const worker = startDedicatedNativeWorker(configuration, { report: f.report, request: async (_url, init) => {
      calls++; assert.equal(init?.redirect, "error");
      if (bad === "stream") return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(16 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
      const response = Response.json({ claim: null });
      Object.defineProperty(response, bad === "redirect" ? "redirected" : "url", { value: bad === "redirect" ? true : "https://foreign.example.test/" });
      return response;
    }, execute: async () => f.result });
    try { await within(f.unavailable.promise); assert.equal(calls, 1); if (bad === "stream") assert.equal(cancelled, true); }
    finally { await worker.stop(); }
  }
});

test("lost completion acknowledgement never retries publication and never sends exception details", async t => {
  const f = fixture(); let completions = 0;
  const secret = `${configuration.token} ${f.claim.grant} provider-body`;
  const worker = startDedicatedNativeWorker(configuration, { report: f.report, request: async (url, init) => {
    if (String(url).endsWith("/complete")) { completions++; throw new Error(secret); }
    return f.request(url, init);
  }, execute: async () => f.result });
  t.after(() => worker.stop()); await within(f.failed.promise); await worker.stop();
  assert.equal(completions, 1);
  const failure = f.calls.find(call => call.suffix.endsWith("/fail"))!;
  assert.deepEqual(Object.keys(failure.body).sort(), ["code", "grant", "version"]);
  assert.equal(failure.body.code, "EXECUTION_FAILED");
  assert.equal(JSON.stringify(failure.body).includes("provider-body"), false);
});

test("executor initialization finishes before claiming, and stop waits for it without a late claim", async () => {
  const f = fixture(), initializing = deferred<void>(), release = deferred<void>();
  const worker = startDedicatedNativeWorker(configuration, { request: f.request, initialize: async () => { initializing.resolve(); await release.promise; }, execute: async () => f.result });
  await within(initializing.promise); assert.equal(f.calls.length, 0);
  const stop = worker.stop(); release.resolve(); await within(stop); assert.equal(f.calls.length, 0);
});

test("dedicated configuration rejects root/platform, authority credentials and unsafe settings before reading a token", async () => {
  const env = { GROUNDWORK_WORKER_AUTHORITY_ORIGIN: configuration.authorityOrigin, GROUNDWORK_WORKER_ID: configuration.workerId,
    GROUNDWORK_WORKER_KINDS: configuration.kinds.join(","), GROUNDWORK_WORKER_EXECUTOR_SOCKET: configuration.executorSocketPath, GROUNDWORK_WORKER_TOKEN_FILE: "/must-not-be-read" };
  for (const identity of [{ platform: "linux", uid: 0 }, { platform: "win32", uid: 10002 }, { platform: "linux", uid: undefined }]) {
    await assert.rejects(readNativeWorkerClientConfiguration(env, identity), NativeWorkerConfigurationError);
  }
  for (const name of ["MASTER_KEY", "DATABASE_URL", "MAIL_PASS", "AI_API_KEY", "NODE_OPTIONS", "HTTPS_PROXY", "NATIVE_WORKER_ENABLED"]) {
    await assert.rejects(readNativeWorkerClientConfiguration({ ...env, [name]: "private-canary" }, { platform: "linux", uid: 10002 }), error => error instanceof NativeWorkerConfigurationError && !error.message.includes("private-canary"));
  }
  for (const update of [{ authorityOrigin: "http://authority.example.test" }, { authorityOrigin: configuration.authorityOrigin + "/other" }, { authorityOrigin: "https://token@authority.example.test" }, { token: "bad" }, { executorSocketPath: "/run/../tmp/executor.sock" }, { kinds: [] }]) {
    assert.throws(() => validateNativeWorkerClientConfiguration({ ...configuration, ...update } as any), NativeWorkerConfigurationError);
  }
});

test("Linux worker status must exclude inherited capabilities and prohibit future privilege gain", () => {
  const status = "Name:\tnode\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t00000000ffffffff\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";
  assert.doesNotThrow(() => requireUnprivilegedNativeWorkerStatus(status));
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
    assert.throws(() => requireUnprivilegedNativeWorkerStatus(status.replace(`${name}:\t0000000000000000`, `${name}:\t0000000000000001`)), NativeWorkerConfigurationError);
    assert.throws(() => requireUnprivilegedNativeWorkerStatus(status.replace(`${name}:\t0000000000000000\n`, "")), NativeWorkerConfigurationError);
  }
  assert.throws(() => requireUnprivilegedNativeWorkerStatus(status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")), NativeWorkerConfigurationError);
});

test("private token file checks reject loose modes, aliases, links and noncanonical bytes", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "groundwork-worker-token-")), filename = path.join(directory, "token");
  const env = { GROUNDWORK_WORKER_AUTHORITY_ORIGIN: configuration.authorityOrigin, GROUNDWORK_WORKER_ID: configuration.workerId,
    GROUNDWORK_WORKER_KINDS: configuration.kinds.join(","), GROUNDWORK_WORKER_EXECUTOR_SOCKET: configuration.executorSocketPath, GROUNDWORK_WORKER_TOKEN_FILE: filename };
  const identity = { platform: "linux", uid: process.getuid!() || 10002 };
  try {
    await writeFile(filename, configuration.token + "\n", { mode: 0o400 });
    assert.equal((await readNativeWorkerClientConfiguration(env, identity)).token, configuration.token);
    await chmod(directory, 0o777); await assert.rejects(readNativeWorkerClientConfiguration(env, identity), NativeWorkerConfigurationError); await chmod(directory, 0o700);
    await chmod(filename, 0o640); await assert.rejects(readNativeWorkerClientConfiguration(env, identity), NativeWorkerConfigurationError); await chmod(filename, 0o400);
    await symlink(filename, path.join(directory, "alias")); await assert.rejects(readNativeWorkerClientConfiguration({ ...env, GROUNDWORK_WORKER_TOKEN_FILE: path.join(directory, "alias") }, identity), NativeWorkerConfigurationError);
    await link(filename, path.join(directory, "hardlink")); await assert.rejects(readNativeWorkerClientConfiguration(env, identity), NativeWorkerConfigurationError); await rm(path.join(directory, "hardlink"));
    await chmod(filename, 0o600); await writeFile(filename, Buffer.alloc(43, 0xe1)); await assert.rejects(readNativeWorkerClientConfiguration(env, identity), NativeWorkerConfigurationError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("standalone entry refusal never imports application storage or echoes inherited credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "groundwork-worker-entry-")), storage = path.join(directory, "must-not-exist");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/nativeWorkerEntry.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: "", GROUNDWORK_DATA_DIR: storage, MASTER_KEY: "worker-entry-private-canary", DATABASE_URL: "worker-entry-private-canary" },
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 78);
    assert.match(result.stderr, /configuration_refused/); assert.equal((result.stdout + result.stderr).includes("worker-entry-private-canary"), false);
    assert.equal(existsSync(storage), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
