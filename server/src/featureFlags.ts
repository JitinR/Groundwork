import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { SERVERLESS } from "./config.js";
import { db, now, withTransaction } from "./db.js";
import type { AuthedRequest } from "./security.js";
import { readNativeWorkerRegistrations } from "./nativeWorkerRemoteConfig.js";

export const FEATURE_NAMES = ["assistant", "uploads", "collaboration", "native", "render"] as const;
export type FeatureName = typeof FEATURE_NAMES[number];
export interface RuntimeFeatureFlag { name: FeatureName; enabled: boolean; rolloutPercent: number; revision: number; updatedAt: number | null; supported: boolean; }
interface FlagRow { name: FeatureName; enabled: number; rollout_percent: number; revision: number; updated_at: number; }
export function featureSupported(name: FeatureName): boolean {
  if (name !== "native" && name !== "render") return true;
  if (name === "native") {
    try { if (readNativeWorkerRegistrations().length > 0) return true; }
    catch { return false; }
  }
  return !SERVERLESS && process.env.DURABLE_WORKERS_ENABLED === "true" && (name !== "native" || process.env.NATIVE_WORKER_ENABLED === "true");
}
function flagValue(name: FeatureName, row?: FlagRow): RuntimeFeatureFlag {
  const supported = featureSupported(name);
  return { name, enabled: supported && (row ? row.enabled === 1 : !["native", "render"].includes(name)), rolloutPercent: row?.rollout_percent ?? 100, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null, supported };
}
export async function listFeatureFlags(): Promise<RuntimeFeatureFlag[]> {
  const rows = await db.prepare("SELECT name,enabled,rollout_percent,revision,updated_at FROM runtime_feature_flags").all() as FlagRow[];
  return FEATURE_NAMES.map((name) => flagValue(name, rows.find((row) => row.name === name)));
}
export function inFeatureRollout(name: FeatureName, subject: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket = createHash("sha256").update(`${name}:${subject.slice(0, 256)}`).digest().readUInt32BE(0) / 0x1_0000_0000 * 100;
  return bucket < percent;
}
export async function featureFlagEnabled(name: FeatureName, subject = "anonymous"): Promise<boolean> {
  if (!featureSupported(name)) return false;
  const row = await db.prepare("SELECT name,enabled,rollout_percent,revision,updated_at FROM runtime_feature_flags WHERE name=?").get(name) as FlagRow | undefined;
  const flag = flagValue(name, row);
  return flag.enabled && inFeatureRollout(name, subject, flag.rolloutPercent);
}
export function featureFlagGuard(name: FeatureName): RequestHandler {
  return (req: AuthedRequest, res, next) => {
    void featureFlagEnabled(name, req.user?.id || req.ip || "anonymous").then((enabled) => {
      if (enabled) next();
      else res.status(503).json({ error: "This feature is temporarily unavailable", code: "FEATURE_DISABLED" });
    }).catch(next);
  };
}
export async function updateFeatureFlag(name: FeatureName, input: { enabled: boolean; rolloutPercent: number; baseRevision: number }): Promise<RuntimeFeatureFlag> {
  if (!FEATURE_NAMES.includes(name) || typeof input.enabled !== "boolean" || !Number.isInteger(input.rolloutPercent) || input.rolloutPercent < 0 || input.rolloutPercent > 100 || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision >= Number.MAX_SAFE_INTEGER) throw Object.assign(new Error("Invalid feature flag update"), { status: 400, code: "INVALID_FLAG" });
  if (input.enabled && !featureSupported(name)) throw Object.assign(new Error("This feature requires supported durable workers"), { status: 409, code: "FEATURE_UNSUPPORTED" });
  return await withTransaction(async () => {
    const existing = await db.prepare("SELECT name,enabled,rollout_percent,revision,updated_at FROM runtime_feature_flags WHERE name=?").get(name) as FlagRow | undefined;
    if ((existing?.revision ?? 0) !== input.baseRevision) throw Object.assign(new Error("Feature flag changed; reload before updating"), { status: 409, code: "FLAG_CONFLICT", currentRevision: existing?.revision ?? 0 });
    const timestamp = now(), revision = input.baseRevision + 1;
    await db.prepare("INSERT INTO runtime_feature_flags(name,enabled,rollout_percent,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,rollout_percent=excluded.rollout_percent,revision=excluded.revision,updated_at=excluded.updated_at")
      .run(name, Number(input.enabled), input.rolloutPercent, revision, timestamp);
    await db.prepare("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(NULL,?,?,?)")
      .run("feature_flag.updated", JSON.stringify({ name, enabled: input.enabled, rolloutPercent: input.rolloutPercent, revision }), timestamp);
    return flagValue(name, { name, enabled: Number(input.enabled), rollout_percent: input.rolloutPercent, revision, updated_at: timestamp });
  });
}
