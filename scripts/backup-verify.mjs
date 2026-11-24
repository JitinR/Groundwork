import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { boundedRead, connection, encryptionKey, fingerprint, open, runTool, sha256 } from './backup-common.mjs';

export async function verifyBackup(file, env = process.env) {
  if (!file) throw new Error('Supply the encrypted archive path');
  const key = encryptionKey(env.BACKUP_ENCRYPTION_KEY);
  const archive = open(await boundedRead(file), key);
  const manifest = JSON.parse(open(await boundedRead(`${file}.manifest.gwb`, 1048576), key));
  if (manifest.format !== 1 || manifest.schema !== 'groundwork' || sha256(archive) !== manifest.archiveSha256) throw new Error('Archive and manifest mismatch');
  if (!env.BACKUP_RESTORE_DATABASE_URL) return { ok: true, authenticated: true, restored: false, createdAt: manifest.createdAt };
  if (env.BACKUP_RESTORE_ACK !== 'restore-into-empty-isolated-database') throw new Error('Explicit restore rehearsal acknowledgment required');
  if (env.MASTER_KEY || env.PREVIOUS_MASTER_KEY) throw new Error('Application encryption keys must remain separate from database verification');
  const { client, env: pgEnv } = connection(env.BACKUP_RESTORE_DATABASE_URL, env.BACKUP_RESTORE_ALLOWED_HOST, { restore: true });
  await client.connect();
  try {
    const { rows: [row] } = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')");
    const { rows: schemas } = await client.query("SELECT 1 FROM pg_namespace WHERE nspname='groundwork'");
    if (row.count || schemas.length) throw new Error('Restore rehearsal target must be empty');
    // Restore RLS policies in a fresh cluster without copying any login or grants.
    await client.query(`DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='groundwork_runtime') THEN
          CREATE ROLE groundwork_runtime NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='groundwork_backup_export') THEN
          CREATE ROLE groundwork_backup_export NOLOGIN;
        END IF;
      END $roles$`);
    await runTool('pg_restore', ['--dbname=' + pgEnv.PGDATABASE, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl'], pgEnv, archive);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await fingerprint(client);
    await client.query('COMMIT');
    if (!isDeepStrictEqual(actual.tables, manifest.tables) || !isDeepStrictEqual(actual.migrations, manifest.migrations)) throw new Error('Restored row counts, row fingerprints or migration versions differ');
    return { ok: true, authenticated: true, restored: true, tables: actual.tables.length, createdAt: manifest.createdAt };
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyBackup(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Backup verification failed. Check private configuration, key, empty isolated target and PostgreSQL compatibility. No database output was logged.'); process.exitCode = 1; });
}
