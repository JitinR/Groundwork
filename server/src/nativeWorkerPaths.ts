/** Exact machine-only paths; this grants no authority. The mounted router must
 * still authenticate its dedicated credential and each job's lease grant. */
export function isNativeWorkerMachinePath(method: string, pathname: string): boolean {
  return method === "POST" && /^\/native-worker\/v1\/(?:claim|jobs\/[a-f0-9]{32}\/(?:renew|input|output|complete|fail))$/.test(pathname);
}
