// Synthetic Linux acceptance only. No authority/provider credentials are read.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createNativeWorkerExecutor } from '../server/dist/nativeWorkerExecutorClient.js';
import { requireUnprivilegedNativeWorkerStatus } from '../server/dist/nativeWorkerClientConfig.js';

const [socketPath, drawingPath, metadataPath, reportPath, mode] = process.argv.slice(2);
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10002); assert.equal(process.getgid(), 10002);
requireUnprivilegedNativeWorkerStatus(await readFile('/proc/self/status', 'utf8'));
assert.ok(socketPath && drawingPath && metadataPath && reportPath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executor = createNativeWorkerExecutor({ socketPath });
const input = (kind, bytes, id) => ({ version: 1, jobId: id.repeat(32), kind, input: { bytes, sourceArtifactId: 'f'.repeat(32), sha256: hash(bytes) } });
if (mode === 'cancel') {
  const controller = new AbortController();
  process.once('SIGUSR1', () => controller.abort());
  await writeFile(reportPath, JSON.stringify({ waitingForCancellation: true, pid: process.pid }));
  await assert.rejects(executor.execute(input('dxf-to-dwg', await readFile(drawingPath), 'd'), controller.signal), { code: 'WORKER_STOPPED' });
  await writeFile(reportPath, JSON.stringify({ cancelled: true }));
} else {
  const checks = [];
  await executor.initialize(); checks.push({ name: 'namespace-identity-filesystem-and-resource-probe', passed: true });
  const drawing = await readFile(drawingPath);
  assert.equal(hash(drawing), JSON.parse(await readFile(metadataPath, 'utf8')).sha256);
  const converted = await executor.execute(input('dxf-to-dwg', drawing, 'a'), new AbortController().signal);
  const dwg = converted.artifacts.find(file => file.filename === 'converted.dwg'); assert.ok(dwg);
  assert.equal(Buffer.from(dwg.bytes).subarray(0, 6).toString('ascii'), 'AC1015');
  const restored = await executor.execute(input('dwg-to-dxf', dwg.bytes, 'b'), new AbortController().signal);
  const dxf = restored.artifacts.find(file => file.filename === 'converted.dxf'); assert.ok(dxf);
  const lines = Buffer.from(dxf.bytes).toString('utf8').trim().split(/\r?\n/), pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) pairs.push([Number(lines[index].trim()), lines[index + 1].trim()]);
  const entities = [];
  for (let index = 0; index < pairs.length; index++) {
    if (pairs[index][0] !== 0 || pairs[index][1] !== 'LINE') continue;
    const values = {};
    for (let next = index + 1; next < pairs.length && pairs[next][0] !== 0; next++) values[pairs[next][0]] = Number(pairs[next][1]);
    entities.push(values);
  }
  assert.ok(entities.some(value => Math.abs(value[10] - 1234) < 1e-6 && Math.abs(value[20] - 2345) < 1e-6 && Math.abs(value[11] - 11234) < 1e-6 && Math.abs(value[21] - 2345) < 1e-6), 'Known 10 m line must survive actual conversion');
  checks.push({ name: 'real-DXF-DWG-DXF-known-line', passed: true, lengthM: 10 });
  const E = 200e9, A = 0.01, I = 8e-6, L = 2;
  const model = { version: 1, model: { version: 1, analysis: 'linear',
    nodes: [{ id: 'fixed', xM: 0, yM: 0, restraints: [true, true, true] }, { id: 'tip', xM: L, yM: 0, restraints: [false, false, false] }],
    members: [{ id: 'member', start: 'fixed', end: 'tip', areaM2: A, inertiaM4: I, elasticModulusPa: E }],
    loadCases: [{ id: 'service', nodal: [{ node: 'tip', fxN: 2000, fyN: -1000, mzNm: 500 }], uniform: [] }],
  } };
  const solver = await executor.execute(input('opensees-static', Buffer.from(JSON.stringify(model)), 'c'), new AbortController().signal);
  assert.equal(solver.summary.verification, 'computed-unvalidated'); assert.equal(solver.summary.declaredVersion, '3.8.0');
  const manifest = JSON.parse(Buffer.from(solver.artifacts.find(file => file.filename === 'secure-nexus-native-result.json').bytes).toString('utf8'));
  assert.equal(manifest.nativeSettings.codeCriteriaAssessed, false); assert.equal(manifest.sourceSha256, solver.summary.sourceSha256);
  for (const file of solver.artifacts) assert.equal(hash(file.bytes), file.sha256);
  const rows = name => Buffer.from(solver.artifacts.find(file => file.filename === name).bytes).toString('utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number));
  const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance);
  const tip = rows('secure-nexus-node-displacements.txt')[1], reaction = rows('secure-nexus-node-reactions.txt')[0];
  close(tip[1], 2000 * L / (E * A)); close(tip[2], -1000 * L ** 3 / (3 * E * I) + 500 * L ** 2 / (2 * E * I)); close(tip[3], -1000 * L ** 2 / (2 * E * I) + 500 * L / (E * I));
  close(reaction[1], -2000, 1e-6); close(reaction[2], 1000, 1e-6); close(reaction[3], 1500, 1e-6);
  checks.push({ name: 'real-OpenSees-output-contract-cantilever-and-equilibrium', passed: true });
  await assert.rejects(executor.execute(input('opensees-static', Buffer.from('exec sh -c unsafe'), 'e'), new AbortController().signal), { code: 'EXECUTION_FAILED' });
  checks.push({ name: 'uploaded-Tcl-rejection', passed: true });
  await writeFile(reportPath, JSON.stringify({ completedAt: new Date().toISOString(), checks, liveAuthorityConnected: false, engineeringStatus: 'computed-unvalidated' }, null, 2));
  console.log(JSON.stringify({ checksPassed: checks.length, evidence: reportPath }));
}
