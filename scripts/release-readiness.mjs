import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EVIDENCE_REQUEST_TIMEOUT_MS = 15_000;
export const EVIDENCE_RETRY_DELAY_MS = 250;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class ReleaseEvidenceError extends Error {
  constructor(code) {
    const valid = code === 'EVIDENCE_REQUEST_INVALID' || code === 'EVIDENCE_UNAVAILABLE';
    super(valid && code === 'EVIDENCE_REQUEST_INVALID' ? 'Release evidence requires a body-free GitHub GET request' : 'Release evidence is unavailable after bounded read attempts');
    this.name = 'ReleaseEvidenceError'; this.code = valid ? code : 'EVIDENCE_UNAVAILABLE';
  }
}

export function validateRelease({ repository, commit, branch = 'main' }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(commit || '') || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) throw new Error('Supply repository, full commit SHA and protected production branch');
  return { repository, commit, branch };
}
export function latestGate(runs, commit, branch) {
  const paths = new Set(['.github/workflows/ci.yml', `.github/workflows/ci.yml@${branch}`, `.github/workflows/ci.yml@refs/heads/${branch}`]);
  const eligible = runs.filter(run => run && run.head_sha === commit && run.head_branch === branch && run.event === 'push' && paths.has(run.path));
  eligible.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  return eligible[0] ?? null;
}
export function successfulGate(runs, commit, branch) {
  const latest = latestGate(runs, commit, branch);
  return latest !== null && latest.status === 'completed' && latest.conclusion === 'success';
}
/** Dependency-free, bounded reads work before npm installation and keep hook
 * credentials out of redirects, error messages, logs and provider responses. */
export async function requestReleaseJson(request, url, init = {}, maximumBytes = 2_000_000, timeoutMs = EVIDENCE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Release evidence request timed out')), timeoutMs);
  let onAbort;
  try {
    const aborted = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    const work = async () => {
      const response = await request(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length')) > maximumBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Release evidence request was rejected');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Release evidence response was empty');
      const chunks = []; let total = 0;
      const cancel = () => { void reader.cancel(controller.signal.reason).catch(() => undefined); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const part = await reader.read();
          controller.signal.throwIfAborted();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maximumBytes) throw new Error('Release evidence response exceeded its limit');
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
      } catch (error) { void reader.cancel(error).catch(() => undefined); throw error; }
      finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    };
    return await Promise.race([work(), aborted]);
  } finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
}

/** One retry is reserved for read-only GitHub evidence. Deploy hooks cannot
 * enter this path, even if somebody passes a GET method by mistake. */
export async function requestReleaseEvidence(request, url, init = {}, {
  sleep = defaultSleep, now = Date.now, timeoutMs = EVIDENCE_REQUEST_TIMEOUT_MS, deadlineMs = Infinity,
} = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new ReleaseEvidenceError('EVIDENCE_REQUEST_INVALID'); }
  if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined || endpoint.origin !== 'https://api.github.com' ||
      endpoint.username || endpoint.password || !endpoint.pathname.startsWith('/repos/') || endpoint.hash ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EVIDENCE_REQUEST_TIMEOUT_MS ||
      !(deadlineMs === Infinity || Number.isFinite(deadlineMs))) throw new ReleaseEvidenceError('EVIDENCE_REQUEST_INVALID');
  const deadline = Math.min(deadlineMs, now() + 2 * timeoutMs + EVIDENCE_RETRY_DELAY_MS);
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = Math.min(timeoutMs, deadline - now());
    if (remaining <= 0) break;
    try { return await requestReleaseJson(request, endpoint.href, { ...init, method: 'GET' }, 2_000_000, remaining); }
    catch {
      if (attempt || now() + EVIDENCE_RETRY_DELAY_MS >= deadline) break;
      await sleep(EVIDENCE_RETRY_DELAY_MS);
    }
  }
  throw new ReleaseEvidenceError('EVIDENCE_UNAVAILABLE');
}

export async function releaseReadiness(env = process.env, request = fetch, evidenceOptions = {}) {
  const target = validateRelease({ repository: env.GITHUB_REPOSITORY, commit: env.RELEASE_COMMIT, branch: env.RELEASE_BRANCH || 'main' });
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Groundwork-release-gate', ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) };
  async function get(path) {
    return requestReleaseEvidence(request, `https://api.github.com/repos/${target.repository}/${path}`, { headers }, evidenceOptions);
  }
  const branch = await get(`branches/${encodeURIComponent(target.branch)}`);
  if (branch.commit?.sha !== target.commit) throw new Error('Requested release is not the current production branch commit');
  const evidence = await get(`actions/workflows/ci.yml/runs?head_sha=${target.commit}&event=push&per_page=100`);
  if (!Array.isArray(evidence.workflow_runs)) throw new Error('GitHub CI evidence is invalid');
  const run = latestGate(evidence.workflow_runs, target.commit, target.branch);
  if (!run || !successfulGate([run], target.commit, target.branch)) throw new Error('Latest matching CI run has not passed');
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      run.repository?.full_name?.toLowerCase() !== target.repository.toLowerCase() || run.head_repository?.full_name?.toLowerCase() !== target.repository.toLowerCase()) throw new Error('CI run does not belong to the release repository');
  if (env.RELEASE_RUN_ID && String(run.id) !== env.RELEASE_RUN_ID || env.RELEASE_RUN_ATTEMPT && String(run.run_attempt) !== env.RELEASE_RUN_ATTEMPT) throw new Error('The triggering CI run is no longer the latest successful attempt');
  const jobs = await get(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.jobs.length > 100 || jobs.total_count !== jobs.jobs.length) throw new Error('CI job evidence is incomplete');
  for (const name of ['verify', 'backup-drill', 'release-gate']) {
    const matching = jobs.jobs.filter(job => job.name === name);
    if (matching.length !== 1 || matching[0].run_id !== run.id || matching[0].head_sha !== target.commit || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') throw new Error('Required CI verification or backup drill has not passed');
  }
  const refreshedEvidence = await get(`actions/workflows/ci.yml/runs?head_sha=${target.commit}&event=push&per_page=100`);
  const refreshed = Array.isArray(refreshedEvidence.workflow_runs) ? latestGate(refreshedEvidence.workflow_runs, target.commit, target.branch) : null;
  if (!refreshed || refreshed.id !== run.id || refreshed.run_attempt !== run.run_attempt || refreshed.status !== 'completed' || refreshed.conclusion !== 'success') throw new Error('CI evidence changed during release verification');
  const current = await get(`branches/${encodeURIComponent(target.branch)}`);
  if (current.commit?.sha !== target.commit) throw new Error('Production branch advanced during release verification');
  return { ok: true, ...target, ciRunId: run.id, ciRunAttempt: run.run_attempt, deploymentPerformed: false, checkedAt: new Date().toISOString() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  releaseReadiness().then(result => console.log(JSON.stringify(result))).catch(error => {
    const code = error instanceof ReleaseEvidenceError ? error.code : 'EVIDENCE_REJECTED';
    console.error(`Release gate refused [${code}]: current production-branch commit and successful matching CI evidence are required.`); process.exitCode = 1;
  });
}
