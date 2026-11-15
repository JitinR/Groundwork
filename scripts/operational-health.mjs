import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { requestReleaseJson } from './release-readiness.mjs';

// Resolve the mail transport from its owning workspace, including nested installs.
const nodemailer = createRequire(new URL('../server/package.json', import.meta.url))('nodemailer');

export function allowedOrigin(value, allowlist, { isolated = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('An explicit health origin is required'); }
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || (!local && url.protocol !== 'https:') || (local && !['http:', 'https:'].includes(url.protocol))) throw new Error('Use an exact HTTPS origin (loopback HTTP allowed for isolated checks)');
  const allowed = (allowlist || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!allowed.includes(url.origin)) throw new Error('Origin is absent from the explicit allowlist');
  if (isolated && !local && !url.hostname.endsWith('.vercel.app')) throw new Error('Performance checks support loopback or an explicitly approved isolated Vercel deployment');
  return url.origin;
}
export async function probe(origin, { fetcher = fetch, timeoutMs = 15000 } = {}) {
  const started = performance.now(), abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher(`${origin}/api/health`, { signal: abort.signal, redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) return { ok: false, status: response.status, reason: 'health_response', durationMs: Math.round(performance.now() - started) };
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); throw new Error('health_body_limit'); } chunks.push(Buffer.from(value)); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: body.ok === true, status: response.status, reason: body.ok === true ? 'healthy' : 'health_state', durationMs: Math.round(performance.now() - started) };
  } catch { return { ok: false, status: null, reason: 'network_or_invalid_health', durationMs: Math.round(performance.now() - started) }; }
  finally { clearTimeout(timer); }
}
export async function alert(report, env = process.env, createTransport = nodemailer.createTransport) {
  if (env.OPS_SEND_ALERTS !== '1') return { sent: false, reason: 'alerts_not_enabled' };
  const email = /^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/;
  if (!email.test(env.OPS_ALERT_TO || '') || !email.test(env.MAIL_FROM || '') || !env.MAIL_HOST || !env.MAIL_USER || !env.MAIL_PASS) throw new Error('Private SMTP and an explicitly authorized recipient are required');
  const port = Number(env.MAIL_PORT || 465);
  if (![465, 587].includes(port)) throw new Error('Operational SMTP requires TLS port 465 or 587');
  const transport = createTransport({ host: env.MAIL_HOST, port, secure: port === 465, requireTLS: true, auth: { user: env.MAIL_USER, pass: env.MAIL_PASS }, tls: { rejectUnauthorized: true }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, logger: false, debug: false });
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to: env.OPS_ALERT_TO, subject: '[Groundwork] Operational check failed', text: `Groundwork operational check failed after ${report.samples.length} health attempts.\nTarget: ${report.origin}\nUTC: ${report.checkedAt}\nReason: ${report.reason || report.samples.at(-1).reason}\nInspect the GitHub Actions Operations health run and docs/INCIDENTS.md.\nNo customer data or credentials are attached.` });
    return { sent: true };
  } finally { transport.close(); }
}
export async function backupFreshness(env = process.env, request = fetch, now = Date.now()) {
  if (env.OPS_BACKUP_ENABLED !== 'true') return { enabled: false };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.GITHUB_TOKEN) return { enabled: true, ok: false, reason: 'backup_evidence_config' };
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  async function get(path) {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('backup_evidence_unavailable');
    return response.json();
  }
  try {
    const data = await get('actions/workflows/operations-backup.yml/runs?status=success&per_page=20');
    const run = data.workflow_runs?.find(value => value.head_branch === env.OPS_DEFAULT_BRANCH && ['schedule', 'workflow_dispatch'].includes(value.event));
    if (!run) return { enabled: true, ok: false, reason: 'backup_success_missing' };
    const ageHours = (now - Date.parse(run.created_at)) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > 26) return { enabled: true, ok: false, reason: 'backup_stale' };
    const { artifacts = [] } = await get(`actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = artifacts.find(value => value.name === `groundwork-encrypted-${run.id}-${run.run_attempt}` && value.expired === false && value.size_in_bytes > 0);
    return { enabled: true, ok: Boolean(artifact), reason: artifact ? 'backup_fresh' : 'backup_artifact_missing', ageHours: Math.round(ageHours * 100) / 100 };
  } catch { return { enabled: true, ok: false, reason: 'backup_evidence_unavailable' }; }
}
export async function monitorCadence(env = process.env, request = fetch, now = Date.now()) {
  const failed = reason => ({ ok: false, reason });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !env.OPS_DEFAULT_BRANCH || !env.GITHUB_TOKEN) return failed('monitor_evidence_config');
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const get = path => requestReleaseJson(request, `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, { headers });
  try {
    const query = new URLSearchParams({ branch: env.OPS_DEFAULT_BRANCH, event: 'schedule', status: 'completed', per_page: '10' });
    const { workflow_runs: runs } = await get(`actions/workflows/operations-health.yml/runs?${query}`);
    const previous = runs.find(run => Number.isSafeInteger(run.id) && run.id > 0 && String(run.id) !== env.GITHUB_RUN_ID &&
      run.head_branch === env.OPS_DEFAULT_BRANCH && run.event === 'schedule' && run.status === 'completed' &&
      Date.parse(run.created_at) <= now && ['success', 'failure'].includes(run.conclusion));
    if (!previous) return failed('monitor_run_missing');
    const { jobs } = await get(`actions/runs/${previous.id}/attempts/1/jobs?per_page=10`);
    const previousProbe = jobs.find(job => job.name === 'health')?.steps?.find(step =>
      step.name === 'Check external health and send authorized SMTP alert on failure' && step.status === 'completed' &&
      ['success', 'failure'].includes(step.conclusion));
    const completed = Date.parse(previousProbe?.completed_at);
    if (!Number.isFinite(completed) || completed < Date.parse(previous.created_at) || completed > now) return failed('monitor_probe_unverified');
    const ageMs = now - completed;
    const ageMinutes = Math.round(ageMs / 60000);
    if (ageMs > 45 * 60000) return { ...failed('monitor_cadence_gap'), ageMinutes };
    return { ok: true, reason: 'monitor_cadence_fresh', ageMinutes };
  } catch { return failed('monitor_evidence_unavailable'); }
}
export async function checkHealth(env = process.env) {
  const origin = allowedOrigin(env.OPS_HEALTH_ORIGIN, env.OPS_HEALTH_ALLOWED_ORIGINS);
  const samples = [];
  for (let index = 0; index < 3; index++) {
    samples.push(await probe(origin));
    if (samples.at(-1).ok) break;
    if (index < 2) await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const backup = await backupFreshness(env);
  const report = { ok: samples.at(-1).ok && backup.ok !== false, origin, checkedAt: new Date().toISOString(), reason: backup.ok === false ? backup.reason : samples.at(-1).reason, samples, backup };
  if (!report.ok) report.alert = await alert(report, env);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv[2] === '--cadence' ? monitorCadence : checkHealth;
  check().then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }).catch(() => { console.error('External monitoring failed: check the explicit origin allowlist and private alert configuration.'); process.exitCode = 1; });
}
