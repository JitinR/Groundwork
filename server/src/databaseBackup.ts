import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { DATA_DIR, DATABASE } from "./config.js";

export const BACKUP_DIR = path.join(DATA_DIR, "backups");

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export interface BackupResult {
  backupFile: string;
  backupPath: string;
  sizeBytes: number;
  integrity: string;
  timestamp: number;
}

export interface BackupMetadata {
  filename: string;
  sizeBytes: number;
  createdAt: number;
  integrity: boolean;
}

/** Checkpoint pending WAL frames back into the main database page pool. */
export async function checkpointDatabase(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE"): Promise<{
  busy: number;
  log: number;
  checkpointed: number;
}> {
  if (DATABASE.provider === "supabase") return { busy: 0, log: 0, checkpointed: 0 };
  const statement = db.prepare(`PRAGMA wal_checkpoint(${mode});`);
  const row = await statement.get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
  return {
    busy: row?.busy ?? 0,
    log: row?.log ?? 0,
    checkpointed: row?.checkpointed ?? 0,
  };
}

/** Verify integrity of a SQLite database file using PRAGMA integrity_check. */
export function verifyDatabaseIntegrity(filePath: string): { ok: boolean; status: string } {
  try {
    const backupDb = new DatabaseSync(filePath, { readOnly: true });
    try {
      const result = backupDb.prepare("PRAGMA integrity_check;").get() as { integrity_check?: string } | undefined;
      const status = result?.integrity_check || "unknown";
      return { ok: status === "ok", status };
    } finally {
      backupDb.close();
    }
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
  }
}

/** Create a point-in-time, transactional atomic hot backup via SQLite VACUUM INTO. */
export async function performDatabaseBackup(options?: {
  label?: string;
  pruneCount?: number;
}): Promise<BackupResult> {
  if (DATABASE.provider === "supabase") throw new Error("Use Supabase backup management for the hosted database");
  // Step 1: Flush WAL so changes are captured cleanly
  await checkpointDatabase("TRUNCATE");

  const now = Date.now();
  const dateStr = new Date(now).toISOString().replace(/[:.]/g, "-");
  const label = options?.label ? `-${options.label.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  const filename = `groundwork-backup-${dateStr}${label}.db`;
  const backupPath = path.join(BACKUP_DIR, filename);

  // Step 2: Atomic transactional VACUUM INTO
  const escapedPath = backupPath.replace(/'/g, "''");
  await db.exec(`VACUUM INTO '${escapedPath}';`);

  // Step 3: Integrity verification
  const stat = await fsp.stat(backupPath);
  const integrity = verifyDatabaseIntegrity(backupPath);
  if (!integrity.ok) {
    await fsp.unlink(backupPath).catch(() => undefined);
    throw new Error(`Database backup integrity check failed: ${integrity.status}`);
  }

  // Step 4: Prune older backups if exceeding quota
  const pruneCount = options?.pruneCount ?? 10;
  await pruneOldBackups(pruneCount);

  return {
    backupFile: filename,
    backupPath,
    sizeBytes: stat.size,
    integrity: integrity.status,
    timestamp: now,
  };
}

/** Lists all available backups sorted newest first. */
export async function listDatabaseBackups(): Promise<BackupMetadata[]> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  const backups: BackupMetadata[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".db") && entry.name.startsWith("groundwork-backup-")) {
      const fullPath = path.join(BACKUP_DIR, entry.name);
      const stat = await fsp.stat(fullPath);
      backups.push({
        filename: entry.name,
        sizeBytes: stat.size,
        createdAt: Math.floor(stat.mtimeMs),
        integrity: true,
      });
    }
  }

  backups.sort((a, b) => b.createdAt - a.createdAt);
  return backups;
}

/** Retains only the most recent N backups. */
export async function pruneOldBackups(keepCount = 10): Promise<number> {
  const backups = await listDatabaseBackups();
  if (backups.length <= keepCount) return 0;

  const toRemove = backups.slice(keepCount);
  let removed = 0;
  for (const item of toRemove) {
    const filePath = path.join(BACKUP_DIR, item.filename);
    await fsp.unlink(filePath).catch(() => undefined);
    removed++;
  }
  return removed;
}

/** Background scheduler for automated checkpoints and backups. */
export function startDatabaseScheduler(options?: {
  checkpointIntervalMs?: number;
  backupIntervalMs?: number;
  maxRetained?: number;
}): () => void {
  if (DATABASE.provider === "supabase") return () => {};
  const checkpointMs = options?.checkpointIntervalMs ?? 30 * 60 * 1000; // 30 minutes
  const backupMs = options?.backupIntervalMs ?? 12 * 60 * 60 * 1000; // 12 hours
  const maxRetained = options?.maxRetained ?? 14; // keep 14 backups (1 week of 12h backups)

  let lastBackup: number | undefined;
  let running = false;
  let stopped = false;

  const maintain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (lastBackup === undefined) {
        const startedAt = Date.now();
        const recent = (await listDatabaseBackups()).find(item =>
          item.createdAt <= startedAt && startedAt - item.createdAt < backupMs && item.sizeBytes > 0
          && verifyDatabaseIntegrity(path.join(BACKUP_DIR, item.filename)).ok,
        );
        lastBackup = recent?.createdAt ?? -Infinity;
      }
      if (stopped) return;

      if (Date.now() - lastBackup >= backupMs) {
        const result = await performDatabaseBackup({ label: "scheduled", pruneCount: maxRetained });
        lastBackup = result.timestamp;
        console.log(`[groundwork] Automated backup completed: ${result.backupFile} (${(result.sizeBytes / 1024).toFixed(1)} KB)`);
      } else await checkpointDatabase("TRUNCATE");
    } catch (err) {
      console.error("[groundwork] Scheduled database maintenance error", { type: err instanceof Error ? err.name : "UnknownError" });
    } finally { running = false; }
  };

  const timer = setInterval(() => void maintain(), checkpointMs);
  timer.unref?.();
  void maintain();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
