import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connection, encryptionKey, fingerprint, runTool, seal, sha256 } from './backup-common.mjs';

export async function verifyExportPrivileges(client) {
  const { rows: [privileges] } = await client.query(`
    WITH reachable_roles AS (
      SELECT * FROM pg_catalog.pg_roles
      WHERE pg_has_role(session_user, oid, 'MEMBER')
    ), private_relations AS (
      SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'groundwork' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    ), export_group AS (
      SELECT oid FROM reachable_roles WHERE rolname = 'groundwork_backup_export' AND NOT rolcanlogin
    )
    SELECT
      current_user = session_user AND EXISTS (SELECT 1 FROM export_group)
        AND has_schema_privilege(current_user, 'groundwork', 'USAGE')
        AND EXISTS (SELECT 1 FROM private_relations WHERE relkind IN ('r', 'p')) AS configured,
      EXISTS (
        SELECT 1 FROM reachable_roles r
        WHERE r.rolname = 'groundwork_runtime' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
          OR r.rolcreatedb OR r.rolreplication
          OR r.rolname IN ('pg_write_all_data', 'pg_maintain', 'pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
          OR r.oid = (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'groundwork')
          OR r.oid = (SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database())
          OR has_schema_privilege(r.oid, 'groundwork', 'CREATE')
          OR has_database_privilege(r.oid, current_database(), 'CREATE')
      ) OR EXISTS (
        SELECT 1 FROM export_group g WHERE pg_has_role(session_user, g.oid, 'MEMBER WITH ADMIN OPTION')
      ) OR EXISTS (
        SELECT 1 FROM private_relations c CROSS JOIN reachable_roles r
        WHERE r.oid = c.relowner
          OR CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'USAGE, UPDATE, SELECT WITH GRANT OPTION')
                  ELSE has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, SELECT WITH GRANT OPTION')
                    OR has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE, REFERENCES, SELECT WITH GRANT OPTION')
                    OR CASE WHEN current_setting('server_version_num')::integer >= 170000
                            THEN has_table_privilege(r.oid, c.oid, 'MAINTAIN') ELSE false END
             END
      ) AS can_modify,
      NOT EXISTS (
        SELECT 1 FROM private_relations c
        WHERE CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege(current_user, c.oid, 'SELECT')
          ELSE NOT has_table_privilege(current_user, c.oid, 'SELECT')
            OR (c.relrowsecurity AND (
              NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_policy p JOIN export_group g ON g.oid = ANY(p.polroles)
                WHERE p.polrelid = c.oid AND p.polcmd = 'r' AND p.polpermissive
                  AND pg_has_role(current_user, g.oid, 'USAGE') AND pg_get_expr(p.polqual, p.polrelid) = 'true'
              ) OR EXISTS (
                SELECT 1 FROM pg_catalog.pg_policy p
                WHERE p.polrelid = c.oid AND p.polcmd IN ('r', '*') AND NOT p.polpermissive
                  AND (0::oid = ANY(p.polroles) OR EXISTS (SELECT 1 FROM reachable_roles r WHERE r.oid = ANY(p.polroles)))
              )
            ))
          END
      ) AS complete_read_access`);
  if (!privileges?.configured || privileges.can_modify || !privileges.complete_read_access) {
    throw new Error('Backup requires the dedicated export role, full SELECT coverage and no write privileges');
  }
}

export async function exportBackup(env = process.env) {
  if (env.BACKUP_EXPORT_ACK !== 'read-only-groundwork-export') throw new Error('Explicit BACKUP_EXPORT_ACK is required');
  if (env.MASTER_KEY || env.PREVIOUS_MASTER_KEY) throw new Error('Application encryption keys must stay outside the backup process');
  const key = encryptionKey(env.BACKUP_ENCRYPTION_KEY);
  const caPath = resolve('server/certs/supabase-root-2021.crt');
  const ca = await readFile(caPath, 'utf8');
  const { client, env: pgEnv } = connection(env.BACKUP_DATABASE_URL, env.BACKUP_ALLOWED_HOST, { ca });
  pgEnv.PGSSLROOTCERT = caPath;
  pgEnv.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=15000';
  const directory = resolve(env.BACKUP_OUTPUT_DIR || 'artifacts/encrypted-backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `groundwork-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.gwb`);
  let connected = false;
  try {
    await client.connect(); connected = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verifyExportPrivileges(client);
    const { rows: [snapshot] } = await client.query('SELECT pg_export_snapshot() AS id, current_setting(\'server_version\') AS version');
    const manifest = await fingerprint(client);
    // pg_dump and fingerprints observe the same read-only database snapshot.
    // Plaintext exists in bounded memory only; only authenticated ciphertext is written.
    const archive = await runTool('pg_dump', ['--format=custom', '--schema=groundwork', '--strict-names', '--no-owner', '--no-acl', '--enable-row-security', '--inserts', `--snapshot=${snapshot.id}`], pgEnv);
    if (archive.subarray(0, 5).toString() !== 'PGDMP') throw new Error('PostgreSQL archive header missing');
    const metadata = { format: 1, schema: 'groundwork', createdAt: new Date().toISOString(), serverVersion: snapshot.version, archiveSha256: sha256(archive), ...manifest };
    await writeFile(file, seal(archive, key), { flag: 'wx', mode: 0o600 });
    try { await writeFile(`${file}.manifest.gwb`, seal(Buffer.from(JSON.stringify(metadata)), key), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(file, { force: true }); throw error; }
    await client.query('COMMIT');
    return { ok: true, archive: file, manifest: `${file}.manifest.gwb`, tables: manifest.tables.length };
  } finally { if (connected) await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exportBackup().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Backup export failed. Check private configuration, read-only permissions and PostgreSQL client compatibility. No database output was logged.'); process.exitCode = 1; });
}
