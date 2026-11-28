import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedOrigin, probe, alert, backupFreshness, monitorCadence, checkMonitorCadence, checkIndependentHealth } from './operational-health.mjs';
import { measure, percentile } from './operational-performance.mjs';

test('operational probes require exact allowlisted origins and isolated performance targets', async () => {
  assert.equal(allowedOrigin('https://fixture.example', 'https://fixture.example'), 'https://fixture.example');
  for (const value of ['https://fixture.example/path', 'https://u:p@fixture.example', 'http://fixture.example', 'https://fixture.example.evil']) assert.throws(() => allowedOrigin(value, 'https://fixture.example'));
  assert.throws(() => allowedOrigin('https://fixture.example', 'https://fixture.example', { isolated: true }));
  await assert.rejects(measure({}), /acknowledgment/);
  await assert.rejects(measure({ OPS_PERF_ACK: 'isolated-target-no-production', OPS_PERF_ORIGIN: 'http://127.0.0.1:4242', OPS_PERF_ALLOWED_ORIGINS: 'http://127.0.0.1:4242', OPS_PERF_ISOLATED_ORIGIN: 'http://127.0.0.1:4242', OPS_PRODUCTION_ORIGINS: 'http://127.0.0.1:4242' }), /Production/);
});
test('health probe rejects HTML, false health, oversized responses and network failure', async () => {
  const check = response => probe('https://fixture.example', { fetcher: async () => response });
  assert.equal((await check(Response.json({ ok: true }))).ok, true);
  assert.equal((await check(Response.json({ ok: false }))).ok, false);
  assert.equal((await check(new Response('<html>login</html>'))).ok, false);
  assert.equal((await check(Response.json({ ok: true, data: 'x'.repeat(9000) }))).ok, false);
  assert.equal((await probe('https://fixture.example', { fetcher: async () => { throw Error('secret'); } })).reason, 'network_or_invalid_health');
});
test('operational alerts are opt-in, TLS-only and never send during tests', async () => {
  let message, config, closed = false;
  const factory = value => { config = value; return { async sendMail(mail) { message = mail; }, close() { closed = true; } }; };
  const report = { origin: 'https://fixture.example', checkedAt: '2026-10-21T00:00:00Z', samples: [{ reason: 'health_state' }] };
  assert.equal((await alert(report, {}, () => assert.fail('disabled alert attempted SMTP'))).sent, false);
  await assert.rejects(alert(report, { OPS_SEND_ALERTS: '1' }, factory), /authorized/);
  await alert(report, { OPS_SEND_ALERTS: '1', OPS_ALERT_TO: 'owner@example.test', MAIL_FROM: 'ops@example.test', MAIL_HOST: 'smtp.example.test', MAIL_USER: 'synthetic', MAIL_PASS: 'synthetic', MAIL_PORT: '587' }, factory);
  assert.equal(config.requireTLS, true); assert.equal(config.tls.rejectUnauthorized, true);
  assert.equal(message.to, 'owner@example.test'); assert.equal(message.text.includes('synthetic'), false); assert.equal(closed, true);
  await alert({ ...report, samples: [], reason: 'monitor_cadence_gap', ageMinutes: 90 },
    { OPS_SEND_ALERTS: '1', OPS_ALERT_TO: 'owner@example.test', MAIL_FROM: 'ops@example.test', MAIL_HOST: 'smtp.example.test', MAIL_USER: 'synthetic', MAIL_PASS: 'synthetic' }, factory);
  assert.match(message.subject, /monitoring cadence/);
  assert.match(message.text, /90 minutes ago/);
  assert.doesNotMatch(message.text, /0 health attempts|synthetic/);
});
test('p99 uses nearest rank over all observed samples', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(values.reverse(), 0.99), 99);
  assert.equal(percentile([1, 100], 0.99), 100);
  assert.throws(() => percentile([], 0.99));
});

test('backup freshness requires recent successful run and an unexpired nonempty encrypted artifact', async () => {
  const now = Date.parse('2026-10-21T03:00:00Z');
  const env = { OPS_BACKUP_ENABLED: 'true', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'synthetic', OPS_DEFAULT_BRANCH: 'main' };
  const run = { id: 123, head_branch: 'main', event: 'schedule', created_at: '2026-10-21T02:41:00Z', run_attempt: 1 };
  const fixture = (updates = {}, artifacts = [{ name: 'groundwork-encrypted-123-1', expired: false, size_in_bytes: 100 }]) => async url => Response.json(url.includes('/artifacts?') ? { artifacts } : { workflow_runs: [{ ...run, ...updates }] });
  assert.equal((await backupFreshness(env, fixture(), now)).ok, true);
  assert.equal((await backupFreshness(env, fixture({ created_at: '2026-10-19T02:41:00Z' }), now)).reason, 'backup_stale');
  assert.equal((await backupFreshness(env, fixture({}, []), now)).reason, 'backup_artifact_missing');
  assert.equal((await backupFreshness(env, fixture({ head_branch: 'preview' }), now)).ok, false);
  assert.equal((await backupFreshness({}, () => assert.fail('disabled freshness performed network access'), now)).enabled, false);
});

test('monitor cadence counts the original scheduled probe, excluding manual and current runs', async () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const env = { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'synthetic', GITHUB_RUN_ID: '30', OPS_DEFAULT_BRANCH: 'main' };
  const prior = { id: 20, head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-11-06T11:00:00Z', run_attempt: 2 };
  const probeStep = { name: 'Check external health and send authorized SMTP alert on failure', status: 'completed', conclusion: 'success', completed_at: '2026-11-06T11:30:00Z' };
  const fixture = (step, runs = [{ ...prior, id: 30 }, { ...prior, id: 25, event: 'workflow_dispatch' }, prior]) => async url => {
    if (url.includes('/operations-health.yml/runs?')) {
      assert.match(url, /branch=main&event=schedule&status=completed/);
      return Response.json({ workflow_runs: runs });
    }
    assert.match(url, /\/actions\/runs\/20\/attempts\/1\/jobs\?/);
    return Response.json({ jobs: [{ name: 'health', steps: step ? [step] : [] }] });
  };
  assert.deepEqual(await monitorCadence(env, fixture(probeStep), now), { ok: true, reason: 'monitor_cadence_fresh', ageMinutes: 30 });
  assert.deepEqual(await monitorCadence(env, fixture({ ...probeStep, completed_at: '2026-11-06T11:14:59Z' }), now), { ok: false, reason: 'monitor_cadence_gap', ageMinutes: 45 });
  assert.equal((await monitorCadence(env, fixture(undefined), now)).reason, 'monitor_probe_unverified');
  assert.equal((await monitorCadence(env, fixture(probeStep, []), now)).reason, 'monitor_run_missing');
  assert.equal((await monitorCadence(env, async () => new Response(null, { status: 503 }), now)).reason, 'monitor_evidence_unavailable');
});

test('independent cadence check detects overdue Actions without a current GitHub run', async () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const env = { GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'synthetic', OPS_DEFAULT_BRANCH: 'main',
    OPS_HEALTH_ORIGIN: 'https://fixture.example', OPS_HEALTH_ALLOWED_ORIGINS: 'https://fixture.example', OPS_SEND_ALERTS: '1' };
  const run = { id: 20, head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-11-06T09:00:00Z' };
  const fixture = completed => async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.includes('/operations-health.yml/runs?')) return Response.json({ workflow_runs: [run] });
    assert.match(url, /\/actions\/runs\/20\/attempts\/1\/jobs\?/);
    return Response.json({ jobs: [{ name: 'health', steps: [{ name: 'Check external health and send authorized SMTP alert on failure', status: 'completed', conclusion: 'success', completed_at: completed }] }] });
  };
  let deliveries = 0;
  const notify = async payload => {
    deliveries += 1;
    assert.equal(payload.origin, env.OPS_HEALTH_ORIGIN);
    assert.equal(payload.reason, 'monitor_cadence_gap');
    assert.equal(payload.ageMinutes, 120);
    return { sent: true };
  };
  const stale = { independent: true, request: fixture('2026-11-06T10:00:00Z'), now, notify };
  assert.deepEqual(await checkMonitorCadence(env, stale), { ok: false, reason: 'monitor_cadence_gap', ageMinutes: 120, alert: { sent: true } });
  assert.deepEqual(await checkMonitorCadence({ ...env, OPS_SEND_ALERTS: '0' }, stale), { ok: false, reason: 'monitor_cadence_gap', ageMinutes: 120 });
  assert.equal((await checkMonitorCadence(env, { ...stale, request: fixture('2026-11-06T11:30:00Z') })).ok, true);
  assert.equal(deliveries, 1);
  const unavailable = await checkMonitorCadence(env, { ...stale, request: async () => new Response(null, { status: 503 }), notify: async () => { throw new Error('SMTP internal detail'); } });
  assert.deepEqual(unavailable, { ok: false, reason: 'monitor_evidence_unavailable', alert: { sent: false, reason: 'alert_delivery_failed' } });
});

test('the independent scheduler probes health without Actions and retries a missed-probe alert', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'groundwork-probe-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = 'https://fixture.example', statePath = join(directory, 'probe-state.json');
  const env = { OPS_HEALTH_ORIGIN: origin, OPS_HEALTH_ALLOWED_ORIGINS: origin, STATE_DIRECTORY: directory, OPS_SEND_ALERTS: '1' };
  let timestamp = Date.parse('2026-11-06T10:00:00Z'), requests = 0, deliveries = 0, healthy = true;
  const options = {
    now: () => timestamp, wait: async () => {},
    request: async (url, requestOptions) => {
      requests++;
      assert.equal(url, `${origin}/api/health`);
      assert.equal(requestOptions.redirect, 'error');
      return Response.json({ ok: healthy }, { status: healthy ? 200 : 503 });
    },
    notify: async (report) => {
      deliveries++;
      if (healthy) {
        assert.equal(report.reason, 'independent_monitor_cadence_gap');
        assert.equal(report.ageMinutes, 60);
        assert.equal(report.samples.length, 0);
        return { sent: deliveries > 1 };
      }
      assert.equal(report.reason, 'health_response');
      assert.equal(report.samples.length, 3);
      return { sent: true };
    },
  };
  const first = await checkIndependentHealth(env, options);
  assert.equal(first.ok, true);
  assert.equal(first.cadence.reason, 'independent_monitor_first_probe');
  timestamp += 15 * 60000;
  assert.equal((await checkIndependentHealth(env, options)).cadence.reason, 'independent_monitor_cadence_fresh');
  timestamp += 60 * 60000;
  const gap = await checkIndependentHealth(env, options);
  assert.equal(gap.ok, false);
  assert.deepEqual(gap.alert, { sent: false });
  timestamp += 15 * 60000;
  assert.deepEqual((await checkIndependentHealth(env, options)).alert, { sent: true });
  timestamp += 15 * 60000;
  assert.equal((await checkIndependentHealth(env, options)).ok, true);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { origin, checkedAt: new Date(timestamp).toISOString() });
  assert.equal((await stat(statePath)).mode & 0o077, 0);

  healthy = false;
  timestamp += 15 * 60000;
  const outage = await checkIndependentHealth(env, options);
  assert.equal(outage.ok, false);
  assert.equal(outage.cadence.ok, true);
  assert.deepEqual(outage.alert, { sent: true });
  assert.equal(requests, 8);
  assert.equal(deliveries, 3);
});
