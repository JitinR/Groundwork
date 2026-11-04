import { useEffect, useRef, useState } from "react";
import type { CadAnalysisRecord, Design } from "../types";
import { cadCoordinationScene } from "../lib/cadCoordination";
import { cadGeometryFingerprint } from "../lib/cadModel";
import { cadObjects } from "../lib/cadModel";
import { cadMep } from "../lib/cadNetworks";
import type { GeometryResponse } from "../lib/geometry.worker";
import type { MeshClashReport } from "../lib/meshClash";

interface Props { design: Design; readOnly: boolean; onRecord: (record: CadAnalysisRecord) => void; onFocus: (ids: string[]) => void; }
export function CadCoordinationPanel({ design, readOnly, onRecord, onFocus }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const worker = useRef<Worker | null>(null), timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(design); latest.current = design;
  useEffect(() => () => { worker.current?.terminate(); if (timeout.current) clearTimeout(timeout.current); }, []);
  const record = design.cad?.analyses?.find(item => item.id === "cad-mesh-coordination");
  const report = record?.result as unknown as MeshClashReport | undefined;
  const labels = new Map([...cadObjects(design).map(item => [item.id, item.label ?? item.kind] as const), ...cadMep(design).elements.map(item => [item.id, item.name] as const)]);
  const stop = () => { worker.current?.terminate(); worker.current = null; if (timeout.current) clearTimeout(timeout.current); setBusy(false); };
  const run = () => {
    stop(); setError("");
    try {
      const scene = cadCoordinationScene(design), fingerprint = cadGeometryFingerprint(design), revision = design.cad?.revision ?? 0;
      if (!scene.meshes.length) throw new Error("Create architectural solids or MEP routes before running this check.");
      const sourceObjectIds = [...new Set(scene.meshes.map(mesh => mesh.sourceId))];
      const instance = new Worker(new URL("../lib/geometry.worker.ts", import.meta.url), { type: "module" }); worker.current = instance; setBusy(true);
      instance.onmessage = (event: MessageEvent<GeometryResponse>) => {
        const response = event.data;
        if (response.kind === "error") { setError(response.message); stop(); return; }
        if (response.kind !== "clashes") return;
        stop();
        if (cadGeometryFingerprint(latest.current) !== fingerprint || (latest.current.cad?.revision ?? 0) !== revision) { setError("Model changed while checking. The outdated result was discarded; run the check again."); return; }
        onRecord({ id: "cad-mesh-coordination", sourceObjectIds, sourceRevision: revision, status: "current", method: "Groundwork triangle SAT / closed-mesh containment in geometry worker", units: "m", inputs: { sourceObjectIds, toleranceM: 1e-6, scope: "Authored CAD solids and nominal MEP meshes, all visibility states" }, assumptions: scene.warnings, designBasis: "Physical mesh coordination at 1 micrometre numerical tolerance; service clearance envelopes are a separate approximate screen", result: response.report as unknown as Record<string, unknown> });
      };
      instance.onerror = () => { setError("The coordination worker failed. The project was not changed."); stop(); };
      timeout.current = setTimeout(() => { setError("Coordination exceeded the 30-second limit. Review a smaller subset."); stop(); }, 30000);
      instance.postMessage({ id: 1, operation: "clash", scene, tolerance: 1e-6 });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Coordination could not start"); stop(); }
  };
  return <section className="cad-group"><div className="cad-section-title"><h3>Physical mesh check</h3><span className={`cad-validity ${record?.status ?? "incomplete"}`}>{record?.status === "needs-recalculation" ? "Needs recalculation" : record?.status ?? "Not run"}</span></div><p className="cad-muted">Uses the existing mesh solver with the same authored geometry as the viewport and GLB. Hidden elements remain in the check. Context geometry and clearance volumes are excluded.</p><button className="cad-button cad-primary" disabled={readOnly || busy} onClick={run}>{busy ? "Checking mesh geometry…" : "Check physical intersections"}</button>{busy && <button className="cad-button" onClick={stop}>Cancel check</button>}
    {error && <p className="cad-issue" role="alert">{error}</p>}
    {report && <><p className="cad-muted">Model r{record?.sourceRevision} · {report.complete ? "Complete within scope" : "Partial report — review limits"} · {report.triangleTests} triangle tests</p>{report.warnings.map((warning, index) => <p key={index} className="cad-muted">{warning}</p>)}{report.clashes.slice(0,80).map((clash,index) => <button className="cad-issue cad-linked-issue" key={`${clash.meshA}-${clash.meshB}-${index}`} onClick={() => onFocus([clash.a,clash.b])}><strong>{clash.kind === "coplanar-contact" ? "Physical contact" : "Physical intersection"}</strong><br />{labels.get(clash.a) ?? clash.a.slice(0,8)} / {labels.get(clash.b) ?? clash.b.slice(0,8)}<small>Focus and highlight objects →</small></button>)}{!report.clashes.length && <p className="cad-muted">No physical mesh intersections found within the reported scope.</p>}</>}
  </section>;
}
