import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--test', 'server/test/native-worker-integration.test.ts'], {
  stdio: 'inherit', env: { ...process.env, GROUNDWORK_NATIVE_TEST_ENGINE: 'postgres' }, timeout: 90_000,
});
if (result.error) { console.error('Isolated PostgreSQL worker transport acceptance did not finish'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
