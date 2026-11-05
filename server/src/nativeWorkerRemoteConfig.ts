import { z } from "zod";
import type { NativeJobKind } from "./nativeAdapters.js";

export type NativeWorkerRemoteEnvironment = Readonly<Record<string, string | undefined>>;
export interface NativeWorkerRegistration { readonly id: string; readonly tokenSha256: string; readonly projectIds: readonly string[]; readonly kinds: readonly NativeJobKind[] }
export class NativeWorkerRemoteConfigurationError extends Error {
  constructor() { super("Remote native worker configuration is unavailable"); this.name = "NativeWorkerRemoteConfigurationError"; }
}
const registrationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)).min(1).max(128),
  kinds: z.array(z.enum(["dwg-to-dxf", "dxf-to-dwg", "opensees-static"])).min(1).max(3),
}).strict();
/** Pure configuration reader: no dotenv, application storage, database, keys
 * or native programs. Registration is configured scope, not worker health. */
export function readNativeWorkerRegistrations(env: NativeWorkerRemoteEnvironment = process.env): readonly NativeWorkerRegistration[] {
  if (env.NATIVE_REMOTE_WORKER_ENABLED !== "true") return [];
  try {
    const text = env.NATIVE_REMOTE_WORKERS_JSON;
    if (!text || Buffer.byteLength(text) > 65_536) throw new Error();
    const entries = z.array(registrationSchema).min(1).max(16).parse(JSON.parse(text));
    if (new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some(entry => new Set(entry.projectIds).size !== entry.projectIds.length || new Set(entry.kinds).size !== entry.kinds.length)) throw new Error();
    return Object.freeze(entries.map(entry => Object.freeze({ ...entry, projectIds: Object.freeze(entry.projectIds), kinds: Object.freeze(entry.kinds) })));
  } catch { throw new NativeWorkerRemoteConfigurationError(); }
}
export function remoteNativeWorkerConfiguredFor(projectId: string, kind: NativeJobKind, env: NativeWorkerRemoteEnvironment = process.env): boolean {
  try { return readNativeWorkerRegistrations(env).some(worker => worker.projectIds.includes(projectId) && worker.kinds.includes(kind)); }
  catch { return false; }
}
