import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { NativeJobKind } from "./nativeAdapters.js";

export interface NativeWorkerClientConfiguration {
  authorityOrigin: string;
  workerId: string;
  token: string;
  kinds: readonly NativeJobKind[];
  executorSocketPath: string;
}
export class NativeWorkerConfigurationError extends Error {
  constructor() { super("Dedicated native worker configuration was refused"); this.name = "NativeWorkerConfigurationError"; }
}
type Environment = Readonly<Record<string, string | undefined>>;
export interface NativeWorkerIdentity { platform: string; uid: number | undefined }
const kinds = new Set<NativeJobKind>(["dwg-to-dxf", "dxf-to-dwg", "opensees-static"]);
const ownEnvironment = new Set([
  "GROUNDWORK_WORKER_AUTHORITY_ORIGIN", "GROUNDWORK_WORKER_ID", "GROUNDWORK_WORKER_TOKEN_FILE",
  "GROUNDWORK_WORKER_KINDS", "GROUNDWORK_WORKER_EXECUTOR_SOCKET",
]);
const forbidden = new Set([
  "MASTER_KEY", "PREVIOUS_MASTER_KEY", "DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_DB_URL", "DB_PATH", "GROUNDWORK_DATA_DIR",
  "GROUNDWORK_SERVER_ROLE", "GROUNDWORK_AUTHORITY_GATEWAY_MODE", "GROUNDWORK_AUTHORITY_URL", "GROUNDWORK_GATEWAY_SECRET",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AZURE_CLIENT_ID",
]);
const secretEnvironment = /(?:^|_)(?:PASSWORD|PASS|SECRET|API_KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY)(?:$|_)/;

/** Linux UID separation alone is insufficient if ambient/file capabilities
 * survive or a later exec could gain privilege. The service launcher must set
 * no-new-privileges; this reader never invokes an external privilege helper. */
export function requireUnprivilegedNativeWorkerStatus(status: string): void {
  if (!/^NoNewPrivs:\s+1\s*$/m.test(status) || ["CapInh", "CapPrm", "CapEff", "CapAmb"].some(name => !new RegExp(`^${name}:\\s+0+\\s*$`, "m").test(status))) throw new NativeWorkerConfigurationError();
}

async function privateTokenAncestors(filename: string, uid: number): Promise<void> {
  let directory = path.posix.dirname(filename), direct = true;
  for (;;) {
    const info = await lstat(directory);
    // A protected private child under the root-owned sticky system temp
    // directory is safe; the token's direct parent must itself be private.
    const stickyAncestor = !direct && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid) || ((info.mode & 0o022) !== 0 && !stickyAncestor)) throw new NativeWorkerConfigurationError();
    const parent = path.posix.dirname(directory);
    if (parent === directory) return;
    directory = parent; direct = false;
  }
}

function socketPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !/[\0-\x1f\\]/.test(value);
}
export function validateNativeWorkerClientConfiguration(value: NativeWorkerClientConfiguration): NativeWorkerClientConfiguration {
  try {
    const origin = new URL(value.authorityOrigin);
    if (origin.protocol !== "https:" || !origin.hostname || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        !/^[A-Za-z0-9_-]{8,64}$/.test(value.workerId) || !/^[A-Za-z0-9_-]{43,128}$/.test(value.token) || !socketPath(value.executorSocketPath) ||
        !Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > 3 || new Set(value.kinds).size !== value.kinds.length || value.kinds.some(kind => !kinds.has(kind))) throw new Error();
    return Object.freeze({ authorityOrigin: origin.origin, workerId: value.workerId, token: value.token, executorSocketPath: value.executorSocketPath, kinds: Object.freeze([...value.kinds]) });
  } catch { throw new NativeWorkerConfigurationError(); }
}

/** Reads only the dedicated secret file. Never loads dotenv, application
 * configuration, vault/database modules or an application's server/.env. */
export async function readNativeWorkerClientConfiguration(env: Environment = process.env, identity?: NativeWorkerIdentity): Promise<NativeWorkerClientConfiguration> {
  try {
    const runtime = identity ?? { platform: process.platform, uid: process.getuid?.() };
    if (runtime.platform !== "linux" || !Number.isSafeInteger(runtime.uid) || runtime.uid! <= 0) throw new Error();
    if (identity === undefined) requireUnprivilegedNativeWorkerStatus(await readFile("/proc/self/status", "utf8"));
    for (const [name, value] of Object.entries(env)) {
      if (value && !ownEnvironment.has(name) && (forbidden.has(name) || secretEnvironment.test(name) || name.startsWith("NATIVE_"))) throw new Error();
    }
    const filename = env.GROUNDWORK_WORKER_TOKEN_FILE;
    if (!filename || !path.posix.isAbsolute(filename) || path.posix.normalize(filename) !== filename || /[\0-\x1f\\]/.test(filename) || filename.length > 4096) throw new Error();
    const configuredKinds = (env.GROUNDWORK_WORKER_KINDS || "").split(",").map(value => value.trim());
    // Validate all public settings before opening even the dedicated token file.
    const publicSettings = validateNativeWorkerClientConfiguration({
      authorityOrigin: env.GROUNDWORK_WORKER_AUTHORITY_ORIGIN || "", workerId: env.GROUNDWORK_WORKER_ID || "",
      token: "x".repeat(43), kinds: configuredKinds as NativeJobKind[], executorSocketPath: env.GROUNDWORK_WORKER_EXECUTOR_SOCKET || "",
    });
    await privateTokenAncestors(filename, runtime.uid!);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || ![0, runtime.uid].includes(info.uid) || ![0o400, 0o600].includes(info.mode & 0o7777) ||
          info.size < 43 || info.size > 130 || await realpath(filename) !== path.posix.resolve(filename)) throw new Error();
      // Fixed allocation prevents a concurrently enlarged file causing an
      // unbounded read. The canonical token permits only one trailing newline.
      const bytes = Buffer.alloc(131);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 130) throw new Error();
      const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)).replace(/\r?\n$/, "");
      return validateNativeWorkerClientConfiguration({ ...publicSettings, token });
    } finally { await handle.close(); }
  } catch { throw new NativeWorkerConfigurationError(); }
}
