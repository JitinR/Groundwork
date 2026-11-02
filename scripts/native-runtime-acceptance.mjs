// Run only through run-native-acceptance.sh's isolated, credential-free rootfs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { runNativeJob, getNativeCapabilities, validateNativeInput } from './nativeAdapters.js';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0, 'Trusted acceptance supervisor must be able to drop the native UID');
for (const filename of ['/', '/runtime', '/runtime/bin', '/runtime/bin/OpenSees', '/runtime/bin/dwg2dxf', '/runtime/bin/dxf2dwg', '/usr', '/usr/bin', '/usr/bin/prlimit']) {
  const info = await lstat(filename);
  assert.ok(info.uid === 0 && (info.mode & 0o022) === 0, `Runtime path ${filename} must be root-owned and protected, received UID ${info.uid} mode ${(info.mode & 0o777).toString(8)}`);
}
const namespaces = {};
for (const [index, name] of ['net', 'mnt', 'pid'].entries()) {
  namespaces[name] = await readlink(`/proc/self/ns/${name}`);
  assert.notEqual(namespaces[name], process.argv[index + 2], `${name} namespace must differ from host`);
}
assert.deepEqual(Object.keys(os.networkInterfaces()), [], 'Private network namespace must have no active interfaces');
await assert.rejects(access('/mnt/c'), 'Host Windows filesystem must be absent');
await assert.rejects(access('/home'), 'Host home directories must be absent');
const probe = spawnSync('/usr/bin/node', ['--input-type=module', '-e', `
  import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os';
  assert.equal(process.getuid(),10001); assert.equal(process.getgid(),10001);
  assert.deepEqual(os.networkInterfaces(),{});
  assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+\\s/);
  assert.throws(()=>fs.readFileSync('/proc/1/environ'));
  assert.throws(()=>fs.readFileSync('/proc/${process.pid}/environ'));
  assert.throws(()=>fs.accessSync('/mnt/c')); assert.throws(()=>fs.accessSync('/home'));
`], { uid: 10001, gid: 10001, env: { PATH: '/usr/bin' }, timeout: 5000, encoding: 'utf8' });
assert.equal(probe.status, 0, `Native identity confinement failed: ${probe.stderr}`);
const limitsProbe = spawnSync('/usr/bin/prlimit', ['--as=536870912', '--cpu=60', '--fsize=33554432', '--nproc=32', '--nofile=64', '--',
  '/usr/bin/prlimit', '--pid=0', '--output=RESOURCE,SOFT,HARD', '--noheadings', '--raw'],
  { uid: 10001, gid: 10001, env: { PATH: '/usr/bin' }, timeout: 5000, encoding: 'utf8' });
assert.equal(limitsProbe.status, 0, `Resource limit probe failed: ${limitsProbe.stderr}`);
const measuredLimits = Object.fromEntries(limitsProbe.stdout.trim().split(/\r?\n/).map(line => {
  const [name, soft, hard] = line.trim().split(/\s+/); return [name, { soft, hard }];
}));
for (const [name, value] of Object.entries({ AS: '536870912', CPU: '60', FSIZE: '33554432', NPROC: '32', NOFILE: '64' })) {
  assert.deepEqual(measuredLimits[name], { soft: value, hard: value }, `${name} kernel resource limits must be enforced`);
}

const config = {
  libreDwg: { dwg2dxfPath: '/runtime/bin/dwg2dxf', dxf2dwgPath: '/runtime/bin/dxf2dwg', version: '0.13.4' },
  openSees: { executablePath: '/runtime/bin/OpenSees', version: '3.8.0' },
  sandbox: { uid: 10001, gid: 10001, prlimitPath: '/usr/bin/prlimit', acknowledged: true },
  timeoutMs: 90_000,
};
assert.ok(getNativeCapabilities(config).every(item => item.available && item.runtimeVerified === false));
assert.ok(getNativeCapabilities({ ...config, sandbox: { ...config.sandbox, acknowledged: false } }).every(item => !item.available));
assert.ok(!getNativeCapabilities({ ...config, openSees: { ...config.openSees, version: '3.7.1' } }).find(item => item.kind === 'opensees-static').available);
const checks = [{ name: 'Private namespaces, filesystem boundary, unprivileged identity and measured kernel resource limits', passed: true }];
const hash = value => createHash('sha256').update(value).digest('hex');
let counter = 0;
async function run(kind, input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const workingDirectory = `/jobs/case-${++counter}`;
  await mkdir(workingDirectory, { mode: 0o700 });
  try {
    return await runNativeJob({ kind, config, workingDirectory, input: { bytes, sha256: hash(bytes), sourceArtifactId: `synthetic-${counter}` }, signal: new AbortController().signal, ...options });
  } catch (error) {
    // Only the four positive synthetic cases get bounded local diagnostics.
    // Diagnostics never replace the adapter result or turn a failure into a pass.
    if (counter <= 4) {
      const executable = kind === 'opensees-static' ? config.openSees.executablePath : kind === 'dxf-to-dwg' ? config.libreDwg.dxf2dwgPath : config.libreDwg.dwg2dxfPath;
      const args = kind === 'opensees-static' ? ['secure-nexus-frame.tcl'] : ['--as=r2000', kind === 'dxf-to-dwg' ? 'input.dxf' : 'input.dwg'];
      const diagnostics = spawnSync(config.sandbox.prlimitPath, ['--as=536870912', '--cpu=60', '--fsize=33554432', '--nproc=32', '--nofile=64', '--', executable, ...args],
        { cwd: workingDirectory, uid: config.sandbox.uid, gid: config.sandbox.gid, env: { PATH: '/runtime/bin', HOME: workingDirectory, TMPDIR: workingDirectory, LANG: 'C', LC_ALL: 'C' }, timeout: 10000, maxBuffer: 16384, encoding: 'utf8' });
      console.error(JSON.stringify({ case: counter, kind, code: error.code, nativeStatus: diagnostics.status, signal: diagnostics.signal, stdout: diagnostics.stdout?.slice(-3000), stderr: diagnostics.stderr?.slice(-3000) }));
    }
    throw error;
  }
}
function artifact(result, name) {
  const file = result.artifacts.find(item => item.filename === name);
  assert.ok(file, `${name} missing`); assert.equal(file.sha256, hash(file.bytes));
  return Buffer.from(file.bytes).toString('utf8');
}
function rows(result, name) { return artifact(result, name).trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)); }
function close(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${expected}, received ${actual}`); }
const E = 200e9, A = 0.01, I = 8e-6, L = 2;
const cantilever = {
  version: 1, model: { version: 1, analysis: 'linear',
    nodes: [{ id: 'fixed', xM: 0, yM: 0, restraints: [true, true, true] }, { id: 'tip', xM: L, yM: 0, restraints: [false, false, false] }],
    members: [{ id: 'member', start: 'fixed', end: 'tip', areaM2: A, inertiaM4: I, elasticModulusPa: E }],
    loadCases: [{ id: 'service', nodal: [{ node: 'tip', fxN: 2000, fyN: -1000, mzNm: 500 }], uniform: [] }],
  },
};
const first = await run('opensees-static', JSON.stringify(cantilever));
const tip = rows(first, 'secure-nexus-node-displacements.txt')[1];
close(tip[1], 2000 * L / (E * A));
close(tip[2], -1000 * L ** 3 / (3 * E * I) + 500 * L ** 2 / (2 * E * I));
close(tip[3], -1000 * L ** 2 / (2 * E * I) + 500 * L / (E * I));
const reaction = rows(first, 'secure-nexus-node-reactions.txt')[0];
close(reaction[1], -2000, 1e-6); close(reaction[2], 1000, 1e-6); close(reaction[3], 1500, 1e-6);
const manifest = JSON.parse(artifact(first, 'secure-nexus-native-result.json'));
assert.equal(manifest.runtimeVersion, '3.8.0'); assert.equal(manifest.verification, 'computed-unvalidated');
assert.equal(manifest.nativeSettings.codeCriteriaAssessed, false);
checks.push({ name: 'OpenSees cantilever axial/transverse/end-moment closed forms and global equilibrium', passed: true });

const beam = structuredClone(cantilever);
beam.model.nodes[0].restraints = [true, true, false]; beam.model.nodes[1].restraints = [false, true, false]; beam.model.nodes[1].xM = 4;
beam.model.loadCases[0] = { id: 'service', nodal: [], uniform: [{ member: 'member', axialNPerM: 0, transverseNPerM: -1000 }] };
const second = await run('opensees-static', JSON.stringify(beam));
const beamDisplacements = rows(second, 'secure-nexus-node-displacements.txt');
close(beamDisplacements[0][3], -1000 * 4 ** 3 / (24 * E * I)); close(beamDisplacements[1][3], 1000 * 4 ** 3 / (24 * E * I));
for (const row of rows(second, 'secure-nexus-node-reactions.txt')) close(row[2], 2000, 1e-6);
checks.push({ name: 'OpenSees simply supported uniform-load slopes and reactions', passed: true });

const dxf = await readFile('/app/source.dxf');
const source = JSON.parse(await readFile('/app/source.json', 'utf8'));
assert.equal(hash(dxf), source.sha256, 'Synthetic fixture fingerprint must match');
const toDwg = await run('dxf-to-dwg', dxf);
const dwg = toDwg.artifacts.find(item => item.filename === 'converted.dwg').bytes;
assert.equal(Buffer.from(dwg).subarray(0, 6).toString('ascii'), 'AC1015');
const toDxf = await run('dwg-to-dxf', dwg);
const roundtrip = artifact(toDxf, 'converted.dxf');
validateNativeInput('dxf-to-dwg', Buffer.from(roundtrip));
const lines = roundtrip.trim().split(/\r?\n/), entities = [];
for (let index = 0; index < lines.length - 1; index += 2) {
  if (lines[index].trim() !== '0' || lines[index + 1].trim() !== 'LINE') continue;
  const item = {};
  for (let field = index + 2; field < lines.length - 1 && lines[field].trim() !== '0'; field += 2) item[Number(lines[field].trim())] = lines[field + 1].trim();
  entities.push(item);
}
const reference = entities.find(item => Math.abs(Number(item[10]) - source.referenceLine.from[0]) < 1e-8 && Math.abs(Number(item[20]) - source.referenceLine.from[1]) < 1e-8);
assert.ok(reference, 'Authored reference line must survive the native round trip');
close(Number(reference[11]), source.referenceLine.to[0]); close(Number(reference[21]), source.referenceLine.to[1]);
close(Math.hypot(Number(reference[11]) - Number(reference[10]), Number(reference[21]) - Number(reference[20])) / 1000, source.referenceLine.physicalLengthM);
assert.match(roundtrip, /\$INSUNITS\s+70\s+4(?:\s|$)/, 'Millimetre source-unit metadata must survive');
checks.push({ name: 'LibreDWG application DXF → R2000 DWG → DXF retains an authored 10 m line and millimetre unit metadata', passed: true });

await assert.rejects(run('opensees-static', 'puts [exec whoami]'), error => error.code === 'invalid-source');
const unstable = structuredClone(cantilever); unstable.model.nodes.forEach(node => { node.restraints = [false, false, false]; });
await assert.rejects(run('opensees-static', JSON.stringify(unstable)), error => error.code === 'native-failed');
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(run('opensees-static', JSON.stringify(cantilever), { signal: cancelled.signal }), error => error.code === 'native-cancelled');
checks.push({ name: 'Scripts, unstable models and pre-cancelled jobs produce no accepted result', passed: true });
await writeFile('/evidence/report.json', JSON.stringify({ version: 1, completedAt: new Date().toISOString(), platform: { os: 'Linux', arch: process.arch, node: process.version, distribution: (await readFile('/etc/os-release', 'utf8')).split('\n').find(line => line.startsWith('PRETTY_NAME='))?.slice(12).replace(/^"|"$/g, '') },
  binarySha256: (await readFile('/runtime/binary-sha256.txt', 'utf8')).trim().split('\n'),
  drawingSource: source,
  isolation: { privateNamespaces: namespaces, hostFilesystemAbsent: true, childUid: 10001, childGid: 10001, childEffectiveCapabilities: 0, childCannotReadSupervisorEnvironment: true, activeNetworkInterfaces: 0, syntheticInputsOnly: true },
  limits: { kernelProbe: measuredLimits, jobWallTimeMs: config.timeoutMs },
  engines: { LibreDWG: '0.13.4', OpenSees: '3.8.0' }, checks,
  scope: 'Local synthetic runtime acceptance only. No production queue, live worker connectivity, general DWG fidelity, national-code verification or engineering certification is established.' }, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.length, report: '/evidence/report.json', engines: ['LibreDWG 0.13.4', 'OpenSees 3.8.0'] }));
