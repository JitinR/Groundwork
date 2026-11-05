import { createHash } from "node:crypto";
import type { NativeJobKind, NativeJobSummary, NativeOutputArtifact } from "./nativeAdapters.js";
import { startNativeWorkerLoop } from "./nativeWorkerLoop.js";
import { validateNativeWorkerClientConfiguration, type NativeWorkerClientConfiguration } from "./nativeWorkerClientConfig.js";

const CHUNK_BYTES = 256 * 1024, MAX_BYTES = 32 * 1024 * 1024;
const MAX_SMALL_RESPONSE = 16 * 1024, MAX_CHUNK_RESPONSE = 512 * 1024;
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/, PROJECT = /^[A-Za-z0-9_-]{1,120}$/;
const GRANT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KINDS = new Set<NativeJobKind>(["dwg-to-dxf", "dxf-to-dwg", "opensees-static"]);
const MIME = new Set(["application/json", "application/dxf", "image/vnd.dwg", "text/plain"]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
export type NativeWorkerDiagnostic = "ready" | "authority_unavailable" | "executor_unavailable" | "job_failed" | "job_succeeded" | "stopped";
export type NativeWorkerFailureCode = "AUTHORITY_UNAVAILABLE" | "INPUT_INVALID" | "OUTPUT_INVALID" | "EXECUTOR_UNAVAILABLE" | "EXECUTION_FAILED" | "WORKER_STOPPED";
export class NativeWorkerClientError extends Error {
  constructor(public readonly code: NativeWorkerFailureCode) { super("Dedicated native worker operation was not accepted"); this.name = "NativeWorkerClientError"; }
}
export interface NativeWorkerClaim {
  version: 1; jobId: string; projectId: string; kind: NativeJobKind;
  sourceArtifactId: string; sourceSha256: string; inputBytes: number; grant: string;
}
export interface NativeWorkerExecutorRequest {
  version: 1; jobId: string; kind: NativeJobKind;
  input: { bytes: Uint8Array; sourceArtifactId: string; sha256: string };
}
export interface NativeWorkerExecutorResult { artifacts: NativeOutputArtifact[]; summary: NativeJobSummary }
export type NativeWorkerExecutor = (request: NativeWorkerExecutorRequest, signal: AbortSignal) => Promise<NativeWorkerExecutorResult>;
export interface DedicatedNativeWorkerOptions {
  execute: NativeWorkerExecutor;
  initialize?(): Promise<void>;
  request?: typeof fetch;
  report?(code: NativeWorkerDiagnostic): void;
  pollMs?: number; heartbeatMs?: number; requestTimeoutMs?: number; failureBackoffMs?: number;
}

function parseClaim(value: unknown, configured: readonly NativeJobKind[]): NativeWorkerClaim | null {
  if (!record(value) || !keys(value, ["claim"])) throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
  if (value.claim === null) return null;
  const claim = value.claim;
  if (!record(claim) || !keys(claim, ["version", "jobId", "projectId", "kind", "sourceArtifactId", "sourceSha256", "inputBytes", "grant"]) ||
      claim.version !== 1 || typeof claim.jobId !== "string" || !ID.test(claim.jobId) || typeof claim.projectId !== "string" || !PROJECT.test(claim.projectId) ||
      typeof claim.kind !== "string" || !KINDS.has(claim.kind as NativeJobKind) || !configured.includes(claim.kind as NativeJobKind) ||
      typeof claim.sourceArtifactId !== "string" || !ID.test(claim.sourceArtifactId) || typeof claim.sourceSha256 !== "string" || !HASH.test(claim.sourceSha256) ||
      !integer(claim.inputBytes, 1, MAX_BYTES) || typeof claim.grant !== "string" || claim.grant.length < 32 || claim.grant.length > 4096 || !GRANT.test(claim.grant)) {
    throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
  }
  return claim as unknown as NativeWorkerClaim;
}
function base64(value: unknown, expected: number): Buffer {
  if (typeof value !== "string" || value.length !== 4 * Math.ceil(expected / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new NativeWorkerClientError("INPUT_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expected || bytes.toString("base64") !== value) throw new NativeWorkerClientError("INPUT_INVALID");
  return bytes;
}
function parseResult(result: unknown, claim: NativeWorkerClaim): NativeWorkerExecutorResult {
  if (!record(result) || !keys(result, ["artifacts", "summary"]) || !Array.isArray(result.artifacts) || result.artifacts.length < 1 || result.artifacts.length > 8) throw new NativeWorkerClientError("OUTPUT_INVALID");
  const summary = result.summary;
  if (!record(summary) || !keys(summary, ["kind", "adapter", "declaredVersion", "sourceArtifactId", "sourceSha256", "verification", "warnings"], ["dimension", "combinationId"]) ||
      summary.kind !== claim.kind || summary.sourceArtifactId !== claim.sourceArtifactId || summary.sourceSha256 !== claim.sourceSha256 || summary.verification !== "computed-unvalidated" ||
      summary.adapter !== (claim.kind === "opensees-static" ? "OpenSees" : "LibreDWG") || summary.declaredVersion !== (claim.kind === "opensees-static" ? "3.8.0" : "0.13.4") ||
      !Array.isArray(summary.warnings) || summary.warnings.length > 16 || summary.warnings.some(value => !text(value, 2000)) ||
      (claim.kind === "opensees-static" && (summary.dimension !== "planar-2d" || !text(summary.combinationId, 100))) ||
      (summary.dimension !== undefined && (claim.kind !== "opensees-static" || summary.dimension !== "planar-2d")) ||
      (summary.combinationId !== undefined && (claim.kind !== "opensees-static" || !text(summary.combinationId, 100)))) throw new NativeWorkerClientError("OUTPUT_INVALID");
  let total = 0; const names = new Set<string>();
  const artifacts = result.artifacts.map(value => {
    if (!record(value) || !keys(value, ["filename", "mediaType", "bytes", "sha256"]) ||
        typeof value.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.filename) || names.has(value.filename) ||
        typeof value.mediaType !== "string" || !MIME.has(value.mediaType) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1 || value.bytes.byteLength > MAX_BYTES ||
        typeof value.sha256 !== "string" || !HASH.test(value.sha256)) throw new NativeWorkerClientError("OUTPUT_INVALID");
    total += value.bytes.byteLength;
    if (total > MAX_BYTES) throw new NativeWorkerClientError("OUTPUT_INVALID");
    const bytes = Buffer.from(value.bytes);
    if (hash(bytes) !== value.sha256) throw new NativeWorkerClientError("OUTPUT_INVALID");
    names.add(value.filename);
    return { filename: value.filename, mediaType: value.mediaType, bytes, sha256: value.sha256 };
  });
  // Copy validated metadata as well as bytes before any asynchronous publication.
  return { artifacts, summary: JSON.parse(JSON.stringify(summary)) as NativeJobSummary };
}

/** A credential-limited transport client. It opens no listening socket, loads
 * no application configuration and never launches a native executable. */
export function startDedicatedNativeWorker(configuration: NativeWorkerClientConfiguration, options: DedicatedNativeWorkerOptions): { stop(): Promise<void> } {
  const config = validateNativeWorkerClientConfiguration(configuration), request = options.request ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 5000, failureBackoffMs = options.failureBackoffMs ?? 5000;
  if (!integer(timeoutMs, 1, 5000) || !integer(failureBackoffMs, 1, 60_000) || typeof options.execute !== "function") throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
  const shutdown = new AbortController();
  let stopPromise: Promise<void> | undefined, cooldownUntil = 0;
  function report(code: NativeWorkerDiagnostic): void { try { options.report?.(code); } catch { /* Diagnostics contain no payload and cannot break the worker. */ } }
  async function post(suffix: string, body: RecordValue, maximum: number, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(new NativeWorkerClientError("WORKER_STOPPED"));
    shutdown.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (shutdown.signal.aborted || signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new NativeWorkerClientError("AUTHORITY_UNAVAILABLE")), timeoutMs);
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const work = async () => {
      controller.signal.throwIfAborted();
      const endpoint = `${config.authorityOrigin}/api/native-worker/v1${suffix}`;
      const response = await request(endpoint, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal, headers: {
        accept: "application/json", "content-type": "application/json", authorization: `Bearer ${config.token}`, "x-groundwork-worker-id": config.workerId,
      }, body: JSON.stringify(body) });
      if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
      controller.signal.throwIfAborted();
      const declared = response.headers.get("content-length");
      if (!response.ok || response.redirected || (response.url && response.url !== endpoint) ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
          (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))) {
        void response.body?.cancel().catch(() => undefined); throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
      const chunks: Uint8Array[] = []; let total = 0;
      const cancel = () => { void reader.cancel(controller.signal.reason).catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const part = await reader.read();
          controller.signal.throwIfAborted();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maximum) throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
          chunks.push(part.value);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown;
      } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
      finally { controller.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
    };
    try { return await Promise.race([work(), cancelled]); }
    catch { throw new NativeWorkerClientError(shutdown.signal.aborted || signal?.aborted ? "WORKER_STOPPED" : "AUTHORITY_UNAVAILABLE"); }
    finally {
      clearTimeout(timer); shutdown.signal.removeEventListener("abort", abort); signal?.removeEventListener("abort", abort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
  async function active(claim: NativeWorkerClaim): Promise<boolean> {
    const value = await post(`/jobs/${claim.jobId}/renew`, { version: 1, grant: claim.grant }, MAX_SMALL_RESPONSE);
    if (!record(value) || !keys(value, ["active"]) || typeof value.active !== "boolean") throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
    return value.active;
  }
  async function checkLease(signal: AbortSignal, renew: () => Promise<boolean>): Promise<void> {
    if (signal.aborted || !await renew() || signal.aborted) throw new NativeWorkerClientError("WORKER_STOPPED");
  }
  const worker = startNativeWorkerLoop<NativeWorkerClaim>({
    initialize: async () => { await options.initialize?.(); report("ready"); },
    beforeClaim: async () => {
      const remaining = cooldownUntil - Date.now();
      if (remaining > 0 && !shutdown.signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, remaining);
        shutdown.signal.addEventListener("abort", done, { once: true });
        if (shutdown.signal.aborted) done();
      });
    },
    claim: async () => {
      try { return parseClaim(await post("/claim", { version: 1, kinds: [...config.kinds] }, MAX_SMALL_RESPONSE), config.kinds); }
      catch { cooldownUntil = Date.now() + failureBackoffMs; throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE"); }
    },
    renew: active,
    execute: async (claim, signal, renew) => {
      try {
        await checkLease(signal, renew);
        const input = Buffer.alloc(claim.inputBytes);
        for (let offset = 0; offset < input.byteLength;) {
          signal.throwIfAborted();
          const value = await post(`/jobs/${claim.jobId}/input`, { version: 1, grant: claim.grant, offset }, MAX_CHUNK_RESPONSE, signal);
          if (!record(value) || !keys(value, ["offset", "bytes", "sha256", "totalBytes"]) || value.offset !== offset || value.totalBytes !== claim.inputBytes || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) throw new NativeWorkerClientError("INPUT_INVALID");
          const bytes = base64(value.bytes, Math.min(CHUNK_BYTES, input.byteLength - offset));
          if (hash(bytes) !== value.sha256) throw new NativeWorkerClientError("INPUT_INVALID");
          bytes.copy(input, offset); offset += bytes.length;
        }
        if (hash(input) !== claim.sourceSha256) throw new NativeWorkerClientError("INPUT_INVALID");
        await checkLease(signal, renew);
        const executed = await options.execute({ version: 1, jobId: claim.jobId, kind: claim.kind, input: { bytes: input, sourceArtifactId: claim.sourceArtifactId, sha256: claim.sourceSha256 } }, signal);
        const result = parseResult(executed, claim);
        for (const [index, artifact] of result.artifacts.entries()) {
          await checkLease(signal, renew);
          for (let offset = 0; offset < artifact.bytes.byteLength; offset += CHUNK_BYTES) {
            signal.throwIfAborted();
            const chunk = artifact.bytes.subarray(offset, offset + CHUNK_BYTES);
            const acknowledgement = await post(`/jobs/${claim.jobId}/output`, { version: 1, grant: claim.grant, index,
              filename: artifact.filename, mediaType: artifact.mediaType, totalBytes: artifact.bytes.byteLength,
              sha256: artifact.sha256, offset, bytes: Buffer.from(chunk).toString("base64"),
            }, MAX_SMALL_RESPONSE, signal);
            if (!record(acknowledgement) || !keys(acknowledgement, ["accepted", "nextOffset"]) || acknowledgement.accepted !== true || acknowledgement.nextOffset !== offset + chunk.byteLength) throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
          }
        }
        await checkLease(signal, renew);
        const acknowledgement = await post(`/jobs/${claim.jobId}/complete`, { version: 1, grant: claim.grant, summary: result.summary }, MAX_SMALL_RESPONSE, signal);
        if (!record(acknowledgement) || !keys(acknowledgement, ["accepted"]) || acknowledgement.accepted !== true) throw new NativeWorkerClientError("AUTHORITY_UNAVAILABLE");
        report("job_succeeded");
      } catch (error) {
        const unavailable = record(error) && error.code === "EXECUTOR_UNAVAILABLE";
        const code = signal.aborted || shutdown.signal.aborted ? "WORKER_STOPPED" : error instanceof NativeWorkerClientError && error.code === "INPUT_INVALID" ? "INPUT_INVALID" : unavailable ? "EXECUTOR_UNAVAILABLE" : "EXECUTION_FAILED";
        // Only a fixed code crosses the boundary. A lost publication response is
        // never retried; the authority's durable lease/state fences this report.
        try { await post(`/jobs/${claim.jobId}/fail`, { version: 1, grant: claim.grant, code }, MAX_SMALL_RESPONSE); } catch { /* Lease recovery remains authoritative. */ }
        if (!shutdown.signal.aborted) report(unavailable ? "executor_unavailable" : "job_failed");
      }
    },
    onError: () => { if (!shutdown.signal.aborted) report("authority_unavailable"); },
  }, { pollMs: options.pollMs ?? 15_000, heartbeatMs: options.heartbeatMs });
  return { stop() {
    if (!stopPromise) {
      shutdown.abort();
      stopPromise = worker.stop().then(() => { report("stopped"); });
    }
    return stopPromise;
  } };
}
