import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProjectRevision,
  createProjectShareLink,
  listProjectRevisions,
  listProjectShareLinks,
  restoreProjectRevision,
  revokeProjectShareLink,
} from "../api";
import type { Design, Project, ProjectRevision, ProjectShareLink, ProjectType } from "../types";
import { Badge, Button, Input, Modal } from "./ui";
import { useToast } from "./Toast";
import { timeAgo } from "../lib/format";

export function ProjectHistory({
  projectId,
  role,
  currentDesign,
  currentRevision,
  onRestored,
}: {
  projectId: string;
  role: NonNullable<Project["role"]>;
  currentDesign: Design;
  currentRevision: number;
  onRestored: (state: { design: Design | null; projectType: ProjectType; widthMm: number; depthMm: number }) => void;
}) {
  const canWrite = role !== "viewer";
  const canShare = role === "owner";
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<ProjectRevision[]>([]);
  const [links, setLinks] = useState<ProjectShareLink[]>([]);
  const [snapshotName, setSnapshotName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const busyRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const alive = useRef(false);
  const scope = useRef({ projectId, role, open });
  scope.current = { projectId, role, open };
  const scopeGeneration = useRef(0);
  const requestGeneration = useRef(0);

  useEffect(() => { alive.current = true; return () => { alive.current = false; scopeGeneration.current += 1; requestGeneration.current += 1; }; }, []);

  useEffect(() => {
    scopeGeneration.current += 1; requestGeneration.current += 1;
    setOpen(false); setRevisions([]); setLinks([]); setSnapshotName(""); setNewUrl(null);
    setBusy(null); busyRef.current = null; setLoading(false); loadingRef.current = false; setLoadError("");
  }, [projectId, role]);

  const load = useCallback(async () => {
    if (!scope.current.open || scope.current.projectId !== projectId || scope.current.role !== role) return;
    const generation = scopeGeneration.current;
    const request = ++requestGeneration.current;
    const isCurrent = () => alive.current && scope.current.open && scope.current.projectId === projectId && scope.current.role === role && generation === scopeGeneration.current && request === requestGeneration.current;
    loadingRef.current = true; setLoading(true); setLoadError("");
    try {
      const [nextRevisions, nextLinks] = await Promise.all([
        listProjectRevisions(projectId),
        canShare ? listProjectShareLinks(projectId) : [],
      ]);
      if (isCurrent()) { setRevisions(nextRevisions); setLinks(nextLinks); }
    } catch (cause) {
      if (isCurrent()) setLoadError(cause instanceof Error ? cause.message : "Could not load project history. Try again.");
    } finally {
      if (isCurrent()) { loadingRef.current = false; setLoading(false); }
    }
  }, [canShare, projectId, role]);

  useEffect(() => {
    if (open) void load();
    return () => { scopeGeneration.current += 1; requestGeneration.current += 1; };
  }, [open, load]);

  const beginAction = (key: string) => {
    if (busyRef.current || loadingRef.current || !scope.current.open) return null;
    busyRef.current = key; setBusy(key);
    const generation = scopeGeneration.current;
    return () => alive.current && scope.current.open && scope.current.projectId === projectId && scope.current.role === role && generation === scopeGeneration.current;
  };

  const close = () => { if (!busyRef.current) setOpen(false); };

  const snapshot = async () => {
    if (!canWrite || !snapshotName.trim()) return;
    const isCurrent = beginAction("snapshot");
    if (!isCurrent) return;
    try {
      const created = await createProjectRevision(projectId, snapshotName.trim(), JSON.stringify(currentDesign));
      if (!isCurrent()) return;
      setRevisions((current) => [created, ...current]);
      setSnapshotName("");
      toast.push({ title: "Snapshot saved", tone: "success" });
    } catch (err) {
      if (isCurrent()) toast.push({ title: "Snapshot failed", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally { if (isCurrent()) { busyRef.current = null; setBusy(null); } }
  };

  const restore = async (revision: ProjectRevision) => {
    if (!canWrite || busyRef.current || loadingRef.current) return;
    if (!window.confirm(`Restore “${revision.name}”? Current unsnapshotted changes will be replaced.`)) return;
    const isCurrent = beginAction(revision.id);
    if (!isCurrent) return;
    try {
      const restored = await restoreProjectRevision(projectId, revision.id, currentRevision);
      if (!isCurrent()) return;
      onRestored({ design: restored.design, projectType: restored.projectType as ProjectType, widthMm: restored.widthMm, depthMm: restored.depthMm });
      toast.push({ title: "Snapshot restored", description: revision.name, tone: "success" });
    } catch (err) {
      if (isCurrent()) toast.push({ title: "Restore failed", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally { if (isCurrent()) { busyRef.current = null; setBusy(null); } }
  };

  const share = async () => {
    if (!canShare) return;
    const isCurrent = beginAction("share");
    if (!isCurrent) return;
    try {
      const created = await createProjectShareLink(projectId);
      if (!isCurrent()) return;
      const url = `${window.location.origin}${created.url}`;
      setNewUrl(url);
      try {
        const nextLinks = await listProjectShareLinks(projectId);
        if (isCurrent()) setLinks(nextLinks);
      } catch {
        if (isCurrent()) setLoadError("Your link was created, but the link list could not be refreshed. Retry to refresh the list.");
      }
      if (!isCurrent()) return;
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      if (isCurrent()) toast.push({ title: "Read-only link created", description: "The link was copied when browser permissions allowed it.", tone: "success" });
    } catch (err) {
      if (isCurrent()) toast.push({ title: "Could not create share link", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally { if (isCurrent()) { busyRef.current = null; setBusy(null); } }
  };

  const revoke = async (link: ProjectShareLink) => {
    if (!canShare) return;
    const isCurrent = beginAction(link.id);
    if (!isCurrent) return;
    try {
      await revokeProjectShareLink(projectId, link.id);
      if (!isCurrent()) return;
      setLinks((current) => current.map((item) => item.id === link.id ? { ...item, active: false, revokedAt: Date.now() / 1000 } : item));
    } catch (err) {
      if (isCurrent()) toast.push({ title: "Could not revoke link", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally { if (isCurrent()) { busyRef.current = null; setBusy(null); } }
  };

  return <>
    <Button variant="secondary" size="sm" onClick={() => { loadingRef.current = true; setLoading(true); setLoadError(""); setOpen(true); }} aria-label="Open project history" aria-haspopup="dialog">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 109-9 9 9 0 00-7 3" /><path d="M3 4v5h5M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      History
    </Button>
    <Modal open={open} onClose={close} title={canShare ? "Project history & sharing" : "Project history"}>
      <div className="space-y-5">
        {loadError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3"><p role="alert" className="text-xs leading-relaxed text-rose-300">{loadError}</p><Button variant="secondary" size="sm" className="mt-2" onClick={() => void load()} disabled={Boolean(busy)} loading={loading}>Retry</Button></div>}
        {busy && <p role="status" className="text-xs text-slate-400">{busy === "snapshot" ? "Saving your snapshot…" : busy === "share" ? "Creating your read-only link…" : "Updating your project…"}</p>}
        {canWrite && <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Save current design</p>
          <form className="mt-2 flex items-end gap-2" onSubmit={event => { event.preventDefault(); void snapshot(); }}>
            <div className="min-w-0 flex-1"><Input label="Snapshot name" placeholder="e.g. Client review" value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} disabled={Boolean(busy) || loading} /></div>
            <Button type="submit" size="sm" loading={busy === "snapshot"} disabled={!snapshotName.trim() || Boolean(busy) || loading}>Save</Button>
          </form>
          <p className="mt-1 text-xs text-slate-500">Snapshots are encrypted at rest and owned by this account.</p>
        </div>}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Snapshots</p>
          {loading ? <p role="status" className="mt-2 text-sm text-slate-400">Loading project history…</p> : revisions.length === 0 ? !loadError && <p className="mt-2 text-sm text-slate-500">No named snapshots yet.</p> : <div className="mt-2 space-y-2">
            {revisions.map((revision) => <div key={revision.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-200">{revision.name}</p><p className="text-xs text-slate-500">{timeAgo(revision.createdAt)}</p></div>
              {canWrite && <Button variant="ghost" size="sm" onClick={() => void restore(revision)} loading={busy === revision.id} disabled={Boolean(busy) || loading}>Restore</Button>}
            </div>)}
          </div>}
        </div>
        {canShare && <div>
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Read-only links</p><p className="mt-1 text-xs text-slate-500">Links expire after 7 days and never grant edit access.</p></div><Button size="sm" variant="outline" onClick={() => void share()} loading={busy === "share"} disabled={Boolean(busy) || loading}>Create link</Button></div>
          {newUrl && <div className="mt-2 break-all rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-300">{newUrl}</div>}
          {!loading && !loadError && links.length === 0 && <p className="mt-2 text-xs text-slate-500">No read-only links yet.</p>}
          <div className="mt-2 space-y-2">{!loading && links.map((link) => <div key={link.id} className="flex items-center gap-2 text-xs"><Badge tone={link.active ? "emerald" : "slate"}>{link.active ? "Active" : "Inactive"}</Badge><span className="flex-1 text-slate-500">expires {new Date(link.expiresAt * 1000).toLocaleDateString()}</span>{link.active && <Button variant="ghost" size="sm" onClick={() => void revoke(link)} loading={busy === link.id} disabled={Boolean(busy) || loading}>Revoke</Button>}</div>)}</div>
        </div>}
      </div>
    </Modal>
  </>;
}
