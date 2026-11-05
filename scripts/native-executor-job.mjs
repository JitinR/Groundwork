// Installed only in the sealed executor bundle. No application configuration,
// database, queue credentials or provider module can enter this filesystem.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { runNativeJob } from './nativeAdapters.js';

const MAX_FRAME = 48 * 1024 * 1024, MAX_BYTES = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && fields.every(field => Object.hasOwn(value, field)) && Object.keys(value).every(field => fields.includes(field));
async function trustedJson(filename, maximum) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o7777) === 0o600 && info.size > 0 && info.size <= maximum);
    const bytes = await handle.readFile(); assert.equal(bytes.length, info.size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}
async function confined() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); assert.equal(process.getgid(), 0); assert.equal(process.pid, 1);
  assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  assert.equal(process.env.PATH, '/usr/bin:/bin');
  const profile = await trustedJson('/confinement.json', 4096);
  assert.ok(exact(profile, ['hostNamespaces', 'cgroup']));
  assert.ok(exact(profile.hostNamespaces, ['mnt', 'net', 'pid', 'ipc', 'uts']));
  for (const name of ['mnt', 'net', 'pid', 'ipc', 'uts']) assert.notEqual(await readlink(`/proc/self/ns/${name}`), profile.hostNamespaces[name]);
  assert.ok(exact(profile.cgroup, ['name', 'memoryMax', 'pidsMax', 'cpuMax', 'swapMax']));
  assert.match(profile.cgroup.name, /^attempt-[a-f0-9]{32}$/);
  assert.equal(profile.cgroup.memoryMax, '536870912'); assert.equal(profile.cgroup.pidsMax, '32');
  assert.equal(profile.cgroup.cpuMax, '100000 100000'); assert.equal(profile.cgroup.swapMax, '0');
  assert.ok((await readFile('/proc/self/cgroup', 'utf8')).trim().endsWith(`/${profile.cgroup.name}`));
  assert.deepEqual(os.networkInterfaces(), {});
  const status = await readFile('/proc/self/status', 'utf8');
  for (const field of ['CapEff', 'CapPrm', 'CapBnd']) {
    const match = new RegExp(`^${field}:\\s+([a-f0-9]+)$`, 'm').exec(status); assert.ok(match);
    // CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID only. Namespace/chroot and
    // device-creation privileges cannot be reacquired by the supervisor.
    assert.equal(BigInt(`0x${match[1]}`), 0xe3n);
  }
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  for (const missing of ['/home', '/mnt', '/root', '/app/config.js', '/app/.env', '/etc/shadow', '/sys/fs/cgroup']) await assert.rejects(lstat(missing));
  for (const filename of ['/usr/bin/node', '/usr/bin/prlimit', '/runtime/bin/OpenSees', '/runtime/bin/dwg2dxf', '/runtime/bin/dxf2dwg']) {
    const info = await lstat(filename); assert.ok(info.isFile() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o7022) === 0);
  }
}
async function writeResult(value) {
  const bytes = Buffer.from(JSON.stringify(value)); assert.ok(bytes.length > 0 && bytes.length <= MAX_FRAME);
  const handle = await open('/result.json', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}
async function probe() {
  const result = spawnSync('/usr/bin/node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os';
    assert.equal(process.getuid(),10001); assert.equal(process.getgid(),10001);
    assert.deepEqual(os.networkInterfaces(),{});
    assert.match(fs.readFileSync('/proc/self/status','utf8'),/^CapEff:\\s+0+$/m);
    assert.match(fs.readFileSync('/proc/self/status','utf8'),/^NoNewPrivs:\\s+1$/m);
    for (const name of ['/request.json','/confinement.json','/proc/1/environ','/home','/mnt','/root']) assert.throws(()=>fs.accessSync(name,fs.constants.R_OK));
  `], { uid: 10001, gid: 10001, env: { PATH: '/usr/bin:/bin' }, timeout: 5000, maxBuffer: 4096, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.signal, null);
  await writeResult({ version: 1, ready: true });
}
async function execute() {
  const request = await trustedJson('/request.json', MAX_FRAME);
  assert.ok(exact(request, ['version', 'op', 'jobId', 'kind', 'input']));
  assert.equal(request.version, 1); assert.equal(request.op, 'execute');
  assert.match(request.jobId, /^[a-f0-9]{32}$/); assert.ok(['dwg-to-dxf', 'dxf-to-dwg', 'opensees-static'].includes(request.kind));
  assert.ok(exact(request.input, ['bytes', 'sourceArtifactId', 'sha256']));
  assert.match(request.input.sourceArtifactId, /^[a-f0-9]{32}$/); assert.match(request.input.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof request.input.bytes === 'string' && request.input.bytes.length <= Math.ceil(MAX_BYTES / 3) * 4);
  const bytes = Buffer.from(request.input.bytes, 'base64');
  assert.ok(bytes.length > 0 && bytes.length <= MAX_BYTES); assert.equal(bytes.toString('base64'), request.input.bytes); assert.equal(hash(bytes), request.input.sha256);
  const config = {
    libreDwg: { dwg2dxfPath: '/runtime/bin/dwg2dxf', dxf2dwgPath: '/runtime/bin/dxf2dwg', version: '0.13.4' },
    openSees: { executablePath: '/runtime/bin/OpenSees', version: '3.8.0' },
    sandbox: { uid: 10001, gid: 10001, prlimitPath: '/usr/bin/prlimit', acknowledged: true },
    timeoutMs: 90_000, maximumInputBytes: MAX_BYTES, maximumOutputBytes: MAX_BYTES,
  };
  await mkdir('/jobs/attempt', { mode: 0o700 });
  const result = await runNativeJob({ kind: request.kind, config, workingDirectory: '/jobs/attempt', input: { bytes, sourceArtifactId: request.input.sourceArtifactId, sha256: request.input.sha256 }, signal: new AbortController().signal });
  await writeResult({ version: 1, artifacts: result.artifacts.map(artifact => ({ ...artifact, bytes: Buffer.from(artifact.bytes).toString('base64') })), summary: result.summary });
}

try {
  await confined();
  const mode = process.argv[2];
  if (mode === 'probe') await probe();
  else if (mode === 'execute') await execute();
  else throw new Error();
} catch {
  // Neither native output nor exception text crosses the broker log boundary.
  process.exitCode = 1;
}
