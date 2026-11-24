import { useEffect, useMemo, useRef, useState } from "react";
import { getProject } from "../api";
import type { ProjectDetail } from "../types";
import { hasMergeBase, type PendingDraft } from "../lib/offlineDraft";
import { mergeDesignDocuments, type MergeChoice, type MergeDocument } from "../lib/designMerge";
import { download } from "../lib/download";
import { Button, Modal, Select } from "./ui";

export function DraftConflictPanel({ accountId, projectId, draft, remoteDocument, onApply, onClose }: { accountId: string; projectId: string; draft: PendingDraft; remoteDocument: (project: ProjectDetail) => MergeDocument; onApply: (document: MergeDocument, remote: ProjectDetail) => void; onClose: () => void }) {
  const [remote, setRemote] = useState<ProjectDetail | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true); setRemote(null); setChoices({}); setPage(0); setMessage("");
    void getProject(projectId, accountId).then(project => { if (generation.current === current) setRemote(project); })
      .catch(error => { if (generation.current === current) setMessage(error instanceof Error ? error.message : "Could not fetch the remote project."); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current++; };
  }, [projectId, accountId, draft]);
  const result = useMemo(() => {
    if (!remote || !hasMergeBase(draft)) return { merge: null, error: "" };
    try {
      return { merge: mergeDesignDocuments({ design: draft.baseDesign, name: draft.baseName, projectType: draft.baseProjectType }, { design: draft.design, name: draft.name, projectType: draft.projectType }, remoteDocument(remote), choices), error: "" };
    } catch (error) { return { merge: null, error: error instanceof Error ? error.message : "Could not compare the designs." }; }
  }, [remote, draft, choices, remoteDocument]);
  const merge = result.merge, pages = Math.max(1, Math.ceil((merge?.conflicts.length ?? 0) / 50)), currentPage = Math.min(page, pages - 1);
  const apply = async () => {
    if (!merge || merge.unresolved || !remote || busy) return;
    const current = generation.current;
    setBusy(true); setMessage("");
    try {
      const fresh = await getProject(projectId, accountId);
      if (current !== generation.current) return;
      if (fresh.role === "viewer") throw new Error("Editor access is required to save the merge.");
      if (fresh.revision !== remote.revision) { setRemote(fresh); setChoices({}); setPage(0); setMessage("The remote project changed again. Review the updated comparison before applying."); return; }
      onApply(merge.document, fresh);
    } catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : "Could not prepare the merge."); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const preview = (value: unknown) => value === undefined ? "(deleted / absent)" : (JSON.stringify(value, null, 2) ?? "(unavailable)").slice(0, 2000);
  return <Modal open onClose={onClose} title="Compare local and remote design" wide>
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Independent changes merge automatically. Conflicting values, deletion versus edits and object ordering require a choice. The remote revision is checked again before scheduling a save; permissions and object locks still apply.</p>
      {!hasMergeBase(draft) && <p className="text-xs text-amber-300">This older recovery has no original design. Download it or retry its original revision.</p>}
      {(message || result.error) && <p role="status" className="text-xs text-amber-300">{message || result.error}</p>}
      {merge && <>
        <p className="text-xs text-slate-300">{merge.conflicts.length} conflicts · {merge.unresolved} need a choice · remote revision {remote?.revision}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoices(Object.fromEntries(merge.conflicts.map(conflict => [conflict.key, "local" as const])))}>Choose local for all conflicts</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoices(Object.fromEntries(merge.conflicts.map(conflict => [conflict.key, "remote" as const])))}>Choose remote for all conflicts</Button>
          <Button size="sm" variant="ghost" onClick={() => download("design-conflicts.json", JSON.stringify({ baseRevision: draft.baseRevision, remoteRevision: remote?.revision, conflicts: merge.conflicts }, null, 2), "application/json")}>Download comparison</Button>
        </div>
        <div className="max-h-[55vh] space-y-2 overflow-auto">{merge.conflicts.slice(currentPage * 50, (currentPage + 1) * 50).map(conflict => <div key={conflict.key} className="rounded-lg border border-slate-700 p-3">
          <p className="break-all text-xs font-semibold text-slate-200">{conflict.path} · {conflict.kind}</p>
          <Select aria-label={"Resolve " + conflict.path} disabled={busy} value={choices[conflict.key] ?? ""} onChange={event => { const value = event.target.value as MergeChoice | ""; setChoices(previous => { const next = { ...previous }; if (value) next[conflict.key] = value; else delete next[conflict.key]; return next; }); }}><option value="">Choose a value</option><option value="local">Keep local</option><option value="remote">Keep remote</option></Select>
          <details className="mt-2 text-[10px] text-slate-400"><summary>Inspect original, local and remote values</summary>{(["base", "local", "remote"] as const).map(side => <div key={side}><p className="mt-2 font-semibold">{side}</p><pre className="overflow-x-auto whitespace-pre-wrap break-all">{preview(conflict[side])}</pre></div>)}<p>Previews stop at 2,000 characters. The comparison download retains complete values.</p></details>
        </div>)}</div>
        <div className="flex justify-between"><Button size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button><span className="text-xs text-slate-500">{currentPage + 1}/{pages}</span><Button size="sm" variant="ghost" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</Button></div>
      </>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button><Button disabled={busy || !merge || merge.unresolved > 0 || remote?.role === "viewer"} onClick={() => void apply()}>Apply merge & save</Button></div>
    </div>
  </Modal>;
}
