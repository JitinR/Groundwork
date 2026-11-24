import { exportAccountDrafts, removeAccountDrafts } from "./offlineDraft";
import { offlineProjectStore } from "./offlineProjectStore";
import { offlineQueueStore } from "./offlineQueue";
import { exportWorkspaceDraftMemory, finishAccountDraftWrites } from "./workspaceDraft";
import { captureLocalWrite, flushLocalDrafts, localAccountFence, localCleanupAllowed } from "./localDataFence";

const DATABASES = [
  { name: "groundwork_offline_projects_v2", stores: ["cached_projects", "cached_snapshots"] },
  { name: "groundwork_offline_queue_v2", stores: ["queue_items"] },
  { name: "groundwork-workspaces", stores: ["drafts"] },
] as const;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
interface StoredRecord { database: string; store: string; key: IDBValidKey; value: Record<string, unknown>; }
interface AccountSnapshot { version: 1; userId: string; exportedAt: string; records: StoredRecord[]; recovery: ReturnType<typeof exportAccountDrafts>; }

function existingDatabase(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false, absent = false;
    const timer = setTimeout(() => { settled = true; reject(new Error("Browser storage did not respond. Close other Groundwork tabs and try again.")); }, 10_000);
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onsuccess = () => { clearTimeout(timer); if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); if (settled) return; settled = true; if (absent) resolve(null); else reject(request.error || new Error("Browser storage could not be opened.")); };
    request.onblocked = () => { clearTimeout(timer); if (settled) return; settled = true; reject(new Error("Another tab is blocking local-data access. Close other Groundwork tabs and try again.")); };
  });
}

async function accountRecords(database: typeof DATABASES[number], userId: string, remove: boolean, token: string | null = null): Promise<StoredRecord[]> {
  const assertCurrent = () => { if (remove && !localCleanupAllowed(userId, token)) throw new Error("Local cleanup was superseded by a newer account operation."); };
  assertCurrent();
  const db = await existingDatabase(database.name);
  try { assertCurrent(); } catch (error) { db?.close(); throw error; }
  if (!db) return [];
  const stores = database.stores.filter(store => db.objectStoreNames.contains(store));
  if (!stores.length) { db.close(); return []; }
  return new Promise((resolve, reject) => {
    const records: StoredRecord[] = [], tx = db.transaction(stores, remove ? "readwrite" : "readonly");
    let failure: Error | null = null, bytes = 0;
    tx.oncomplete = () => { db.close(); resolve(records); };
    tx.onerror = tx.onabort = () => { db.close(); reject(failure || tx.error || new Error("Local account data could not be accessed.")); };
    for (const store of stores) {
      const request = tx.objectStore(store).openCursor();
      request.onsuccess = () => {
        try { assertCurrent(); } catch (error) { failure = error as Error; tx.abort(); return; }
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as Record<string, unknown>;
        const scopedKey = Array.isArray(cursor.key) && cursor.key[0] === userId || database.name === "groundwork-workspaces" && typeof cursor.key === "string" && cursor.key.startsWith(`${userId}:`);
        if (row?.userId === userId || scopedKey) {
          if (remove) cursor.delete();
          else if (store !== "cached_projects" || row?.accountBound === true && row.userId === userId) {
            // Bound collection before serializing or copying binary attachments.
            bytes += typeof row.content === "string" ? new Blob([row.content]).size : new Blob([JSON.stringify(row)]).size;
            const files = Array.isArray(row.files) ? row.files : [];
            for (const file of files) if (file?.blob instanceof Blob) bytes += file.blob.size;
            if (bytes > MAX_BACKUP_BYTES || records.length >= 10_000) { failure = new Error("Local backup exceeds 256 MiB or 10,000 records. Export recovery copies from their individual workspaces instead."); tx.abort(); return; }
            records.push({ database: database.name, store, key: cursor.key, value: row });
          }
        }
        cursor.continue();
      };
    }
  });
}

async function snapshot(userId: string): Promise<AccountSnapshot> {
  const records = (await Promise.all(DATABASES.map(database => accountRecords(database, userId, false)))).flat();
  const addMemory = (database: string, store: string, key: IDBValidKey, value: unknown) => {
    const index = records.findIndex(record => record.database === database && record.store === store && JSON.stringify(record.key) === JSON.stringify(key));
    const record = { database, store, key, value: value as Record<string, unknown> };
    if (index < 0) records.push(record); else records[index] = record;
  };
  for (const project of offlineProjectStore.exportUserMemory(userId)) addMemory(DATABASES[0].name, "cached_projects", [userId, project.projectId], project);
  for (const item of offlineQueueStore.exportUserMemory(userId)) addMemory(DATABASES[1].name, "queue_items", item.id, item);
  for (const draft of exportWorkspaceDraftMemory(userId)) addMemory(DATABASES[2].name, "drafts", draft.key, draft);
  return { version: 1, userId, exportedAt: new Date().toISOString(), records, recovery: exportAccountDrafts(userId) };
}

export async function exportLocalAccountData(userId: string): Promise<Blob> {
  await flushLocalDrafts(userId);
  await finishAccountDraftWrites(userId);
  const data = await snapshot(userId), { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  let total = 0, attachment = 0;
  const seen = new Set<object>();
  const encode = (value: unknown): unknown => {
    if (value instanceof Blob) {
      total += value.size;
      if (total > MAX_BACKUP_BYTES) throw new Error("Local backup exceeds 256 MiB. Export recovery copies from their individual workspaces instead.");
      const path = `attachments/${String(++attachment).padStart(6, "0")}.bin`;
      zip.file(path, value);
      return { attachment: path, mimeType: value.type, bytes: value.size };
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("A local record contains circular data and cannot be exported. Existing browser data is retained.");
    seen.add(value);
    const encoded = Array.isArray(value) ? value.map(encode) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    seen.delete(value); return encoded;
  };
  const metadata = JSON.stringify(encode(data), null, 2);
  total += new Blob([metadata]).size;
  if (total > MAX_BACKUP_BYTES) throw new Error("Local backup exceeds 256 MiB. Export recovery copies from their individual workspaces instead.");
  zip.file("local-account-data.json", metadata);
  zip.file("README.txt", "Groundwork local recovery backup\n\nThis backup is not encrypted. Store it privately. It contains retained project copies, recovery drafts and queued operations for the named account. Source-file blobs are in attachments/ and referenced by their archive path in local-account-data.json. This is a recovery backup, not a server database restore. Saved server projects are unchanged.\n");
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

/** Call only after explicit removal consent and a durable account write fence. */
export async function removeLocalAccountData(userId: string, token: string = localAccountFence(userId).token): Promise<void> {
  if (captureLocalWrite(userId) !== null) throw new Error("Pause local account writes before removing retained data.");
  const assertCurrent = () => { if (!localCleanupAllowed(userId, token)) throw new Error("Local cleanup was superseded by a newer account operation."); };
  assertCurrent();
  await Promise.all(DATABASES.map(database => accountRecords(database, userId, true, token)));
  assertCurrent();
  removeAccountDrafts(userId);
  assertCurrent();
  offlineProjectStore.clearActiveUserSession(userId);
  offlineQueueStore.clearActiveUserSession(userId);
}
