// Native PostgreSQL drill against synthetic data, never a hosted database.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { connection } from './backup-common.mjs';
import { exportBackup, verifyExportPrivileges } from './backup-export.mjs';
import { verifyBackup } from './backup-verify.mjs';

const sourceUrl = process.env.OPERATIONS_POSTGRES_TEST_URL;
const restoreUrl = process.env.OPERATIONS_POSTGRES_RESTORE_URL;
const host = '127.0.0.1:5432';
const source = connection(sourceUrl, host, { restore: true }).client;
const target = connection(restoreUrl, host, { restore: true }).client;
const directory = await mkdtemp(join(tmpdir(), 'groundwork-backup-drill-'));
try {
  await source.connect(); await target.connect();
  await source.query(await readFile('server/supabase/migrations/20261019191555_groundwork_private_database.sql', 'utf8'));
  await source.query(await readFile('server/supabase/migrations/20261021153936_engineering_runtime.sql', 'utf8'));
  await source.query(await readFile('server/supabase/migrations/20261104191702_native_worker_transport.sql', 'utf8'));
  await source.query("INSERT INTO groundwork.users(id,email,password_salt,password_hash,password_changed_at,created_at,updated_at) VALUES ('backup-fixture','synthetic@example.test','synthetic-salt','synthetic-hash',1,1,1)");
  await source.query("CREATE TABLE groundwork.backup_fingerprint_fixture(id int PRIMARY KEY, value double precision, bytes bytea, happened_at timestamptz); INSERT INTO groundwork.backup_fingerprint_fixture VALUES (1,1.2345678901234567,decode('0001ff5c','hex'),'2026-10-23T12:34:56.123456Z'); ALTER TABLE groundwork.backup_fingerprint_fixture ENABLE ROW LEVEL SECURITY");
  await source.query(await readFile('scripts/backup-role.sql', 'utf8'));
  await source.query("CREATE ROLE groundwork_backup_fixture LOGIN PASSWORD 'synthetic-ci-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE groundwork_backup_export");
  await source.query("ALTER ROLE groundwork_backup_fixture SET extra_float_digits=0");
  await source.query("ALTER ROLE groundwork_backup_fixture SET bytea_output='escape'");
  await source.query("ALTER ROLE groundwork_backup_fixture SET TimeZone='America/New_York'");
  const exportUrl = new URL(sourceUrl); exportUrl.username = 'groundwork_backup_fixture'; exportUrl.password = 'synthetic-ci-only';
  const backup = connection(exportUrl.toString(), host).client;
  await backup.connect();
  try {
    await verifyExportPrivileges(backup);
    const { rows: [permission] } = await backup.query("SELECT has_table_privilege(current_user,'groundwork.users','INSERT, UPDATE, DELETE, TRUNCATE') AS can_write");
    assert.equal(permission.can_write, false);
    await source.query("GRANT groundwork_runtime TO groundwork_backup_fixture");
    await assert.rejects(verifyExportPrivileges(backup), /dedicated export role/);
    await source.query("REVOKE groundwork_runtime FROM groundwork_backup_fixture");
    await source.query("DROP POLICY groundwork_backup_select ON groundwork.backup_fingerprint_fixture");
    await assert.rejects(verifyExportPrivileges(backup), /full SELECT coverage/);
    await source.query(await readFile('scripts/backup-role.sql', 'utf8'));
  } finally { await backup.end(); }
  const env = { BACKUP_EXPORT_ACK: 'read-only-groundwork-export', BACKUP_DATABASE_URL: exportUrl.toString(), BACKUP_ALLOWED_HOST: host, BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_OUTPUT_DIR: directory, BACKUP_RESTORE_DATABASE_URL: restoreUrl, BACKUP_RESTORE_ALLOWED_HOST: host, BACKUP_RESTORE_ACK: 'restore-into-empty-isolated-database' };
  const exported = await exportBackup(env);
  assert.equal((await verifyBackup(exported.archive, { BACKUP_ENCRYPTION_KEY: env.BACKUP_ENCRYPTION_KEY })).restored, false);
  const verified = await verifyBackup(exported.archive, env);
  assert.equal(verified.restored, true);
  await assert.rejects(verifyBackup(exported.archive, env), /empty/);
  const { rows } = await target.query('SELECT email FROM groundwork.users WHERE id=$1', ['backup-fixture']);
  assert.equal(rows[0].email, 'synthetic@example.test');
  console.log(JSON.stringify({ ok: true, synthetic: true, restoredTables: verified.tables }));
} finally { await source.end(); await target.end(); await rm(directory, { recursive: true, force: true }); }
