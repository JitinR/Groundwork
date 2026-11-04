import path from "node:path";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { db, now } from "./db.js";
import { NativeAdapterError, runNativeJob } from "./nativeAdapters.js";
import { nativeAdapterConfig, NATIVE_JOBS_ROOT, NATIVE_WORKER_ENABLED } from "./nativeJobsConfig.js";
import { claimNativeJob, failNativeJob, finishNativeJob, renewNativeJob, type NativeJobClaim } from "./nativeJobs.js";
import { readWorkspaceArtifact, WorkspaceError } from "./workspaces.js";
import { startNativeWorkerLoop } from "./nativeWorkerLoop.js";
const ROOT = path.resolve(NATIVE_JOBS_ROOT);
let runningWorker: { stop: () => Promise<void> } | null = null;
function attemptPath(directory: string): boolean {
    return path.dirname(path.resolve(directory)) === ROOT && /^job-[a-f0-9]{32}-[a-f0-9]{32}-[A-Za-z0-9]{6}$/.test(path.basename(directory));
}
async function removeAttempt(directory: string): Promise<void> {
    if (!attemptPath(directory))
        throw new Error("Native job cleanup path is outside the attempt root");
    // rm removes symlink entries without following their targets. The parent is supervisor-owned.
    await rm(directory, { recursive: true, force: true });
}
async function prepareRoot(): Promise<void> {
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
    const stat = await lstat(ROOT);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(ROOT) !== ROOT || (process.getuid && (stat.uid !== process.getuid() || stat.uid === nativeAdapterConfig.sandbox?.uid)))
        throw new Error("Native job root must be a private real directory owned by the queue supervisor");
    await chmod(ROOT, 0o700);
}
async function removeExpiredAttempts(): Promise<void> {
    const entries = await readdir(ROOT, { withFileTypes: true });
    for (const entry of entries) {
        const directory = path.join(ROOT, entry.name);
        if (!attemptPath(directory))
            continue;
        const stat = await lstat(directory);
        if (stat.mtimeMs > Date.now() - 30 * 60000)
            continue;
        const tokens = entry.name.split("-");
        const leased = await db.prepare("SELECT 1 AS found FROM project_native_jobs WHERE id=? AND claim_token=? AND state='running' AND claim_until>?").get(tokens[1], tokens[2], now());
        if (!leased)
            await removeAttempt(directory);
    }
}
/** Legacy durable adapter for an independently reviewed supervisor. Never
 * started by an HTTP authority; this does not supply per-job OS confinement. */
export function startNativeJobWorker(): {
    stop: () => Promise<void>;
} {
    if (!NATIVE_WORKER_ENABLED)
        return { stop: async () => undefined };
    if (runningWorker)
        return runningWorker;
    let cleanAt = 0;
    async function execute(claim: NativeJobClaim, signal: AbortSignal, renew: () => Promise<boolean>): Promise<void> {
        let directory: string | null = null;
        try {
            if (!await renew() || signal.aborted) {
                return;
            }
            const { artifact, bytes } = await readWorkspaceArtifact(claim.projectId, claim.artifactId, claim.actor);
            if (artifact.sha256 !== claim.sha256)
                throw new WorkspaceError(500, "Job source integrity changed", "ARTIFACT_INTEGRITY");
            directory = await mkdtemp(path.join(ROOT, `job-${claim.id}-${claim.token}-`));
            if (!await renew() || signal.aborted) {
                return;
            }
            const result = await runNativeJob({
                kind: claim.kind, config: nativeAdapterConfig, workingDirectory: directory,
                input: { bytes, sourceArtifactId: claim.artifactId, sha256: claim.sha256 }, signal,
            });
            if (!signal.aborted)
                await finishNativeJob(claim, result.artifacts, result.summary);
            else
                await failNativeJob(claim, "WORKER_STOPPED", "Worker stopped before completion; submit again if needed");
        }
        catch (error) {
            const code = error instanceof NativeAdapterError || error instanceof WorkspaceError ? error.code : "NATIVE_JOB_FAILED";
            // Error details and converter output are never interpolated into a public response.
            const messages: Record<string, string> = {
                ARTIFACT_CAPACITY: "Project storage is full. Remove unreferenced artifacts before submitting again.",
                SESSION_EXPIRED: "Submitting session expired before completion.",
                READ_ONLY: "Submitting user no longer has editor access.",
                "adapter-unavailable": "Native runtime or isolation is unavailable.",
                "native-cancelled": "Native operation was cancelled.",
                "native-timeout": "Native operation exceeded the execution time limit.",
                "invalid-source": "Source does not match the supported drawing or frame JSON contract.",
                "invalid-output": "Native output did not meet the supported output contract.",
                "output-limit": "Native operation exceeded its output or resource limit.",
            };
            try {
                await failNativeJob(claim, code, messages[code] || "Native operation failed. Review configuration, supported input and resource limits.");
            }
            catch { /* Persisted lease recovery fences an attempt whose authority could not be reached. */ }
        }
        finally {
            if (directory) {
                try {
                    await removeAttempt(directory);
                }
                catch {
                    console.warn("[groundwork] Native attempt cleanup deferred; private scratch data remains until cleanup succeeds");
                }
            }
        }
    }
    const loop = startNativeWorkerLoop<NativeJobClaim>({
        initialize: prepareRoot,
        beforeClaim: async () => {
            if (Date.now() > cleanAt) {
                await removeExpiredAttempts();
                cleanAt = Date.now() + 60000;
            }
        },
        claim: claimNativeJob,
        renew: renewNativeJob,
        execute,
        onError: () => {
            console.warn("[groundwork] Native job worker is unavailable; queued records remain durable");
        },
    });
    const handle = { stop: async () => {
        await loop.stop();
        if (runningWorker === handle) runningWorker = null;
    } };
    runningWorker = handle;
    return handle;
}
