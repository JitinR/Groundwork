import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGate, releaseReadiness, requestReleaseJson, requestReleaseEvidence, ReleaseEvidenceError, validateRelease } from './release-readiness.mjs';

export const DEPLOYMENT_REPOSITORY = 'jitinraavi/Secure-Nexus';
export const DEPLOYMENT_PROJECT = 'prj_1blxFgztH32acCvngFaCVr4MqdGJ';
export const PREVIEW_CI_WAIT_MS = 30 * 60_000;
export const PREVIEW_CI_POLL_MS = 2 * 60_000;
export const PREVIEW_CI_MAX_POLLS = 16;
export const DEPLOY_HOOK_ACK_TIMEOUT_MS = 60_000;

const deliveryMessages = Object.freeze({
  RELEASE_CONFIGURATION_INVALID: 'Release event, target or build configuration is invalid; no hook was sent.',
  EVIDENCE_UNAVAILABLE: 'Read-only CI evidence is unavailable after bounded attempts; no hook was sent.',
  EVIDENCE_REJECTED: 'Exact current commit and required successful CI evidence were not confirmed; no hook was sent.',
  HOOK_CONFIGURATION_INVALID: 'The project-scoped deploy hook configuration is invalid; no hook was sent.',
  HOOK_ACK_UNCONFIRMED: 'Deploy hook acknowledgement was not confirmed; inspect Vercel before retrying. The POST is never retried automatically.',
  PREVIEW_CI_BLOCKED: 'Preview CI is unavailable, pending beyond its deadline, stale or rejected; the build remains blocked.',
  DELIVERY_UNEXPECTED: 'Delivery did not complete; inspect the verified target before taking further action.',
});
export class DeploymentDeliveryError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(deliveryMessages, code) ? code : 'DELIVERY_UNEXPECTED';
    super(deliveryMessages[safeCode]); this.name = 'DeploymentDeliveryError'; this.code = safeCode;
  }
}
export function deploymentFailureDiagnostic(error) {
  const code = error instanceof DeploymentDeliveryError && Object.hasOwn(deliveryMessages, error.code) ? error.code : error instanceof PreviewCiWaitError ? 'PREVIEW_CI_BLOCKED' : 'DELIVERY_UNEXPECTED';
  return `Deployment gate refused [${code}]: ${deliveryMessages[code]}`;
}
async function verifiedRelease(env, request, evidenceOptions) {
  try { return await releaseReadiness(env, request, evidenceOptions); }
  catch (error) { throw new DeploymentDeliveryError(error instanceof ReleaseEvidenceError ? error.code === 'EVIDENCE_REQUEST_INVALID' ? 'RELEASE_CONFIGURATION_INVALID' : 'EVIDENCE_UNAVAILABLE' : 'EVIDENCE_REJECTED'); }
}

export class PreviewCiWaitError extends Error {
  constructor(message) { super(message); this.name = 'PreviewCiWaitError'; }
}

/** Git starts previews before Actions finishes. Wait on one bounded public
 * endpoint, then perform the existing complete release verification afresh.
 * No credential is read from the Vercel environment or forwarded to GitHub. */
export async function waitForPreviewCi(target, request = fetch, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  onProgress = () => undefined,
  evidenceOptions = {},
} = {}) {
  const started = now(), deadline = started + PREVIEW_CI_WAIT_MS;
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Groundwork-preview-gate' };
  async function get(path) {
    try { return await requestReleaseEvidence(request, `https://api.github.com/repos/${target.repository}/${path}`, { headers }, { ...evidenceOptions, sleep, now, deadlineMs: deadline }); }
    catch { throw new PreviewCiWaitError('Preview CI evidence is unavailable; deployment remains blocked.'); }
  }
  const branch = await get(`branches/${encodeURIComponent(target.branch)}`);
  if (branch.commit?.sha !== target.commit) throw new PreviewCiWaitError('Preview commit is no longer the current branch head; deployment remains blocked.');
  const pending = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
  const paths = new Set(['.github/workflows/ci.yml', `.github/workflows/ci.yml@${target.branch}`, `.github/workflows/ci.yml@refs/heads/${target.branch}`]);
  for (let attempt = 1; attempt <= PREVIEW_CI_MAX_POLLS; attempt += 1) {
    if (attempt > 1 && now() >= deadline) break;
    const evidence = await get(`actions/workflows/ci.yml/runs?head_sha=${target.commit}&event=push&per_page=100`);
    if (!Array.isArray(evidence.workflow_runs) || evidence.workflow_runs.length > 100) throw new PreviewCiWaitError('Preview CI evidence is malformed; deployment remains blocked.');
    for (const item of evidence.workflow_runs) {
      if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || !Number.isSafeInteger(item.run_number) || item.run_number < 1 ||
          !Number.isSafeInteger(item.run_attempt) || item.run_attempt < 1 || !/^[a-f0-9]{40}$/.test(item.head_sha || '') ||
          typeof item.head_branch !== 'string' || item.event !== 'push' || !paths.has(item.path) ||
          item.repository?.full_name?.toLowerCase() !== target.repository.toLowerCase() ||
          item.head_repository?.full_name?.toLowerCase() !== target.repository.toLowerCase() ||
          !(pending.has(item.status) || item.status === 'completed')) throw new PreviewCiWaitError('Preview CI evidence does not match the trusted workflow; deployment remains blocked.');
    }
    const run = latestGate(evidence.workflow_runs, target.commit, target.branch);
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new PreviewCiWaitError('Latest preview CI did not pass; deployment remains blocked.');
      return { polls: attempt, waitedMs: Math.max(0, now() - started) };
    }
    const remaining = deadline - now();
    if (attempt === PREVIEW_CI_MAX_POLLS || remaining < 60_000) break;
    const waitMs = Math.min(PREVIEW_CI_POLL_MS, remaining);
    onProgress({ status: run?.status || 'not_registered', attempt, waitMs });
    await sleep(waitMs);
  }
  throw new PreviewCiWaitError('Preview CI did not finish within 30 minutes; deployment remains blocked.');
}

export function approvedDeployHook(value) {
  let hook;
  try { hook = new URL(value); } catch { throw new Error('A valid production deploy hook is required'); }
  const path = new RegExp(`^/v1/integrations/deploy/${DEPLOYMENT_PROJECT}/[A-Za-z0-9_-]{10,256}$`);
  if (hook.origin !== 'https://api.vercel.com' || hook.username || hook.password || hook.search || hook.hash || !path.test(hook.pathname)) throw new Error('The deploy hook must belong to the configured Vercel project');
  return hook;
}
export function vercelBuildTarget(env) {
  if (!['production', 'preview'].includes(env.VERCEL_ENV)) throw new Error('The Vercel deployment environment must be explicit');
  const gitRepository = env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
  if (gitRepository && gitRepository.toLowerCase() !== DEPLOYMENT_REPOSITORY.toLowerCase()) throw new Error('Vercel Git metadata does not match the configured repository');
  if (env.VERCEL_GIT_COMMIT_SHA && env.GROUNDWORK_RELEASE_COMMIT && env.VERCEL_GIT_COMMIT_SHA !== env.GROUNDWORK_RELEASE_COMMIT) throw new Error('Explicit release commit disagrees with Vercel Git metadata');
  if (env.VERCEL_GIT_COMMIT_REF && env.GROUNDWORK_RELEASE_BRANCH && env.VERCEL_GIT_COMMIT_REF !== env.GROUNDWORK_RELEASE_BRANCH) throw new Error('Explicit release branch disagrees with Vercel Git metadata');
  const branch = env.VERCEL_GIT_COMMIT_REF || env.GROUNDWORK_RELEASE_BRANCH || (env.VERCEL_ENV === 'production' ? 'main' : '');
  if (env.VERCEL_ENV === 'production' && branch !== 'main') throw new Error('Production deployments require the main branch');
  return validateRelease({ repository: DEPLOYMENT_REPOSITORY, commit: env.VERCEL_GIT_COMMIT_SHA || env.GROUNDWORK_RELEASE_COMMIT, branch });
}
/** Vercel executes this before building Git-hook or CLI deployments. Preview
 * commits require successful CI for their own branch; production requires main.
 * Public GitHub evidence needs no persistent Vercel-side GitHub credential. */
export async function guardVercelBuild(env = process.env, request = fetch, waitOptions = {}) {
  let target;
  try { target = vercelBuildTarget(env); } catch { throw new DeploymentDeliveryError('RELEASE_CONFIGURATION_INVALID'); }
  if (env.VERCEL_ENV === 'preview') await waitForPreviewCi(target, request, waitOptions);
  const evidence = await verifiedRelease({ GITHUB_REPOSITORY: target.repository, RELEASE_COMMIT: target.commit, RELEASE_BRANCH: target.branch }, request, waitOptions.evidenceOptions);
  return { ...evidence, environment: env.VERCEL_ENV, buildPermitted: true };
}
/** A workflow_run job receives only its short-lived read-only GitHub token and
 * this one project-scoped hook. A lost POST acknowledgement is never retried. */
export async function deployAfterCi(env = process.env, request = fetch, { checkOnly = false, evidenceOptions = {}, hookTimeoutMs = DEPLOY_HOOK_ACK_TIMEOUT_MS } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REPOSITORY !== DEPLOYMENT_REPOSITORY || env.RELEASE_BRANCH !== 'main' ||
      !/^[1-9]\d*$/.test(env.RELEASE_RUN_ID || '') || !/^[1-9]\d*$/.test(env.RELEASE_RUN_ATTEMPT || '') ||
      !Number.isSafeInteger(hookTimeoutMs) || hookTimeoutMs < 1 || hookTimeoutMs > DEPLOY_HOOK_ACK_TIMEOUT_MS) throw new DeploymentDeliveryError('RELEASE_CONFIGURATION_INVALID');
  try { validateRelease({ repository: env.GITHUB_REPOSITORY, commit: env.RELEASE_COMMIT, branch: env.RELEASE_BRANCH }); }
  catch { throw new DeploymentDeliveryError('RELEASE_CONFIGURATION_INVALID'); }
  const evidence = await verifiedRelease(env, request, evidenceOptions);
  if (checkOnly) return { ...evidence, hookTriggered: false };
  let hook;
  try { hook = approvedDeployHook(env.VERCEL_DEPLOY_HOOK); } catch { throw new DeploymentDeliveryError('HOOK_CONFIGURATION_INVALID'); }
  let result;
  try { result = await requestReleaseJson(request, hook.href, { method: 'POST', headers: { accept: 'application/json' } }, 16_384, hookTimeoutMs); }
  catch { throw new DeploymentDeliveryError('HOOK_ACK_UNCONFIRMED'); }
  if (!result?.job || typeof result.job.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(result.job.id) || result.job.state !== 'PENDING') throw new DeploymentDeliveryError('HOOK_ACK_UNCONFIRMED');
  return { ...evidence, hookTriggered: true, deploymentJobId: result.job.id, deploymentState: result.job.state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const action = args.length === 1 && args[0] === '--build-guard' ? (env => guardVercelBuild(env, fetch, { onProgress: ({ status }) => console.log(`Preview CI ${status}; waiting for the exact commit before building (up to 30 minutes).`) })) : args.length === 1 && args[0] === '--check' ? (env => deployAfterCi(env, fetch, { checkOnly: true })) : args.length === 0 ? deployAfterCi : null;
  if (!action) { console.error('Use --build-guard, --check, or no arguments for the authorized CI hook trigger.'); process.exitCode = 1; }
  else action().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(deploymentFailureDiagnostic(error)); process.exitCode = 1; });
}
