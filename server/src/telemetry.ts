import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { waitUntil } from "@vercel/functions";
import type { Request, RequestHandler } from "express";

export interface OperationalSpan { name: string; durationMs: number; failed: boolean; spanId?: string; parentSpanId?: string; }
export interface RequestTelemetry {
  requestId: string; traceId: string; route: string; method: string; status: number;
  durationMs: number; createdAt: number; spans: OperationalSpan[]; droppedSpans: number;
  streamDurationMs?: number;
}
interface TraceContext { traceId: string; spanId: string; flags: string; spans: OperationalSpan[]; lifecycle: { droppedSpans: number; active: boolean }; }
const context = new AsyncLocalStorage<TraceContext | undefined>();
const MAX_SPANS = 64;
const pending = new Set<Promise<void>>();
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const staticSegments = new Set("api auth signup login logout verify-email resend-otp otp request verify me session sessions revoke csrf health ready projects collaboration workspaces engineering exchange geometry artifacts history prune revisions restore share-links share photo export presence events operations locks members items sync bootstrap changes snapshots conflicts organizations invites accept subscription payments webhook plan checkout portal billing assistant render jobs cancel retry capabilities native integrations admin users diagnostics mail secrets files account profile password mfa setup enable disable recovery-code maps geocode ops metrics check backup-report flags diagnostic uploads email totp passkeys native-worker v1 claim renew input output complete fail".split(" "));

/** Only route templates and known static mount segments enter telemetry. */
export function operationalRouteTemplate(req: Pick<Request, "route" | "baseUrl">): string {
  const path = req.route?.path;
  if (typeof path !== "string") return "unmatched";
  const mount = (req.baseUrl || "").split("/").filter(Boolean).map((segment) => staticSegments.has(segment) ? segment : ":id");
  const template = path.split("/").filter(Boolean).map((segment) => /^[A-Za-z0-9_:-]{1,64}$/.test(segment) ? segment : ":id");
  return `/${[...mount, ...template].join("/")}`.slice(0, 160);
}
export function parseTraceparent(value: string | undefined): { traceId: string; flags: string } | null {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i.exec(value || "");
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1].toLowerCase(), flags: (parseInt(match[3], 16) & 1) ? "01" : "00" };
}
export function operationalTraceHeaders(): Record<string, string> {
  const current = context.getStore();
  return current?.lifecycle.active ? { traceparent: `00-${current.traceId}-${current.spanId}-${current.flags}` } : {};
}
/** Names are static categories such as db.select or provider.render, never SQL or URLs. */
export async function withOperationalSpan<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const current = context.getStore();
  if (!current?.lifecycle.active || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(name)) return await operation();
  if (current.spans.length >= MAX_SPANS) { current.lifecycle.droppedSpans += 1; return await operation(); }
  const spanId = randomBytes(8).toString("hex");
  const span: OperationalSpan = { name, durationMs: 0, failed: false, spanId, parentSpanId: current.spanId };
  current.spans.push(span);
  const start = performance.now();
  try { return await context.run({ ...current, spanId }, operation); }
  catch (error) { span.failed = true; throw error; }
  finally { span.durationMs = Math.round(Math.max(0, performance.now() - start) * 100) / 100; }
}
export function withoutTelemetry<T>(work: () => T): T { return context.run(undefined, work); }
export function scheduleTelemetryWork(work: () => Promise<unknown>): void {
  if (pending.size >= 128) {
    console.error(JSON.stringify({ type: "telemetry.dropped", reason: "capacity" }));
    return;
  }
  const task = Promise.resolve().then(() => withoutTelemetry(work)).then(() => undefined)
    .catch(() => console.error(JSON.stringify({ type: "telemetry.failure", stage: "persist" })));
  pending.add(task);
  void task.finally(() => pending.delete(task));
  if (process.env.GROUNDWORK_SERVERLESS === "vercel" && process.env.VERCEL === "1") {
    try { waitUntil(task); }
    catch { console.error(JSON.stringify({ type: "telemetry.failure", stage: "lifetime" })); }
  }
}
export async function drainTelemetry(timeoutMs = 5000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    Promise.allSettled([...pending]).then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, Math.min(timeoutMs, 10_000))); }),
  ]);
  if (timer) clearTimeout(timer);
  return done;
}

export const telemetryMiddleware: RequestHandler = (req, res, next) => {
  const inherited = parseTraceparent(req.get("traceparent"));
  const requestId = randomBytes(16).toString("hex");
  const trace: TraceContext = { traceId: inherited?.traceId || randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), flags: inherited?.flags || "01", spans: [], lifecycle: { droppedSpans: 0, active: true } };
  const start = performance.now();
  res.setHeader("x-request-id", requestId);
  res.setHeader("traceparent", `00-${trace.traceId}-${trace.spanId}-${trace.flags}`);
  const scopedSegments = `${req.baseUrl || ""}/${req.path}`.slice(0, 2048).split("/").filter(Boolean)
    .map((segment) => staticSegments.has(segment) ? segment : ":id");
  // Express restores mounted router state after handlers return. Capture the
  // template when headers are sent, while the declared route is still present.
  let route = "unmatched";
  let headersDurationMs: number | undefined;
  let streaming = false;
  const writeHead = res.writeHead;
  res.writeHead = ((...args: Parameters<typeof writeHead>) => {
    const template = operationalRouteTemplate(req);
    const segments = template === "unmatched" ? [] : template.split("/").filter(Boolean);
    // Error handlers run after Express has restored baseUrl; reconstruct only
    // the missing mount prefix from the previously redacted static path.
    route = segments.length ? `/${[...scopedSegments.slice(0, Math.max(0, scopedSegments.length - segments.length)), ...segments].join("/")}`.slice(0, 160) : "unmatched";
    const result = Reflect.apply(writeHead, res, args);
    headersDurationMs ??= Math.max(0, performance.now() - start);
    streaming = String(res.getHeader("content-type") || "").split(";")[0].trim().toLowerCase() === "text/event-stream";
    return result;
  }) as typeof res.writeHead;
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    trace.lifecycle.active = false;
    const elapsedMs = Math.round(Math.max(0, performance.now() - start) * 100) / 100;
    const record: RequestTelemetry = {
      requestId, traceId: trace.traceId, route, method: methods.has(req.method) ? req.method : "OTHER",
      status: res.writableFinished ? res.statusCode : 499, durationMs: streaming ? Math.round((headersDurationMs ?? elapsedMs) * 100) / 100 : elapsedMs,
      ...(streaming ? { streamDurationMs: elapsedMs } : {}),
      createdAt: Math.floor(Date.now() / 1000), spans: trace.spans.map((span) => ({ ...span })), droppedSpans: trace.lifecycle.droppedSpans,
    };
    console.info(JSON.stringify({ type: "api.request", requestId: record.requestId, traceId: record.traceId, route: record.route, method: record.method, status: record.status, durationMs: record.durationMs, ...(streaming ? { latencyBasis: "headers", streamDurationMs: elapsedMs } : {}) }));
    // Lazy loading keeps the span helper safe to import from the database adapter.
    scheduleTelemetryWork(async () => {
      const { persistRequestTelemetry } = await import("./operationalRuntime.js");
      await persistRequestTelemetry(record);
    });
  };
  res.once("finish", finish);
  res.once("close", finish);
  context.run(trace, next);
};
