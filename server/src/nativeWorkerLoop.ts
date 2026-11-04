/** Transport/lifecycle seam only. No database, environment, HTTP or filesystem
 * dependencies are loaded here. Execution owns fenced terminal publication. */
export interface NativeWorkerDependencies<Claim> {
  initialize?(): Promise<void>;
  beforeClaim?(): Promise<void>;
  claim(): Promise<Claim | null>;
  renew(claim: Claim): Promise<boolean>;
  execute(claim: Claim, signal: AbortSignal, renew: () => Promise<boolean>): Promise<void>;
  onError?(): void;
}
export interface NativeWorkerLoopOptions { pollMs?: number; heartbeatMs?: number }

export function startNativeWorkerLoop<Claim>(dependencies: NativeWorkerDependencies<Claim>, options: NativeWorkerLoopOptions = {}): { stop(): Promise<void> } {
  const pollMs = options.pollMs ?? 1000, heartbeatMs = options.heartbeatMs ?? 3000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 10_000) {
    throw new Error("Native worker polling/heartbeat intervals exceed the supported bounds");
  }
  let stopping = false, initialized = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let inFlight: Promise<void>;
  let stopPromise: Promise<void> | undefined;
  function reportError(): void { try { dependencies.onError?.(); } catch { /* Diagnostics must not kill lease recovery. */ } }

  async function tick(): Promise<void> {
    try {
      if (stopping) return;
      if (!initialized) { await dependencies.initialize?.(); initialized = true; }
      if (stopping) return;
      await dependencies.beforeClaim?.();
      if (stopping) return;
      const claim = await dependencies.claim();
      if (claim === null || stopping) return;
      const controller = new AbortController();
      active = controller;
      let completed = false;
      let renewing: Promise<boolean> | undefined;
      function renew(): Promise<boolean> {
        if (renewing) return renewing;
        if (stopping || controller.signal.aborted) return Promise.resolve(false);
        renewing = Promise.resolve().then(() => dependencies.renew(claim as Claim)).then(value => {
          if (!value) controller.abort();
          return value;
        }, () => { controller.abort(); return false; }).finally(() => { renewing = undefined; });
        return renewing;
      }
      function scheduleHeartbeat(): void {
        if (completed || stopping || controller.signal.aborted) return;
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = undefined;
          // Re-arm only after this renewal settles: no overlapping requests.
          void renew().then(() => scheduleHeartbeat());
        }, heartbeatMs);
      }
      try {
        if (!await renew() || stopping || controller.signal.aborted) return;
        scheduleHeartbeat();
        await dependencies.execute(claim, controller.signal, renew);
      } finally {
        completed = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
        // A late renew must settle before the caller can close its transport/DB
        // or before another claim starts, even after execution has returned.
        await renewing;
        active = undefined;
      }
    } catch { reportError(); }
    finally { if (!stopping) pollTimer = setTimeout(dispatch, pollMs); }
  }
  function dispatch(): void { pollTimer = undefined; inFlight = tick(); }
  // Start after the handle exists, allowing stop() before initialization.
  inFlight = Promise.resolve().then(tick);
  return { stop() {
    if (!stopPromise) {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      active?.abort();
      stopPromise = inFlight.then(() => undefined);
    }
    return stopPromise;
  } };
}
