import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import type { NativeWorkerExecutor } from "./nativeWorkerClient.js";

const MAX_FRAME = 48 * 1024 * 1024, MAX_BYTES = 32 * 1024 * 1024;
const kinds = new Set(["dwg-to-dxf", "dxf-to-dwg", "opensees-static"]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: RecordValue, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4) throw new NativeExecutorError("EXECUTION_FAILED");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString("base64") !== value) throw new NativeExecutorError("EXECUTION_FAILED");
  return bytes;
}
export class NativeExecutorError extends Error {
  constructor(public readonly code: "EXECUTOR_UNAVAILABLE" | "EXECUTION_FAILED" | "WORKER_STOPPED") {
    super("The isolated native executor did not complete the request"); this.name = "NativeExecutorError";
  }
}

interface SocketStat { uid: number; gid: number; mode: number; nlink: number; isSocket(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
/** Injectable I/O is for isolated tests; the CLI never supplies overrides. */
export interface NativeExecutorClientDependencies {
  identity?: { platform: string; uid: number | undefined; gid: number | undefined };
  stat?: (filename: string) => Promise<SocketStat>;
  canonical?: (filename: string) => Promise<string>;
  connect?: (socketPath: string) => Socket;
}
export interface NativeExecutorClientOptions { socketPath: string; timeoutMs?: number; probeTimeoutMs?: number }

export function createNativeWorkerExecutor(options: NativeExecutorClientOptions, dependencies: NativeExecutorClientDependencies = {}): { execute: NativeWorkerExecutor; initialize(): Promise<void> } {
  const { socketPath } = options, timeoutMs = options.timeoutMs ?? 150_000, probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  const identity = dependencies.identity ?? { platform: process.platform, uid: process.getuid?.(), gid: process.getgid?.() };
  const stat = dependencies.stat ?? lstat, canonical = dependencies.canonical ?? realpath;
  if (!path.posix.isAbsolute(socketPath) || path.posix.resolve(socketPath) !== socketPath || socketPath.length > 100 || /[\0-\x1f\\]/.test(socketPath) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000 || !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 5000) throw new NativeExecutorError("EXECUTOR_UNAVAILABLE");

  async function verifySocket(): Promise<void> {
    if (identity.platform !== "linux" || !Number.isSafeInteger(identity.uid) || identity.uid! <= 0 || !Number.isSafeInteger(identity.gid) || identity.gid! <= 0) throw new NativeExecutorError("EXECUTOR_UNAVAILABLE");
    const entry = await stat(socketPath);
    if (!entry.isSocket() || entry.isSymbolicLink() || entry.uid !== 0 || entry.gid !== identity.gid || (entry.mode & 0o7777) !== 0o660 || entry.nlink !== 1 || await canonical(socketPath) !== socketPath) throw new NativeExecutorError("EXECUTOR_UNAVAILABLE");
    let directory = path.posix.dirname(socketPath);
    const immediate = directory;
    for (;;) {
      const info = await stat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o7022) !== 0 || await canonical(directory) !== directory ||
          (directory === immediate && ((info.mode & 0o7777) !== 0o750 || info.gid !== identity.gid))) throw new NativeExecutorError("EXECUTOR_UNAVAILABLE");
      const parent = path.posix.dirname(directory); if (parent === directory) break; directory = parent;
    }
  }

  function exchange(payload: RecordValue, signal: AbortSignal, deadline: number, probe = false): Promise<unknown> {
    let encoded: Buffer;
    try { encoded = Buffer.from(JSON.stringify(payload)); } catch { return Promise.reject(new NativeExecutorError("EXECUTION_FAILED")); }
    if (encoded.length < 1 || encoded.length > MAX_FRAME) return Promise.reject(new NativeExecutorError("EXECUTION_FAILED"));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined, settled = false, connected = false, expected: number | undefined, received = 0;
      let header = Buffer.alloc(0); const chunks: Buffer[] = [];
      const finish = (error?: NativeExecutorError, value?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel); socket?.destroy();
        if (error) reject(error); else resolve(value);
      };
      const unavailable = () => finish(new NativeExecutorError(probe || !connected ? "EXECUTOR_UNAVAILABLE" : "EXECUTION_FAILED"));
      const cancel = () => finish(new NativeExecutorError("WORKER_STOPPED"));
      const timer = setTimeout(unavailable, deadline);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      void (async () => {
        try {
          await verifySocket(); if (settled) return;
          socket = dependencies.connect ? dependencies.connect(socketPath) : createConnection({ path: socketPath });
          socket.once("error", unavailable);
          socket.once("end", () => { if (!settled) unavailable(); });
          socket.once("close", () => { if (!settled) unavailable(); });
          socket.on("data", (incoming: Buffer) => {
            if (settled) return;
            let bytes = incoming;
            if (expected === undefined) {
              const needed = 4 - header.length;
              header = Buffer.concat([header, bytes.subarray(0, needed)]); bytes = bytes.subarray(needed);
              if (header.length !== 4) return;
              expected = header.readUInt32BE(0);
              if (expected < 1 || expected > MAX_FRAME) { unavailable(); return; }
            }
            received += bytes.length;
            if (received > expected) { unavailable(); return; }
            chunks.push(bytes);
            if (received === expected) {
              try { finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, received)))); }
              catch { unavailable(); }
            }
          });
          socket.once("connect", () => { if (!settled) { connected = true; socket!.write(prefix); socket!.write(encoded); } });
        } catch { finish(new NativeExecutorError("EXECUTOR_UNAVAILABLE")); }
      })();
    });
  }

  const execute: NativeWorkerExecutor = async (request, signal) => {
    const bytes = Buffer.from(request.input.bytes);
    if (request.version !== 1 || !/^[a-f0-9]{32}$/.test(request.jobId) || !kinds.has(request.kind) || !/^[a-f0-9]{32}$/.test(request.input.sourceArtifactId) ||
        !/^[a-f0-9]{64}$/.test(request.input.sha256) || bytes.length < 1 || bytes.length > MAX_BYTES || hash(bytes) !== request.input.sha256) throw new NativeExecutorError("EXECUTION_FAILED");
    const result = await exchange({ version: 1, op: "execute", jobId: request.jobId, kind: request.kind, input: { bytes: bytes.toString("base64"), sourceArtifactId: request.input.sourceArtifactId, sha256: request.input.sha256 } }, signal, timeoutMs);
    if (!object(result) || !keys(result, ["version", "artifacts", "summary"]) || result.version !== 1 || !Array.isArray(result.artifacts) || result.artifacts.length < 1 || result.artifacts.length > 8 || !object(result.summary)) throw new NativeExecutorError("EXECUTION_FAILED");
    const summary = result.summary;
    if (!keys(summary, ["kind", "adapter", "declaredVersion", "sourceArtifactId", "sourceSha256", "verification", "warnings"], ["dimension", "combinationId"]) ||
        summary.kind !== request.kind || summary.sourceArtifactId !== request.input.sourceArtifactId || summary.sourceSha256 !== request.input.sha256 || summary.verification !== "computed-unvalidated" ||
        summary.adapter !== (request.kind === "opensees-static" ? "OpenSees" : "LibreDWG") || summary.declaredVersion !== (request.kind === "opensees-static" ? "3.8.0" : "0.13.4") ||
        !Array.isArray(summary.warnings) || summary.warnings.length > 16 || summary.warnings.some(value => typeof value !== "string" || !value.length || value.length > 2000 || /[\0-\x1f\x7f]/.test(value)) ||
        (request.kind === "opensees-static" ? summary.dimension !== "planar-2d" || typeof summary.combinationId !== "string" || !summary.combinationId.length || summary.combinationId.length > 100 || /[\0-\x1f\x7f]/.test(summary.combinationId)
          : summary.dimension !== undefined || summary.combinationId !== undefined)) throw new NativeExecutorError("EXECUTION_FAILED");
    let total = 0; const names = new Set<string>();
    const artifacts = result.artifacts.map(value => {
      if (!object(value) || !keys(value, ["filename", "mediaType", "bytes", "sha256"]) || typeof value.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.filename) || names.has(value.filename) ||
          !["application/json", "application/dxf", "image/vnd.dwg", "text/plain"].includes(String(value.mediaType)) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new NativeExecutorError("EXECUTION_FAILED");
      names.add(value.filename); const data = base64(value.bytes); total += data.length;
      if (total > MAX_BYTES || hash(data) !== value.sha256) throw new NativeExecutorError("EXECUTION_FAILED");
      return { filename: value.filename, mediaType: value.mediaType as string, bytes: data, sha256: value.sha256 };
    });
    return { artifacts, summary: summary as unknown as Awaited<ReturnType<NativeWorkerExecutor>>["summary"] };
  };
  return { execute, initialize: async () => {
    const result = await exchange({ version: 1, op: "probe" }, new AbortController().signal, probeTimeoutMs, true);
    if (!object(result) || !keys(result, ["version", "ready"]) || result.version !== 1 || result.ready !== true) throw new NativeExecutorError("EXECUTOR_UNAVAILABLE");
  } };
}
