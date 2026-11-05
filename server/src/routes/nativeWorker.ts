import express, { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { authenticateNativeWorker, completeWorkerJob, createWorkerClaim, failWorkerJob, NativeWorkerAuthorityError, readWorkerInput, renewWorkerClaim, stageWorkerOutput, type WorkerIdentity } from "../nativeWorkerAuthority.js";

const router = Router();
const identities = new WeakMap<Request, WorkerIdentity>();
const grant = z.string().min(32).max(4096);
const envelope = z.object({ version: z.literal(1), grant });
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  try {
    if (req.method !== "POST" || req.headers.origin !== undefined || req.headers.cookie !== undefined || req.url.includes("?") || !req.is("application/json")) throw new NativeWorkerAuthorityError(400, "WORKER_REQUEST_INVALID");
    identities.set(req, authenticateNativeWorker(req.get("authorization"), req.get("x-groundwork-worker-id")));
    next();
  } catch (error) { next(error); }
});
router.use(express.json({ limit: "512kb", strict: true }));
function handle(work: (req: Request, res: Response, worker: WorkerIdentity) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { void work(req, res, identities.get(req)!).catch(next); };
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NativeWorkerAuthorityError(400, "WORKER_REQUEST_INVALID");
  return parsed.data;
}
router.post("/claim", handle(async (req, res, worker) => {
  const body = parse(z.object({ version: z.literal(1), kinds: z.array(z.string()).min(1).max(3) }).strict(), req.body);
  res.json(await createWorkerClaim(worker, body.kinds));
}));
router.param("jobId", (_req, _res, next, value: string) => {
  next(/^[a-f0-9]{32}$/.test(value) ? undefined : new NativeWorkerAuthorityError(400, "WORKER_REQUEST_INVALID"));
});
const id = (req: Request) => { const value = req.params.jobId; if (typeof value !== "string") throw new NativeWorkerAuthorityError(400, "WORKER_REQUEST_INVALID"); return value; };
router.post("/jobs/:jobId/renew", handle(async (req, res, worker) => { const body = parse(envelope.strict(), req.body); res.json(await renewWorkerClaim(worker, id(req), body.grant)); }));
router.post("/jobs/:jobId/input", handle(async (req, res, worker) => { const body = parse(envelope.extend({ offset: z.number() }).strict(), req.body); res.json(await readWorkerInput(worker, id(req), body.grant, body.offset)); }));
router.post("/jobs/:jobId/output", handle(async (req, res, worker) => {
  const body = parse(envelope.extend({ index: z.number(), filename: z.string(), mediaType: z.string(), totalBytes: z.number(), sha256: z.string(), offset: z.number(), bytes: z.string() }).strict(), req.body);
  const { version: _version, grant: token, ...output } = body;
  res.json(await stageWorkerOutput(worker, id(req), token, output));
}));
router.post("/jobs/:jobId/complete", handle(async (req, res, worker) => { const body = parse(envelope.extend({ summary: z.unknown() }).strict(), req.body); res.json(await completeWorkerJob(worker, id(req), body.grant, body.summary)); }));
router.post("/jobs/:jobId/fail", handle(async (req, res, worker) => { const body = parse(envelope.extend({ code: z.string() }).strict(), req.body); res.json(await failWorkerJob(worker, id(req), body.grant, body.code)); }));
router.use((_req, _res, next) => { next(new NativeWorkerAuthorityError(404, "WORKER_REQUEST_INVALID")); });
router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const safe = error instanceof NativeWorkerAuthorityError ? error : new NativeWorkerAuthorityError((error as { type?: string })?.type === "entity.too.large" ? 413 : (error as { type?: string })?.type === "entity.parse.failed" ? 400 : 503, (error as { type?: string })?.type?.startsWith("entity.") ? "WORKER_REQUEST_INVALID" : "WORKER_STORAGE_UNAVAILABLE");
  res.status(safe.status).json({ error: safe.message, code: safe.code });
});
export default router;
