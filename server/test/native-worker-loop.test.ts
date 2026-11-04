import assert from "node:assert/strict";
import { test } from "node:test";
import { startNativeWorkerLoop } from "../src/nativeWorkerLoop.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker test exceeded its bounded wait")), 2000); })]); }
  finally { clearTimeout(timer); }
}
const aborted = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));

test("stopping before dispatch initializes nothing and returns one idempotent stop promise", async () => {
  let calls = 0;
  const worker = startNativeWorkerLoop({
    initialize: async () => { calls++; }, claim: async () => { calls++; return null; },
    renew: async () => { calls++; return true; }, execute: async () => { calls++; },
  });
  const first = worker.stop();
  assert.equal(worker.stop(), first);
  await within(first);
  assert.equal(calls, 0);
});

test("renewals serialize across heartbeats and explicit checks; stop awaits renewal and execution cleanup", async t => {
  const started = deferred<void>(), renewing = deferred<void>(), releaseRenewal = deferred<boolean>(), releaseCleanup = deferred<void>();
  let renewCalls = 0, claims = 0, concurrent = 0, maximum = 0, stopped = false;
  let checkLease!: () => Promise<boolean>;
  const worker = startNativeWorkerLoop({
    claim: async () => { claims++; return { id: "one" }; },
    renew: async () => {
      renewCalls++; concurrent++; maximum = Math.max(maximum, concurrent);
      try {
        if (renewCalls === 2) { renewing.resolve(); return await releaseRenewal.promise; }
        return true;
      } finally { concurrent--; }
    },
    execute: async (_claim, signal, renew) => { checkLease = renew; started.resolve(); await aborted(signal); await releaseCleanup.promise; },
  }, { pollMs: 1, heartbeatMs: 2 });
  t.after(async () => { releaseRenewal.resolve(true); releaseCleanup.resolve(); await worker.stop(); });
  await within(started.promise);
  await within(renewing.promise);
  const explicit = checkLease();
  assert.equal(renewCalls, 2, "explicit checks must share an outstanding renewal");
  const stop = worker.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  releaseCleanup.resolve();
  await Promise.resolve(); assert.equal(stopped, false, "closing execution must not abandon a transport request");
  releaseRenewal.resolve(true);
  assert.equal(await within(explicit), true);
  await within(stop);
  assert.equal(claims, 1); assert.equal(maximum, 1); assert.equal(renewCalls, 2);
  assert.equal(await checkLease(), false, "a stopped attempt cannot begin another renewal");
});

test("lost initial lease never executes a claimed job", async () => {
  const checked = deferred<void>(); let executed = false;
  const worker = startNativeWorkerLoop({
    claim: async () => "claim", renew: async () => { checked.resolve(); return false; },
    execute: async () => { executed = true; },
  }, { pollMs: 1000, heartbeatMs: 2 });
  await within(checked.promise); await within(worker.stop());
  assert.equal(executed, false);
});

for (const failure of ["lost", "error"] as const) {
  test(`heartbeat ${failure} aborts execution without overlapping requests or continuing the attempt`, async () => {
    const cancelled = deferred<void>(); let calls = 0, signalAborted = false;
    const worker = startNativeWorkerLoop({
      claim: async () => "claim",
      renew: async () => { calls++; if (calls === 1) return true; if (failure === "error") throw new Error("private transport failure"); return false; },
      execute: async (_claim, signal) => { await aborted(signal); signalAborted = signal.aborted; cancelled.resolve(); },
    }, { pollMs: 1000, heartbeatMs: 2 });
    await within(cancelled.promise); await within(worker.stop());
    assert.equal(calls, 2); assert.equal(signalAborted, true);
  });
}

test("stop during claim waits for the request and does not execute its late result", async () => {
  const claiming = deferred<void>(), result = deferred<string | null>(); let executed = false, settled = false;
  const worker = startNativeWorkerLoop({
    claim: async () => { claiming.resolve(); return result.promise; }, renew: async () => true,
    execute: async () => { executed = true; },
  });
  await within(claiming.promise);
  const stop = worker.stop().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  result.resolve("late-claim"); await within(stop);
  assert.equal(executed, false);
});

test("initialization can retry after failure and failing diagnostics cannot kill recovery", async () => {
  const claimed = deferred<void>(); let initializations = 0, diagnostics = 0;
  const worker = startNativeWorkerLoop({
    initialize: async () => { initializations++; if (initializations === 1) throw new Error("private initialization detail"); },
    claim: async () => { claimed.resolve(); return null; }, renew: async () => true, execute: async () => undefined,
    onError: () => { diagnostics++; throw new Error("diagnostic sink unavailable"); },
  }, { pollMs: 1 });
  await within(claimed.promise); await within(worker.stop());
  assert.equal(initializations, 2); assert.equal(diagnostics, 1);
});

test("execution failure releases its heartbeat before another claim and reports no error payload", async () => {
  const second = deferred<void>(); let claims = 0, errors = 0;
  const diagnosticArguments: unknown[][] = [];
  const worker = startNativeWorkerLoop({
    claim: async () => ++claims,
    renew: async () => true,
    execute: async (claim, signal) => { if (claim === 1) throw new Error("private execution detail"); second.resolve(); await aborted(signal); },
    onError: (...args) => { errors++; diagnosticArguments.push(args); },
  }, { pollMs: 1, heartbeatMs: 1000 });
  await within(second.promise); await within(worker.stop());
  assert.equal(claims, 2); assert.equal(errors, 1);
  assert.deepEqual(diagnosticArguments, [[]]);
  for (const options of [{ pollMs: 0 }, { pollMs: Infinity }, { heartbeatMs: 10001 }, { heartbeatMs: 1.5 }]) {
    assert.throws(() => startNativeWorkerLoop({ claim: async () => null, renew: async () => true, execute: async () => undefined }, options), /supported bounds/);
  }
});
