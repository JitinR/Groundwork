import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { createNativeWorkerExecutor, type NativeExecutorClientDependencies } from "../src/nativeWorkerExecutorClient.js";

const socketPath = "/run/groundwork-native/executor.sock", uid = 10002;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"), output = Buffer.from("AC1015synthetic");
const job = { version: 1 as const, jobId: "a".repeat(32), kind: "dxf-to-dwg" as const, input: { bytes: source, sourceArtifactId: "b".repeat(32), sha256: hash(source) } };
function result() { return { version: 1, artifacts: [{ filename: "synthetic.dwg", mediaType: "image/vnd.dwg", bytes: output.toString("base64"), sha256: hash(output) }], summary: { kind: job.kind, adapter: "LibreDWG", declaredVersion: "0.13.4", sourceArtifactId: job.input.sourceArtifactId, sourceSha256: job.input.sha256, verification: "computed-unvalidated", warnings: ["Synthetic framing fixture."] } }; }
function frame(value: unknown) { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }
class FakeSocket extends EventEmitter {
  destroyed = false; writes: Buffer[] = [];
  constructor(readonly reply: (socket: FakeSocket, payload: Record<string, any>) => void) { super(); queueMicrotask(() => this.emit("connect")); }
  write(value: Uint8Array) {
    this.writes.push(Buffer.from(value));
    if (this.writes.length === 2) this.reply(this, JSON.parse(this.writes[1].toString("utf8")));
    return true;
  }
  destroy() { this.destroyed = true; queueMicrotask(() => this.emit("close")); return this; }
}
function fixture(reply: FakeSocket["reply"], overrides: Partial<NativeExecutorClientDependencies> = {}) {
  const sockets: FakeSocket[] = [], payloads: Record<string, any>[] = [];
  const dependencies: NativeExecutorClientDependencies = {
    identity: { platform: "linux", uid, gid: uid }, canonical: async value => value,
    stat: async value => ({ uid: 0, gid: value === socketPath || value === "/run/groundwork-native" ? uid : 0,
      mode: value === socketPath ? 0o660 : value === "/run/groundwork-native" ? 0o750 : 0o755,
      nlink: 1, isSocket: () => value === socketPath, isDirectory: () => value !== socketPath, isSymbolicLink: () => false }),
    connect: () => { const socket = new FakeSocket((connected, payload) => { payloads.push(payload); reply(connected, payload); }); sockets.push(socket); return socket as unknown as Socket; }, ...overrides,
  };
  return { sockets, payloads, dependencies };
}

test("executor framing handles fragmented replies and forwards only one job's permitted input", async () => {
  const f = fixture((socket, payload) => {
    const bytes = frame(payload.op === "probe" ? { version: 1, ready: true } : result());
    for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]) socket.emit("data", part);
  });
  const executor = createNativeWorkerExecutor({ socketPath }, f.dependencies);
  await executor.initialize();
  const answer = await executor.execute({ ...job, grant: "must-not-forward", projectId: "private" } as typeof job, new AbortController().signal);
  assert.equal(Buffer.from(answer.artifacts[0].bytes).equals(output), true);
  assert.deepEqual(Object.keys(f.payloads[1]).sort(), ["input", "jobId", "kind", "op", "version"]);
  assert.deepEqual(Object.keys(f.payloads[1].input).sort(), ["bytes", "sha256", "sourceArtifactId"]);
  assert.ok(f.sockets.every(socket => socket.destroyed));
});

test("executor refuses unsafe socket identities and ancestors before connecting", async () => {
  for (const mode of ["root-client", "writable", "link", "foreign-owner", "wrong-group", "wrong-canonical"] as const) {
    const f = fixture(() => assert.fail("must not send a request"));
    const original = f.dependencies.stat!;
    if (mode === "root-client") f.dependencies.identity = { platform: "linux", uid: 0, gid: 0 };
    else if (mode === "wrong-canonical") f.dependencies.canonical = async () => "/different/socket";
    else f.dependencies.stat = async value => ({ ...await original(value),
      ...(mode === "writable" && value === "/run" ? { mode: 0o777 } : {}),
      ...(mode === "link" ? { isSymbolicLink: () => true } : {}),
      ...(mode === "foreign-owner" ? { uid: uid } : {}),
      ...(mode === "wrong-group" && value === socketPath ? { gid: 19 } : {}),
    });
    await assert.rejects(createNativeWorkerExecutor({ socketPath }, f.dependencies).initialize(), { code: "EXECUTOR_UNAVAILABLE" });
    assert.equal(f.sockets.length, 0);
  }
});

test("executor bounds framing before allocation and rejects malformed or mismatched native output", async () => {
  for (const wrong of ["oversize", "json", "hash", "source", "verified", "path", "solver-field"] as const) {
    const f = fixture(socket => {
      if (wrong === "oversize") { const header = Buffer.alloc(4); header.writeUInt32BE(48 * 1024 * 1024 + 1); socket.emit("data", header); return; }
      if (wrong === "json") { socket.emit("data", Buffer.from([0, 0, 0, 1, 123])); return; }
      const value: any = result();
      if (wrong === "hash") value.artifacts[0].sha256 = "f".repeat(64);
      if (wrong === "source") value.summary.sourceSha256 = "f".repeat(64);
      if (wrong === "verified") value.summary.verification = "verified";
      if (wrong === "path") value.artifacts[0].filename = "../outside.dwg";
      if (wrong === "solver-field") value.summary.dimension = "planar-2d";
      socket.emit("data", frame(value));
    });
    await assert.rejects(createNativeWorkerExecutor({ socketPath }, f.dependencies).execute(job, new AbortController().signal), { code: "EXECUTION_FAILED" });
    assert.equal(f.sockets[0].destroyed, true);
  }
});

test("executor cancellation closes a partially received response and prevents late completion", async () => {
  const controller = new AbortController();
  const f = fixture(socket => { socket.emit("data", Buffer.from([0, 0, 0, 100, 123])); controller.abort(); });
  await assert.rejects(createNativeWorkerExecutor({ socketPath }, f.dependencies).execute(job, controller.signal), { code: "WORKER_STOPPED" });
  assert.equal(f.sockets[0].destroyed, true);
  f.sockets[0].emit("data", frame(result()));
});

test("executor's deadline covers stalled frame bodies and probe errors remain fixed", async () => {
  const f = fixture(socket => { socket.emit("data", Buffer.from([0, 0, 0, 100, 123])); });
  await assert.rejects(createNativeWorkerExecutor({ socketPath, probeTimeoutMs: 10 }, f.dependencies).initialize(), error => {
    assert.equal((error as { code: string }).code, "EXECUTOR_UNAVAILABLE");
    assert.equal(String(error).includes(socketPath), false); return true;
  });
  assert.equal(f.sockets[0].destroyed, true);
});
