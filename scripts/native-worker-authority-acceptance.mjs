// Local synthetic HTTPS authority only. Run by the isolated acceptance driver;
// no production configuration, email, provider or remote project is loaded.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import dotenv from 'dotenv';

const [certificatePath, keyPath, directory, statePath, tokenSha256, drawingPath] = process.argv.slice(2);
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10003);
assert.match(tokenSha256, /^[a-f0-9]{64}$/);
dotenv.config = () => ({ parsed: {} });
Object.assign(process.env, {
  NODE_ENV: 'test', GROUNDWORK_DATA_DIR: directory, DB_PATH: '', MASTER_KEY: randomBytes(32).toString('base64'), PREVIOUS_MASTER_KEY: '',
  DATABASE_PROVIDER: 'sqlite', DATABASE_URL: '', SUPABASE_DB_URL: '', DATABASE_ADMIN_URL: '', DATABASE_SSL_CA_FILE: '',
  PAYMENTS_MODE: 'demo', MAIL_PROVIDER: 'console', BIND_HOST: '127.0.0.1', GROUNDWORK_SERVER_ROLE: 'authority', GROUNDWORK_AUTHORITY_GATEWAY_MODE: 'direct',
  GROUNDWORK_AUTHORITY_URL: '', GROUNDWORK_SERVERLESS: '', VERCEL: '', NATIVE_WORKER_ENABLED: 'false', NATIVE_REMOTE_WORKER_ENABLED: 'false',
  TRACE_SAMPLE_PERCENT: '0', ALERT_TO: '',
});
const { app } = await import('../server/dist/index.js');
const { db, now } = await import('../server/dist/db.js');
const { randomId } = await import('../server/dist/crypto.js');
const { createSession } = await import('../server/dist/security.js');
const { createWorkspaceArtifact } = await import('../server/dist/workspaces.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const certificate = await readFile(certificatePath), key = await readFile(keyPath);
const server = createServer({ cert: certificate, key }, app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, origin = `https://127.0.0.1:${port}`;
const stop = new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
const checks = [];
async function user() {
  const userId = randomId(), cookies = [];
  await db.prepare('INSERT INTO users(id,email,email_verified,password_salt,password_hash,password_changed_at,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)').run(userId, `${userId}@example.test`, 'synthetic-salt', 'synthetic-hash', now(), now(), now());
  const session = await createSession({ cookie(name, value) { cookies.push(`${name}=${value}`); } }, userId);
  return { actor: { userId, sessionId: session.sessionId }, cookie: cookies.join('; '), csrf: session.csrfToken };
}
async function api(path, options = {}, who) {
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port, path, method: options.method || 'GET', ca: certificate,
      headers: { ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, res => {
      const chunks = []; let length = 0;
      res.on('data', bytes => { length += bytes.length; if (length > 34 * 1024 * 1024) req.destroy(new Error('Synthetic response budget exceeded')); else chunks.push(bytes); });
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic request deadline exceeded'))); req.once('error', reject); req.end(body);
  });
}
async function submit(kind, artifact) {
  const response = await api(`/api/projects/${projectId}/jobs`, { method: 'POST', body: { kind, sourceArtifactId: artifact.id, sourceRevision: 0, idempotencyKey: randomId() } }, owner);
  assert.equal(response.status, 202); return JSON.parse(response.bytes).job;
}
async function completed(job) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const response = await api(`/api/projects/${projectId}/jobs/${job.id}`, {}, owner); assert.equal(response.status, 200);
    const saved = JSON.parse(response.bytes).job;
    if (saved.state === 'succeeded') {
      assert.equal(saved.summary.verification, 'computed-unvalidated');
      assert.ok(saved.artifacts.length > 0);
      const files = [];
      for (const artifact of saved.artifacts) {
        const path = `/api/projects/${projectId}/jobs/${job.id}/artifacts/${artifact.id}`;
        const file = await api(path, {}, owner); assert.equal(file.status, 200); assert.equal(sha(file.bytes), file.headers['x-artifact-sha256']);
        assert.equal((await api(path)).status, 401); assert.equal((await api(path, {}, outsider)).status, 404);
        files.push({ name: artifact.name, bytes: file.bytes, sha256: sha(file.bytes) });
      }
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM native_worker_outputs WHERE job_id=?').get(job.id)).count, 0);
      return { saved, files };
    }
    assert.ok(['queued', 'running'].includes(saved.state), 'Synthetic native job failed');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Synthetic native job exceeded its deadline');
}
const owner = await user(), outsider = await user(), projectId = randomId();
try {
  await db.prepare('INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, owner.actor.userId, 'Synthetic sealed worker acceptance', now(), now());
  Object.assign(process.env, { NATIVE_REMOTE_WORKER_ENABLED: 'true', NATIVE_REMOTE_WORKERS_JSON: JSON.stringify([{ id: 'acceptance-worker', tokenSha256, projectIds: [projectId], kinds: ['dxf-to-dwg', 'dwg-to-dxf', 'opensees-static'] }]) });
  const drawing = await readFile(drawingPath), source = await createWorkspaceArtifact(projectId, 'exchange', owner.actor, 'source.dxf', drawing);
  const first = await submit('dxf-to-dwg', source);
  await writeFile(statePath, JSON.stringify({ phase: 'ready', origin }));
  const converted = await completed(first), dwg = converted.files.find(file => file.name === 'converted.dwg'); assert.ok(dwg); assert.equal(dwg.bytes.subarray(0, 6).toString('ascii'), 'AC1015');
  checks.push({ name: 'HTTPS-submit-claim-real-DXF-DWG-publish-authorized-download', passed: true });
  const backSource = await createWorkspaceArtifact(projectId, 'exchange', owner.actor, 'roundtrip.dwg', dwg.bytes);
  const back = await completed(await submit('dwg-to-dxf', backSource)); assert.ok(back.files.find(file => file.name === 'converted.dxf'));
  checks.push({ name: 'HTTPS-real-DWG-DXF-return-path', passed: true });
  const model = { version: 1, model: { version: 1, analysis: 'linear', nodes: [{ id: 'fixed', xM: 0, yM: 0, restraints: [true, true, true] }, { id: 'tip', xM: 2, yM: 0, restraints: [false, false, false] }], members: [{ id: 'member', start: 'fixed', end: 'tip', areaM2: .01, inertiaM4: 8e-6, elasticModulusPa: 200e9 }], loadCases: [{ id: 'service', nodal: [{ node: 'tip', fxN: 2000, fyN: -1000, mzNm: 500 }], uniform: [] }] } };
  const modelSource = await createWorkspaceArtifact(projectId, 'engineering', owner.actor, 'model.json', Buffer.from(JSON.stringify(model)));
  const solver = await completed(await submit('opensees-static', modelSource));
  const manifest = JSON.parse(solver.files.find(file => file.name === 'secure-nexus-native-result.json').bytes);
  assert.equal(manifest.runtimeVersion, '3.8.0'); assert.equal(manifest.sourceSha256, modelSource.sha256); assert.equal(manifest.nativeSettings.codeCriteriaAssessed, false);
  const values = solver.files.find(file => file.name === 'secure-nexus-node-displacements.txt').bytes.toString('utf8').trim().split(/\r?\n/)[1].trim().split(/\s+/).map(Number);
  assert.ok(Math.abs(values[1] - 2e-6) < 1e-10); assert.ok(Math.abs(values[2] - (-1000 * 8 / (3 * 200e9 * 8e-6) + 500 * 4 / (2 * 200e9 * 8e-6))) < 1e-10);
  checks.push({ name: 'HTTPS-real-OpenSees-source-binding-and-reference', passed: true });
  checks.push({ name: 'anonymous-and-other-account-output-denied', passed: true });
  await writeFile(statePath, JSON.stringify({ phase: 'accepted', origin, completedAt: new Date().toISOString(), checks, productionConnected: false, engineeringStatus: 'computed-unvalidated' }, null, 2));
  await stop;
} catch {
  await writeFile(statePath, JSON.stringify({ phase: 'failed', code: 'SYNTHETIC_AUTHORITY_ACCEPTANCE_FAILED' }));
  process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const { drainTelemetry } = await import('../server/dist/telemetry.js'); await drainTelemetry(); await db.close();
}
