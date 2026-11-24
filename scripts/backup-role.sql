-- Run as the private schema owner after applying application migrations.
-- Grant this group only to the dedicated, independently provisioned export login.
BEGIN;
DO $backup_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groundwork_backup_export') THEN
    CREATE ROLE groundwork_backup_export NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$backup_role$;

GRANT USAGE ON SCHEMA groundwork TO groundwork_backup_export;
GRANT SELECT ON ALL TABLES IN SCHEMA groundwork TO groundwork_backup_export;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA groundwork TO groundwork_backup_export;

DO $backup_access$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'groundwork' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS groundwork_backup_select ON groundwork.%I', table_name);
    EXECUTE format('CREATE POLICY groundwork_backup_select ON groundwork.%I FOR SELECT TO groundwork_backup_export USING (true)', table_name);
  END LOOP;
END
$backup_access$;
COMMIT;
