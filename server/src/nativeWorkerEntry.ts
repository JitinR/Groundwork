import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeWorkerClientConfiguration, NativeWorkerConfigurationError, type NativeWorkerIdentity } from "./nativeWorkerClientConfig.js";
import { startDedicatedNativeWorker, type NativeWorkerDiagnostic, type NativeWorkerExecutor } from "./nativeWorkerClient.js";

interface ExecutorConnection { execute: NativeWorkerExecutor; initialize(): Promise<void> }
export interface NativeWorkerEntryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  identity?: NativeWorkerIdentity;
  createExecutor?(options: { socketPath: string }): ExecutorConnection | Promise<ExecutorConnection>;
  report?(code: NativeWorkerDiagnostic): void;
}

/** Dedicated client entry point: no dotenv or authority imports. Production
 * installation supplies only these worker modules, its secret and Unix socket. */
export async function startNativeWorkerEntry(options: NativeWorkerEntryOptions = {}): Promise<{ stop(): Promise<void> }> {
  const configuration = await readNativeWorkerClientConfiguration(options.env, options.identity);
  const createExecutor = options.createExecutor ?? (async (settings: { socketPath: string }) => {
    // Fixed local URL, never an environment/provider supplied module path.
    const module = await import(new URL("./nativeWorkerExecutorClient.js", import.meta.url).href) as { createNativeWorkerExecutor(options: { socketPath: string }): ExecutorConnection };
    return module.createNativeWorkerExecutor(settings);
  });
  const executor = await createExecutor({ socketPath: configuration.executorSocketPath });
  if (!executor || typeof executor.execute !== "function" || typeof executor.initialize !== "function") throw new NativeWorkerConfigurationError();
  // Fail startup before making a queue claim if the isolated broker is absent
  // or its confinement probe fails. An injected lifecycle alone is not safety.
  await executor.initialize();
  const worker = startDedicatedNativeWorker(configuration, { execute: executor.execute, report: options.report });
  let stopping: Promise<void> | undefined;
  const signal = () => { void stop().catch(() => { process.exitCode = 1; }); };
  function stop(): Promise<void> {
    if (!stopping) {
      stopping = worker.stop().finally(() => { process.off("SIGTERM", signal); process.off("SIGINT", signal); });
    }
    return stopping;
  }
  process.once("SIGTERM", signal); process.once("SIGINT", signal);
  return { stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startNativeWorkerEntry({ report: code => console.log(`[groundwork-native-worker] ${code}`) }).catch(error => {
    console.error(error instanceof NativeWorkerConfigurationError ? "[groundwork-native-worker] configuration_refused" : "[groundwork-native-worker] executor_unavailable");
    process.exitCode = 78;
  });
}
