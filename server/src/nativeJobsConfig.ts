import path from "node:path";
import { DATA_DIR } from "./config.js";
import type { NativeAdapterConfig } from "./nativeAdapters.js";

function absolute(value: string | undefined): string {
  return value && path.isAbsolute(value) ? value : "";
}
function identifier(value: string | undefined): number {
  if (!value || !/^\d{1,9}$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
}

/** Paths are administrator configuration, never request fields. Versions are declarations, not probes. */
export const nativeAdapterConfig: NativeAdapterConfig = {
  libreDwg: {
    dwg2dxfPath: absolute(process.env.NATIVE_DWG2DXF_PATH),
    dxf2dwgPath: absolute(process.env.NATIVE_DXF2DWG_PATH),
    version: process.env.NATIVE_LIBREDWG_VERSION || "",
  },
  openSees: {
    executablePath: absolute(process.env.NATIVE_OPENSEES_PATH),
    version: process.env.NATIVE_OPENSEES_VERSION || "",
  },
  sandbox: {
    uid: identifier(process.env.NATIVE_SANDBOX_UID),
    gid: identifier(process.env.NATIVE_SANDBOX_GID),
    prlimitPath: absolute(process.env.NATIVE_PRLIMIT_PATH),
    acknowledged: process.env.NATIVE_ISOLATION_ACKNOWLEDGED === "true",
  },
  timeoutMs: 90_000,
  maximumInputBytes: 32 * 1024 * 1024,
  maximumOutputBytes: 32 * 1024 * 1024,
};

// Reserved for an independently confined queue supervisor, never an HTTP API.
// The web topology rejects enablement. A remote transport/executor is still
// required; independent database copies are not a shared queue.
export const NATIVE_WORKER_ENABLED = process.env.NATIVE_WORKER_ENABLED === "true";
export const NATIVE_JOBS_ROOT = path.join(DATA_DIR, "native-jobs");
