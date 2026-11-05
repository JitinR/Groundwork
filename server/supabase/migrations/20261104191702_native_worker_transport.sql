-- Private authority-side staging. No worker/browser receives a database role.
-- Application routes remain disabled until explicit remote-worker enablement.
CREATE INDEX IF NOT EXISTS idx_native_jobs_scoped_queue
  ON groundwork.project_native_jobs(project_id,state,kind,created_at,id);

CREATE TABLE IF NOT EXISTS groundwork.native_worker_outputs (
  job_id TEXT NOT NULL REFERENCES groundwork.project_native_jobs(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL,
  output_index BIGINT NOT NULL CHECK(output_index BETWEEN 0 AND 7),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  total_bytes BIGINT NOT NULL CHECK(total_bytes BETWEEN 1 AND 33554432),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  received_bytes BIGINT NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=total_bytes),
  expires_at BIGINT NOT NULL,
  PRIMARY KEY(job_id,claim_token,output_index),
  UNIQUE(job_id,claim_token,filename)
);
CREATE INDEX IF NOT EXISTS idx_native_worker_outputs_expiry ON groundwork.native_worker_outputs(expires_at);

CREATE TABLE IF NOT EXISTS groundwork.native_worker_output_chunks (
  job_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  output_index BIGINT NOT NULL,
  chunk_offset BIGINT NOT NULL CHECK(chunk_offset>=0 AND chunk_offset<33554432),
  byte_length BIGINT NOT NULL CHECK(byte_length BETWEEN 1 AND 262144),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  iv BYTEA NOT NULL CHECK(octet_length(iv)=12),
  tag BYTEA NOT NULL CHECK(octet_length(tag)=16),
  ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext)=byte_length),
  expires_at BIGINT NOT NULL,
  PRIMARY KEY(job_id,claim_token,output_index,chunk_offset),
  FOREIGN KEY(job_id,claim_token,output_index)
    REFERENCES groundwork.native_worker_outputs(job_id,claim_token,output_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_native_worker_chunks_expiry ON groundwork.native_worker_output_chunks(expires_at);

DO $worker_permissions$
DECLARE table_name TEXT; browser_role TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['native_worker_outputs','native_worker_output_chunks'] LOOP
    EXECUTE format('ALTER TABLE groundwork.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON groundwork.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON groundwork.%I TO groundwork_runtime',table_name);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON groundwork.%I FROM %I',table_name,browser_role);
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='groundwork' AND tablename=table_name AND policyname='groundwork_server') THEN
      EXECUTE format('CREATE POLICY groundwork_server ON groundwork.%I TO groundwork_runtime USING (true) WITH CHECK (true)',table_name);
    END IF;
  END LOOP;
END $worker_permissions$;

INSERT INTO groundwork.schema_migrations(version,applied_at)
VALUES ('groundwork_native_worker_v3',extract(epoch FROM clock_timestamp())::BIGINT)
ON CONFLICT(version) DO NOTHING;
