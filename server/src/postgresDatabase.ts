import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolConfig, type QueryResult } from "pg";
import type { DatabaseAdapter, Db } from "./db.js";
import { postgresSql } from "./postgresSql.js";
import { runCommitEffects, type CommitEffect } from "./databaseEffects.js";

export const POSTGRES_SCHEMA_VERSION = "groundwork_engineering_v2";
const MIGRATIONS = [
  { version: "groundwork_private_v1", file: "20261019191555_groundwork_private_database.sql" },
  { version: POSTGRES_SCHEMA_VERSION, file: "20261021153936_engineering_runtime.sql" },
  { version: "groundwork_native_worker_v3", file: "20261104191702_native_worker_transport.sql" },
] as const;
// A transaction-scoped lock preserves the existing critical-section semantics
// for quotas, billing, TOTP replay checks, leases and optimistic revisions.
const TRANSACTION_LOCK = "711326018359731";
const MIGRATION_LOCK = "711326018359732";
export interface PostgresConfiguration { url: string; adminUrl?: string; sslCa?: string; poolMax: number; }
export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(error?: Error | boolean): void;
}
/** Injectable for isolated PostgreSQL-engine tests; production always constructs pg.Pool. */
export interface PostgresPool {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export function postgresPoolConfiguration(configuration: PostgresConfiguration): PoolConfig {
  const url = new URL(configuration.url);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL connection string is required");
  // URL SSL settings can silently override pg's explicit verification options.
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"]) url.searchParams.delete(name);
  const localTest = process.env.NODE_ENV === "test" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: localTest ? false : { rejectUnauthorized: true, ...(configuration.sslCa ? { ca: configuration.sslCa } : {}) },
    max: configuration.poolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: "groundwork-api",
    allowExitOnIdle: true,
  };
}

function normalize(result: QueryResult): Record<string, unknown>[] {
  const numerical = result.fields.filter((field) => [20, 1700].includes(field.dataTypeID)).map((field) => field.name);
  for (const row of result.rows as Record<string, unknown>[]) {
    for (const field of numerical) {
      const value = row[field];
      if (typeof value !== "string" || !/^-?\d+$/.test(value)) continue;
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds the supported safe range");
      row[field] = number;
    }
  }
  return result.rows as Record<string, unknown>[];
}

interface TransactionContext { client: PostgresClient; active: boolean; childTail: Promise<void>; effects: CommitEffect[]; }
export async function createPostgresAdapter(configuration: PostgresConfiguration, options: { pool?: PostgresPool } = {}): Promise<DatabaseAdapter> {
  const pool: PostgresPool = options.pool ?? new Pool(postgresPoolConfiguration(configuration));
  pool.on?.("error", () => { console.error("[groundwork] Idle database connection was interrupted"); });
  const storage = new AsyncLocalStorage<TransactionContext>();
  let nextSavepoint = 0;
  let closed = false;
  async function query(text: string, values: unknown[] = []): Promise<QueryResult> {
    if (closed) throw new Error("Database is closed");
    const transaction = storage.getStore();
    if (transaction && !transaction.active) throw new Error("Database transaction has ended");
    if (transaction) return transaction.client.query(text, values);
    if (/^\s*(SELECT|SHOW|EXPLAIN)\b/i.test(text)) return pool.query(text, values);
    // SQLite's write transaction also excluded standalone writes. The same
    // fence must cover every mutation across API/worker instances.
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [TRANSACTION_LOCK]);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  try {
    const result = await pool.query("SELECT version FROM groundwork.schema_migrations WHERE version=$1", [POSTGRES_SCHEMA_VERSION]);
    if (result.rowCount !== 1) throw new Error("Schema is not initialized");
  } catch {
    await pool.end();
    throw new Error("Supabase database is unavailable or its schema is missing. Run npm run db:migrate with the server migration connection, then retry.");
  }
  const database: Db = {
    prepare(sql) {
      const statement = postgresSql(sql);
      function parameters(values: unknown[]): unknown[] {
        if (values.length !== statement.parameters) throw new Error("Incorrect SQL parameter count");
        return values.map((value) => typeof value === "bigint" ? value.toString() : value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value);
      }
      return {
        get: async (...values) => normalize(await query(statement.sql, parameters(values)))[0],
        all: async (...values) => normalize(await query(statement.sql, parameters(values))),
        run: async (...values) => {
          const insert = postgresSql(sql, { returningIdentity: true });
          const result = await query(insert.sql, parameters(values));
          const rows = normalize(result);
          const inserted = insert.identity ? rows[0]?.[insert.identity] : 0;
          return { changes: result.rowCount ?? 0, lastInsertRowid: typeof inserted === "number" || typeof inserted === "bigint" ? inserted : 0 };
        },
      };
    },
    exec: async (sql) => { await query(postgresSql(sql).sql); },
    close: async () => { if (!closed) { closed = true; await pool.end(); } },
  };
  async function transaction<T>(work: () => Promise<T> | T): Promise<T> {
    const parent = storage.getStore();
    if (parent && !parent.active) throw new Error("Database transaction has ended");
    const effects: CommitEffect[] = [];
    async function execute(): Promise<T> {
      const client = parent?.client ?? await pool.connect();
      const savepoint = `groundwork_nested_${++nextSavepoint}`;
      const context: TransactionContext = { client, active: true, childTail: Promise.resolve(), effects: [] };
      let broken = false;
      try {
        await client.query(parent ? `SAVEPOINT ${savepoint}` : "BEGIN");
        if (!parent) {
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [TRANSACTION_LOCK]);
          await client.query("SET LOCAL idle_in_transaction_session_timeout='30000ms'");
        }
        const result = await storage.run(context, work);
        await client.query(parent ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        (parent ? parent.effects : effects).push(...context.effects);
        return result;
      } catch (error) {
        try {
          if (parent) { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
          else await client.query("ROLLBACK");
        } catch { broken = true; }
        throw error;
      } finally { context.active = false; if (!parent) client.release(broken); }
    }
    if (!parent) {
      const result = await execute();
      await runCommitEffects(effects);
      return result;
    }
    const previous = parent.childTail;
    let release!: () => void;
    parent.childTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await execute(); } finally { release(); }
  }
  async function afterCommit(work: CommitEffect): Promise<void> {
    const context = storage.getStore();
    if (context && !context.active) throw new Error("Database transaction has ended");
    if (context) context.effects.push(work);
    else await runCommitEffects([work]);
  }
  return { db: database, withTransaction: transaction, afterCommit };
}

export async function postgresMigrationSql(): Promise<string> {
  return (await Promise.all(MIGRATIONS.map(({ file }) => readFile(fileURLToPath(new URL(`../supabase/migrations/${file}`, import.meta.url)), "utf8")))).join("\n");
}

/** Explicit administrator command only. Runtime credentials do not run schema DDL. */
export async function migratePostgres(databaseUrl: string, options: { sslCa?: string } = {}): Promise<void> {
  const pool = new Pool(postgresPoolConfiguration({ url: databaseUrl, sslCa: options.sslCa, poolMax: 1 }));
  let client: PostgresClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK]);
    const exists = await client.query("SELECT to_regclass('groundwork.schema_migrations') AS name");
    let initialized = Boolean(exists.rows[0]?.name);
    for (const migration of MIGRATIONS) {
      if (initialized) {
        const applied = await client.query("SELECT version FROM groundwork.schema_migrations WHERE version=$1", [migration.version]);
        if (applied.rowCount === 1) continue;
      }
      const sql = await readFile(fileURLToPath(new URL(`../supabase/migrations/${migration.file}`, import.meta.url)), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO groundwork.schema_migrations(version,applied_at) VALUES($1,$2) ON CONFLICT(version) DO NOTHING", [migration.version, Math.floor(Date.now() / 1000)]);
      initialized = true;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    // Never include a connection URL, SQL parameters, or driver detail in the public error.
    const wrapped = new Error("Database schema migration failed; no changes were committed");
    Object.defineProperty(wrapped, "cause", { value: error });
    throw wrapped;
  } finally { client?.release(); await pool.end(); }
}
