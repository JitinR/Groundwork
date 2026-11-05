import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResult } from "pg";
import { createPostgresAdapter, postgresMigrationSql, postgresPoolConfiguration, type PostgresPool } from "../src/postgresDatabase.js";
import { postgresSql } from "../src/postgresSql.js";
import { importSqliteDatabase } from "../src/databaseImport.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "groundwork-database-test-"));
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: "", SUPABASE_DB_URL: "",
  GROUNDWORK_DATA_DIR: directory, DB_PATH: directory, MASTER_KEY: Buffer.alloc(32, 73).toString("base64"),
});
const sqlite = await import("../src/db.js");
const engine = new PGlite();
let postgres: Awaited<ReturnType<typeof createPostgresAdapter>>;

/** PGlite has one connection: leases make pool semantics explicit for concurrency checks. */
function enginePool(database = engine): PostgresPool {
  let tail = Promise.resolve();
  async function acquire() {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    return release;
  }
  async function query(text: string, parameters: unknown[] = []): Promise<QueryResult> {
    const result = await database.query<Record<string, unknown>>(text, parameters);
    // pg deliberately returns int8/numeric as strings; exercise normalization.
    for (const field of result.fields) if ([20, 1700].includes(field.dataTypeID)) {
      for (const row of result.rows) if (row[field.name] !== null) row[field.name] = String(row[field.name]);
    }
    return { rows: result.rows, fields: result.fields, command: result.command,
      rowCount: result.command === "SELECT" ? result.rows.length : result.affectedRows, oid: 0 } as QueryResult;
  }
  return {
    query: async (text, parameters) => { const release = await acquire(); try { return await query(text, parameters); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
    end: async () => undefined,
  };
}

before(async () => {
  await engine.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
  await engine.exec(await postgresMigrationSql());
  postgres = await createPostgresAdapter({ url: "postgresql://test:test@localhost/test", poolMax: 1 }, { pool: enginePool() });
});
after(async () => {
  await postgres?.db.close();
  await engine.close();
  await sqlite.db.close();
  await rm(directory, { recursive: true, force: true });
});

test("SQL compilation leaves literals, quoted identifiers, dollar strings and comments intact", () => {
  const query = postgresSql("SELECT '?' AS \"Question?\", $$ dollar ? $$, $tag$? $tag$, ? AS userId /* outer ? /* nested ? */ */ -- ?\nFROM users WHERE id=?");
  assert.equal(query.parameters, 2);
  assert.match(query.sql, /'\?' AS "Question\?"/);
  assert.match(query.sql, /\$\$ dollar \? \$\$/);
  assert.match(query.sql, /\$tag\$\? \$tag\$/);
  assert.match(query.sql, /\$1 AS "userId"/);
  assert.match(query.sql, /FROM groundwork\.users WHERE id=\$2/);
  assert.match(query.sql, /\/\* outer \? \/\* nested \? \*\/ \*\//);
  assert.throws(() => postgresSql("SELECT /* unfinished"), /Unterminated/);
  assert.throws(() => postgresSql("SELECT '"), /Unterminated/);
});

test("SQL compilation preserves case-insensitive auth and legacy insert/pruning behavior", () => {
  assert.match(postgresSql("SELECT id FROM users WHERE username = ? COLLATE NOCASE").sql, /lower\(username\) = lower\(\$1\)/);
  assert.match(postgresSql("SELECT id FROM users u WHERE u.email=? COLLATE NOCASE").sql, /lower\(u\.email\)=lower\(\$1\)/);
  assert.match(postgresSql("INSERT OR IGNORE INTO organization_subscriptions (organization_id) VALUES (?)").sql, /INSERT\s+INTO groundwork\.organization_subscriptions.*ON CONFLICT DO NOTHING/);
  assert.match(postgresSql("SELECT event_id FROM project_event_outbox ORDER BY event_id DESC LIMIT -1 OFFSET 100000").sql, /DESC\s+OFFSET 100000/);
  assert.match(postgresSql("SELECT 'LIMIT -1 OFFSET 10' AS text FROM users").sql, /'LIMIT -1 OFFSET 10'/);
  const statement = postgresSql("INSERT INTO project_sync_operations (project_id) VALUES (?)", { returningIdentity: true });
  assert.equal(statement.identity, "sequence");
  assert.match(statement.sql, /RETURNING sequence$/);
});

test("hosted connections verify certificates and remove connection-string overrides", () => {
  const config = postgresPoolConfiguration({ url: "postgresql://user:pass@db.example.com/app?sslmode=no-verify&ssl=false", poolMax: 5, sslCa: "test-ca" });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: "test-ca" });
  assert.doesNotMatch(config.connectionString!, /sslmode|ssl=/);
  assert.equal(config.max, 5);
});

test("schema is complete, repeatable and inaccessible to browser roles", async () => {
  await engine.exec(await postgresMigrationSql());
  const columns = (await engine.query<{ table_name: string; column_name: string }>(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='groundwork' ORDER BY table_name,ordinal_position")).rows;
  const sqliteTables = await sqlite.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const table of sqliteTables) {
    const local = await sqlite.db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
    assert.deepEqual(columns.filter((column) => column.table_name === table.name).map((column) => column.column_name).sort(), local.map((column) => column.name).sort(), table.name);
  }
  const security = (await engine.query<{ browser_schema: boolean; browser_users: boolean; runtime_users: boolean; runtime_ddl: boolean; runtime_migrations: boolean }>(
    `SELECT has_schema_privilege('anon','groundwork','USAGE') AS browser_schema,
      has_table_privilege('authenticated','groundwork.users','SELECT') AS browser_users,
      has_table_privilege('groundwork_runtime','groundwork.users','INSERT') AS runtime_users,
      has_schema_privilege('groundwork_runtime','groundwork','CREATE') AS runtime_ddl,
      has_table_privilege('groundwork_runtime','groundwork.schema_migrations','INSERT') AS runtime_migrations`)).rows[0];
  assert.deepEqual(security, { browser_schema: false, browser_users: false, runtime_users: true, runtime_ddl: false, runtime_migrations: false });
  const unprotected = await engine.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='groundwork' AND c.relkind='r' AND NOT c.relrowsecurity");
  assert.deepEqual(unprotected.rows, []);
});

test("both adapters preserve typed rows, changes, identities and camelCase aliases", async () => {
  for (const [index, adapter] of [sqlite, postgres].entries()) {
    const id = `database-user-${index}`;
    const result = await adapter.db.prepare(`INSERT INTO users(id,email,password_salt,password_hash,password_changed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, `Database-${index}@example.test`, "salt", "hash", 1, 1, 1);
    assert.equal(result.changes, 1);
    const row = await adapter.db.prepare("SELECT id AS userId,email FROM users WHERE email=? COLLATE NOCASE").get(`database-${index}@example.test`) as { userId: string; email: string };
    assert.equal(row.userId, id);
    assert.equal((await adapter.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 1);
    const audit = await adapter.db.prepare("INSERT INTO audit_logs(user_id,action,created_at) VALUES(?,?,?)").run(id, "test.created", 1);
    assert.equal(audit.changes, 1);
    assert.equal(typeof audit.lastInsertRowid, "number");
    assert.ok(audit.lastInsertRowid > 0);
    assert.equal(await adapter.db.prepare("SELECT id FROM users WHERE id=?").get("missing"), undefined);
  }
});

test("worker staging tables remain private, constrained and indexed on both engines", async () => {
  for (const table of ["native_worker_outputs", "native_worker_output_chunks"]) {
    const security = (await engine.query<{ browser_read: boolean; browser_write: boolean; runtime_write: boolean }>(
      `SELECT has_table_privilege('anon',$1,'SELECT') AS browser_read,
        has_table_privilege('authenticated',$1,'INSERT') AS browser_write,
        has_table_privilege('groundwork_runtime',$1,'INSERT') AS runtime_write`, [`groundwork.${table}`])).rows[0];
    assert.deepEqual(security, { browser_read: false, browser_write: false, runtime_write: true });
  }
  for (const adapter of [sqlite, postgres]) {
    await assert.rejects(adapter.db.prepare(`INSERT INTO native_worker_output_chunks
      (job_id,claim_token,output_index,chunk_offset,byte_length,sha256,iv,tag,ciphertext,expires_at)
      VALUES(?,?,0,0,1,?,?,?,?,?)`).run("missing-job", "a".repeat(32), "b".repeat(64), Buffer.alloc(12), Buffer.alloc(16), Buffer.alloc(1), 1),
    /FOREIGN KEY|foreign key/);
  }
  const indexes = await engine.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='groundwork' AND indexname IN ('idx_native_jobs_scoped_queue','idx_native_worker_outputs_expiry','idx_native_worker_chunks_expiry')");
  assert.equal(indexes.rows.length, 3);
});

test("both adapters await commits, roll back nested work and isolate unrelated requests", async () => {
  for (const [index, adapter] of [sqlite, postgres].entries()) {
    const id = `database-user-${index}`;
    await assert.rejects(adapter.withTransaction(async () => {
      await adapter.db.prepare("UPDATE users SET username=? WHERE id=?").run("rolled-back", id);
      throw new Error("cancel");
    }), /cancel/);
    assert.equal((await adapter.db.prepare("SELECT username FROM users WHERE id=?").get(id) as { username: string | null }).username, null);
    await adapter.withTransaction(async () => {
      await adapter.db.prepare("UPDATE users SET username=? WHERE id=?").run("outer", id);
      await assert.rejects(adapter.withTransaction(async () => {
        await adapter.db.prepare("UPDATE users SET username=? WHERE id=?").run("inner", id);
        throw new Error("inner cancel");
      }), /inner cancel/);
      assert.equal((await adapter.db.prepare("SELECT username FROM users WHERE id=?").get(id) as { username: string }).username, "outer");
    });
    const events: string[] = [];
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    const transaction = adapter.withTransaction(async () => {
      await adapter.db.prepare("UPDATE users SET username=? WHERE id=?").run("transaction", id);
      entered(); await finishing;
      events.push("transaction");
    });
    await entering;
    const outside = adapter.db.prepare("UPDATE users SET username=? WHERE id=?").run("outside", id).then(() => { events.push("outside"); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, []);
    finish(); await Promise.all([transaction, outside]);
    assert.deepEqual(events, ["transaction", "outside"]);
    assert.equal((await adapter.db.prepare("SELECT username FROM users WHERE id=?").get(id) as { username: string }).username, "outside");
  }
});

test("PostgreSQL enforces unique email identities, binary data and runtime RLS grants", async () => {
  await assert.rejects(postgres.db.prepare(`INSERT INTO users(id,email,password_salt,password_hash,password_changed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run("duplicate-user", "database-1@EXAMPLE.test", "salt", "hash", 1, 1, 1), /unique/i);
  await postgres.db.prepare("INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("database-project", "database-user-1", "Encrypted artifacts", 1, 1);
  const binary = Buffer.from([0, 255, 39, 63, 128]);
  await postgres.db.prepare(`INSERT INTO project_workspace_artifacts
    (id,project_id,kind,name,mime,size,sha256,iv,tag,ciphertext,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("database-artifact", "database-project", "geometry", "encrypted.bin", "application/octet-stream", binary.length, "test-sha", Buffer.alloc(12), Buffer.alloc(16), binary, 1);
  const artifact = await postgres.db.prepare("SELECT ciphertext FROM project_workspace_artifacts WHERE id=?").get("database-artifact") as { ciphertext: Uint8Array };
  assert.deepEqual(Buffer.from(artifact.ciphertext), binary);
  const operation = await postgres.db.prepare(`INSERT INTO project_sync_operations
    (project_id,actor_id,operation_id,client_id,logical_clock,entity_id,field,value_encrypted,value_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("database-project", "database-user-1", "test-operation", "test-client", 1, "wall", "position", "ciphertext", "hash", 1);
  assert.equal(operation.lastInsertRowid, 1);
  await engine.query("SET ROLE groundwork_runtime");
  try {
    const rows = await postgres.db.prepare("SELECT id AS userId FROM users WHERE id=?").all("database-user-1");
    assert.deepEqual(rows, [{ userId: "database-user-1" }]);
    await assert.rejects(engine.query("DROP TABLE groundwork.provider_daily_usage"), /owner|permission/i);
  } finally { await engine.query("RESET ROLE"); }
});

test("missing hosted schema fails closed and releases the pool without leaking driver details", async () => {
  let ended = 0;
  const missing: PostgresPool = {
    query: async () => { throw new Error("private-password connection detail"); },
    connect: async () => { throw new Error("not expected"); },
    end: async () => { ended += 1; },
  };
  await assert.rejects(createPostgresAdapter({ url: "postgresql://test@localhost/test", poolMax: 1 }, { pool: missing }), (error: Error) => {
    assert.match(error.message, /schema is missing/);
    assert.doesNotMatch(error.message, /private-password/);
    return true;
  });
  assert.equal(ended, 1);
});

test("notifications run after commit and discarded nested changes never notify", async () => {
  for (const adapter of [sqlite, postgres]) {
    const events: string[] = [];
    await adapter.withTransaction(async () => {
      await adapter.afterCommit(async () => {
        await adapter.db.prepare("SELECT 1 AS ok").get();
        events.push("committed");
      });
      await assert.rejects(adapter.withTransaction(async () => {
        await adapter.afterCommit(() => { events.push("rolled-back"); });
        throw new Error("cancel");
      }), /cancel/);
      assert.deepEqual(events, []);
    });
    assert.deepEqual(events, ["committed"]);
  }
});

test("SQLite import verifies every copied value and refuses an occupied target", async () => {
  const destination = new PGlite();
  try {
    await destination.exec(await postgresMigrationSql());
    await sqlite.db.prepare("INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run("import-project", "database-user-0", "Preserved project", 1, 1);
    const result = await importSqliteDatabase(path.join(directory, "groundwork.db"), enginePool(destination));
    assert.equal(result.verified, true);
    assert(result.tables > 30 && result.rows > 1);
    const rows = await destination.query("SELECT name FROM groundwork.projects WHERE id='import-project'");
    assert.equal(rows.rows[0].name, "Preserved project");
    await assert.rejects(importSqliteDatabase(path.join(directory, "groundwork.db"), enginePool(destination)), /target already contains/);
    assert.equal(Number((await destination.query("SELECT count(*) AS count FROM groundwork.users")).rows[0].count), 1);
  } finally { await destination.close(); }
});
