import type { Design, ProjectDetail, ProjectType } from "../types";
import { PROJECT_TYPE_LABELS } from "../types";
import { captureLocalWrite, localAccountFence, subscribeLocalDataFence } from "./localDataFence";

export interface PendingDraft {
  design: Design;
  name: string;
  projectType: ProjectType;
  baseRevision: number;
  savedAt: number;
  baseDesign?: Design;
  baseName?: string;
  baseProjectType?: ProjectType;
  lastSaveStatus?: number;
  lastSaveError?: string;
  /** Identifies the tab that owns the stored recovery record. */
  storageId?: string;
  /** Separates post-removal recovery from copies retained by a suspended older page. */
  removalGeneration?: string;
}
export interface DraftStorageResult { stored: boolean; durable: boolean; error?: string; }
export interface DraftReadResult { draft: PendingDraft | null; source: "durable" | "session" | "memory" | null; error?: string; }
export const MAX_DRAFT_CHARACTERS = 4_000_000;

/** A later server revision acknowledges this exact draft; preserve any different local edit. */
export function draftMatchesSavedProject(draft: PendingDraft, project: Pick<ProjectDetail, "revision" | "name" | "projectType" | "design">): boolean {
  return project.revision > draft.baseRevision && project.name === draft.name
    && project.projectType === draft.projectType && JSON.stringify(project.design) === JSON.stringify(draft.design);
}
const PREFIX = "groundwork:draft:v2:";
const TAB_KEY = "groundwork:recovery-tab";
const memory = new Map<string, PendingDraft>();
let tabId: string | undefined;
const validId = (value: string) => /^[a-zA-Z0-9-]{1,100}$/.test(value);
function currentTab(): string {
  if (tabId) return tabId;
  // A fresh page identity avoids collisions when browsers clone sessionStorage into a new tab.
  tabId = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  try { sessionStorage.setItem(TAB_KEY, tabId); } catch { /* Read reports storage limits. */ }
  return tabId;
}
const prefix = (userId: string, projectId: string) => PREFIX + encodeURIComponent(userId) + ":" + encodeURIComponent(projectId) + ":";
const key = (userId: string, projectId: string) => prefix(userId, projectId) + currentTab();
const legacyKey = (userId: string, projectId: string) => "groundwork:draft:" + userId + ":" + projectId;
const projectTypeValid = (value: unknown): value is ProjectType => typeof value === "string" && Object.prototype.hasOwnProperty.call(PROJECT_TYPE_LABELS, value);
const designValid = (value: unknown): value is Design => Boolean(value && typeof value === "object" && !Array.isArray(value) && "room" in value && typeof (value as Design).room === "object" && (value as Design).room && Array.isArray((value as Design).furniture));
function parse(text: string, storageId?: string): PendingDraft {
  if (text.length > MAX_DRAFT_CHARACTERS) throw new Error("A recovery record exceeds the browser recovery size limit");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A recovery record is invalid");
  const draft = value as PendingDraft;
  if (!designValid(draft.design) || !projectTypeValid(draft.projectType) || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 ||
    typeof draft.name !== "string" || !Number.isFinite(draft.savedAt) || draft.savedAt < 0) throw new Error("A recovery record is invalid");
  if (draft.baseDesign !== undefined && !designValid(draft.baseDesign)) throw new Error("The stored merge base is invalid");
  if (draft.baseName !== undefined && typeof draft.baseName !== "string") throw new Error("The stored merge base name is invalid");
  if (draft.baseProjectType !== undefined && !projectTypeValid(draft.baseProjectType)) throw new Error("The stored merge base project type is invalid");
  if (draft.lastSaveStatus !== undefined && (!Number.isSafeInteger(draft.lastSaveStatus) || draft.lastSaveStatus < 0 || draft.lastSaveStatus > 599)) throw new Error("The stored save status is invalid");
  if (draft.lastSaveError !== undefined && typeof draft.lastSaveError !== "string") throw new Error("The stored save error is invalid");
  if (draft.removalGeneration !== undefined && (typeof draft.removalGeneration !== "string" || draft.removalGeneration.length > 200)) throw new Error("The stored recovery generation is invalid");
  return { ...draft, storageId };
}

/** Durable records stay per user, project and tab; a different tab never overwrites them. */
export function readPendingDraftResult(userId: string, projectId: string): DraftReadResult {
  localAccountFence(userId);
  const currentKey = key(userId, projectId);
  const errors: string[] = [];
  const candidates: { draft: PendingDraft; source: "durable" | "session"; current: boolean }[] = [];
  try {
    const own = localStorage.getItem(currentKey);
    if (own) candidates.push({ draft: parse(own, currentTab()), source: "durable", current: true });
    for (let i = 0; i < Math.min(localStorage.length, 2000); i += 1) {
      const storedKey = localStorage.key(i);
      if (!storedKey || storedKey === currentKey || !storedKey.startsWith(prefix(userId, projectId))) continue;
      const ownerTab = storedKey.slice(prefix(userId, projectId).length);
      if (!validId(ownerTab)) continue;
      const text = localStorage.getItem(storedKey);
      if (text) {
        try { candidates.push({ draft: parse(text, ownerTab), source: "durable", current: false }); }
        catch { errors.push("An older recovery record could not be read"); }
      }
      if (candidates.length > 100) { candidates.sort((a, b) => Number(b.current) - Number(a.current) || b.draft.savedAt - a.draft.savedAt); candidates.length = 100; }
    }
  } catch { errors.push("Durable browser storage is unavailable or contains an unreadable record"); }
  try {
    const sessionKeys = [currentKey, legacyKey(userId, projectId)];
    for (let i = 0; i < Math.min(sessionStorage.length, 2000); i += 1) {
      const storedKey = sessionStorage.key(i);
      if (storedKey && storedKey !== currentKey && storedKey.startsWith(prefix(userId, projectId))) sessionKeys.push(storedKey);
    }
    for (const storedKey of sessionKeys) {
      const text = sessionStorage.getItem(storedKey);
      const owner = storedKey.startsWith(prefix(userId, projectId)) ? storedKey.slice(prefix(userId, projectId).length) : currentTab();
      if (text && validId(owner)) {
        try { candidates.push({ draft: parse(text, owner), source: "session", current: owner === currentTab() }); }
        catch { errors.push("An older tab recovery could not be read"); }
      }
    }
  } catch { errors.push("Tab recovery storage is unavailable or contains an unreadable record"); }
  const remembered = memory.get(currentKey);
  candidates.sort((a, b) => Number(b.current) - Number(a.current) || b.draft.savedAt - a.draft.savedAt);
  const first = candidates[0];
  if (remembered && (!first || !first.current || remembered.savedAt >= first.draft.savedAt)) return { draft: remembered, source: "memory", error: errors.join(". ") || undefined };
  return { draft: first?.draft ?? null, source: first?.source ?? null, error: errors.join(". ") || undefined };
}
export function readPendingDraft(userId: string, projectId: string): PendingDraft | null {
  return readPendingDraftResult(userId, projectId).draft;
}
export function persistPendingDraft(userId: string, projectId: string, draft: PendingDraft): DraftStorageResult {
  if (captureLocalWrite(userId) === null) return { stored: false, durable: false, error: "Local recovery writes are paused during sign-out." };
  const currentKey = key(userId, projectId);
  const owned = { ...draft, storageId: currentTab(), removalGeneration: localAccountFence(userId).lastRemoval };
  memory.set(currentKey, owned);
  let text: string;
  try { text = JSON.stringify(owned); }
  catch { return { stored: false, durable: false, error: "The local design could not be serialized for recovery" }; }
  if (text.length > MAX_DRAFT_CHARACTERS) return { stored: false, durable: false, error: "The design and merge base exceed the 4,000,000-character recovery limit. Download the local design before leaving." };
  try {
    localStorage.setItem(currentKey, text);
    try { sessionStorage.removeItem(currentKey); } catch { /* The durable write succeeded. */ }
    return { stored: true, durable: true };
  } catch {
    try {
      sessionStorage.setItem(currentKey, text);
      return { stored: true, durable: false, error: "Durable recovery storage is full or disabled. This copy is available only in this tab; download it before closing." };
    } catch {
      return { stored: false, durable: false, error: "Browser recovery storage is unavailable. This copy remains in memory only; download it before closing." };
    }
  }
}
export function storePendingDraft(userId: string, projectId: string, draft: PendingDraft): boolean {
  return persistPendingDraft(userId, projectId, draft).stored;
}
/** Default cleanup affects only this tab; another tab's recovery remains intact. */
export function clearPendingDraft(userId: string, projectId: string): DraftStorageResult {
  const currentKey = key(userId, projectId);
  memory.delete(currentKey);
  const errors: string[] = [];
  try { localStorage.removeItem(currentKey); } catch { errors.push("Durable recovery could not be removed"); }
  try { sessionStorage.removeItem(currentKey); sessionStorage.removeItem(legacyKey(userId, projectId)); } catch { errors.push("Tab recovery could not be removed"); }
  return { stored: errors.length === 0, durable: errors.length === 0, error: errors.join(". ") || undefined };
}
export function recoveryFromAnotherTab(draft: PendingDraft): boolean { return Boolean(draft.storageId && draft.storageId !== currentTab()); }
/** Remove only the selected unchanged recovery; preserve edits made by its owning tab. */
export function clearRecoveredDraft(userId: string, projectId: string, selected: PendingDraft): void {
  if (!selected.storageId || !validId(selected.storageId) || selected.storageId === currentTab()) return;
  try {
    const selectedKey = prefix(userId, projectId) + selected.storageId;
    for (const storage of [localStorage, sessionStorage]) {
      const text = storage.getItem(selectedKey);
      if (text && parse(text).savedAt === selected.savedAt) storage.removeItem(selectedKey);
    }
  } catch { /* The selected recovery remains available if cleanup fails. */ }
}
export function hasMergeBase(draft: PendingDraft): draft is PendingDraft & { baseDesign: Design; baseName: string; baseProjectType: ProjectType } {
  return designValid(draft.baseDesign) && typeof draft.baseName === "string" && projectTypeValid(draft.baseProjectType);
}

const belongsToAccount = (storedKey: string, userId: string) => storedKey.startsWith(PREFIX + encodeURIComponent(userId) + ":") || storedKey.startsWith("groundwork:draft:" + userId + ":");
export interface AccountDraftRecord { storage: "local" | "session" | "memory"; key: string; value: string; }
export function exportAccountDrafts(userId: string): AccountDraftRecord[] {
  localAccountFence(userId);
  const records: AccountDraftRecord[] = [];
  for (const [key, draft] of memory) if (belongsToAccount(key, userId)) records.push({ storage: "memory", key, value: JSON.stringify(draft) });
  for (const [storage, label] of [[globalThis.localStorage, "local"], [globalThis.sessionStorage, "session"]] as const) {
    if (!storage) continue;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && belongsToAccount(key, userId)) { const value = storage.getItem(key); if (value !== null) records.push({ storage: label, key, value }); }
    }
  }
  return records;
}
export function removeAccountDrafts(userId: string, localOnly = false, removalGeneration = localAccountFence(userId).lastRemoval): void {
  for (const [storedKey, draft] of memory) if (belongsToAccount(storedKey, userId) && (!localOnly || draft.removalGeneration !== removalGeneration)) memory.delete(storedKey);
  for (const storage of localOnly ? [globalThis.sessionStorage] : [globalThis.localStorage, globalThis.sessionStorage]) {
    if (!storage) continue;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || !belongsToAccount(key, userId)) continue;
      if (localOnly) {
        const text = storage.getItem(key);
        try { if (text && text.length <= MAX_DRAFT_CHARACTERS && (JSON.parse(text) as PendingDraft | null)?.removalGeneration === removalGeneration) continue; }
        catch { /* Unreadable copies from a removed account are stale. */ }
      }
      keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  }
}
subscribeLocalDataFence((userId, fence) => {
  if (fence.remove) { try { removeAccountDrafts(userId, fence.localOnly === true, fence.lastRemoval); } catch { /* Explicit removal reports current-tab errors through the purge operation. */ } }
}, true);
