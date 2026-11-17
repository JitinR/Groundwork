import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { BuildingLevel, CadAnalysisRecord, Design, DraftElement } from "../types";
import { cadObjects, cadLevels, cadKind, cadQuantities, createCadObject, executeCadCommand, resizeDraft, type CadCommand, type CadKind } from "../lib/cadModel";
import { resolveDraft } from "../lib/parametric";
import { download, downloadBlob } from "../lib/download";
import { useTheme } from "../theme";
import { CadAnalysisPanel } from "./CadAnalysisPanel";
import { CadCoordinationPanel } from "./CadCoordinationPanel";
import type { CadViewportApi } from "../editor/CadViewport";
import { CadIcon } from "./CadIcon";
import { CAD_SYSTEM_LABELS, type CadSystem } from "../lib/cadNetworks";
import { CAD_VIEWS, systemForDiscipline, workingPlaneElevation, starterFrameCommands } from "../lib/cadWorkspaceContext";
import "./cad-workspace.css";

const DesignExportMenu = lazy(() => import("./DesignExportMenu").then(module => ({ default: module.DesignExportMenu })));
const CadViewport = lazy(() => import("../editor/CadViewport").then(module => ({ default: module.CadViewport })));
const CadSystemsPanel = lazy(() => import("./CadSystemsPanel").then(module => ({ default: module.CadSystemsPanel })));
export type CadDiscipline = "architecture" | "structure" | "electrical" | "plumbing" | "coordination";
type Tool = "select" | "move" | "rotate" | "resize" | `place:${string}`;
type Unit = "m" | "mm" | "ft";
const DISCIPLINES: [CadDiscipline, string][] = [["architecture", "Architecture"], ["structure", "Structure / Civil"], ["electrical", "Electrical"], ["plumbing", "Plumbing"], ["coordination", "Coordination"]];
const LABELS: Record<string, string> = { column: "Column", "circular-column": "Round column", wall: "Wall", beam: "Beam", slab: "Slab", roof: "Roof" };
const CANVAS_TOOLS = new Map<string, Tool>([["v", "select"], ["m", "move"], ["r", "rotate"], ["s", "resize"]]);
const factor = (unit: Unit) => unit === "mm" ? 1000 : unit === "ft" ? 1 / 0.3048 : 1;
const editable = (event: KeyboardEvent) => event.target instanceof HTMLElement && (event.target.closest("[role=dialog]") || event.target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName));

function NumberField({ label, value, unit, onCommit, disabled, angle = false }: { label: string; value: number; unit: Unit; onCommit: (n: number) => void; disabled?: boolean; angle?: boolean }) {
  const multiplier = angle ? 1 : factor(unit);
  const [text, setText] = useState(String(Number((value * multiplier).toFixed(4))));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(Number((value * multiplier).toFixed(4)))); }, [value, multiplier]);
  const commit = () => { focused.current = false; if (cancelled.current) { cancelled.current = false; return; } if (text.trim() && Number.isFinite(Number(text))) onCommit(Number(text) / multiplier); else setText(String(Number((value * multiplier).toFixed(4)))); };
  return <label className="cad-field">{label}<span>{angle ? "°" : unit}</span><input type="number" step="any" aria-label={`${label} ${angle ? "degrees" : unit}`} value={text} disabled={disabled} onFocus={() => { focused.current = true; }} onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelled.current = true; setText(String(Number((value * multiplier).toFixed(4)))); focused.current = false; event.currentTarget.blur(); } }} /></label>;
}

function FootprintEditor({ object, width, depth, units, disabled, onModify }: { object: DraftElement; width: number; depth: number; units: Unit; disabled: boolean; onModify: (patch: Partial<DraftElement>, label?: string) => void }) {
  const points = object.points;
  const apply = (next: { x: number; z: number }[]) => {
    const w = Math.max(...next.map(point => point.x)) - Math.min(...next.map(point => point.x));
    const d = Math.max(...next.map(point => point.z)) - Math.min(...next.map(point => point.z));
    onModify({ points: next, w, d, family: { ...object.family, typeParameters: { ...object.family?.typeParameters, width: w, depth: d } } }, "Footprint boundary committed");
  };
  return <section className="cad-group"><h3>Footprint boundary</h3>{!points?.length ? <button className="cad-button" disabled={disabled} onClick={() => apply([{ x: -width / 2, z: -depth / 2 }, { x: width / 2, z: -depth / 2 }, { x: width / 2, z: depth / 2 }, { x: -width / 2, z: depth / 2 }])}>Enable boundary vertices</button> : <><p className="cad-muted">Purple grips edit vertices in the object's local plane. Invalid or crossing boundaries are rejected. Exact coordinates below retain the object's origin and rotation.</p><details><summary>Exact vertex coordinates</summary>{points.slice(0,64).map((point, index) => <div key={index} className="cad-opening"><strong>Vertex {index + 1}</strong><div className="cad-field-pair">{(["x", "z"] as const).map(axis => <NumberField key={axis} label={`Vertex ${index + 1} ${axis.toUpperCase()}`} value={point[axis]} unit={units} disabled={disabled} onCommit={value => apply(points.map((item, i) => i === index ? { ...item, [axis]: value } : item))} />)}</div><button className="cad-button" disabled={disabled || points.length >= 1024} onClick={() => { const next = points[(index + 1) % points.length]; apply([...points.slice(0,index + 1), { x: (point.x + next.x) / 2, z: (point.z + next.z) / 2 }, ...points.slice(index + 1)]); }}>Insert edge midpoint</button><button className="cad-button" disabled={disabled || points.length <= 3} onClick={() => apply(points.filter((_, i) => i !== index))}>Remove vertex</button></div>)}{points.length > 64 && <p className="cad-muted">First 64 vertices shown; use canvas grips for remaining vertices.</p>}</details></>}</section>;
}

interface Props { design: Design; onChange: (next: Design) => void; projectName: string; readOnly: boolean; saving: boolean; saved: boolean; remoteRevision: number | null; onSave: () => void; onLegacy: (target?: "drafting") => void; draftingAvailable?: boolean; projectControls?: ReactNode; }
export function CadWorkspace({ design, onChange, projectName, readOnly, saving, saved, remoteRevision, onSave, onLegacy, draftingAvailable, projectControls }: Props) {
  const [discipline, setDiscipline] = useState<CadDiscipline>("architecture");
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Design | null>(null);
  const [units, setUnits] = useState<Unit>("m");
  const [levelId, setLevelId] = useState("");
  const [plane, setPlane] = useState<{ levelId: string; offset: number } | null>(null);
  const [projection, setProjection] = useState<"perspective" | "orthographic">("perspective");
  const [displayMode, setDisplayMode] = useState<"shaded" | "edges" | "wireframe">("edges");
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(0.1);
  const [symmetric, setSymmetric] = useState(false);
  const [section, setSection] = useState(false);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1100);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth >= 900);
  const [inspector, setInspector] = useState<"properties" | "analysis" | "systems" | "issues">("properties");
  const [status, setStatus] = useState("Select an object. Drag a face grip to resize. Focus the canvas for M move and R rotate.");
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [preferredSystem, setPreferredSystem] = useState<CadSystem>("electrical");
  const activeSystem = systemForDiscipline(discipline, preferredSystem);
  const [numeric, setNumeric] = useState("");
  const numericInput = useRef<HTMLInputElement | null>(null);
  const numericFocusRequested = useRef(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [viewportApi, setViewportApi] = useState<CadViewportApi | null>(null);
  const history = useRef<{ past: Design[]; future: Design[] }>({ past: [], future: [] });
  const source = useRef(design); source.current = design;
  const expected = useRef(design);
  const theme = useTheme();
  const active = preview ?? design;
  const objects = cadObjects(active);
  const levels = cadLevels(active);
  const level = levels.find(item => item.id === levelId) ?? levels[0];
  const workingElevation = workingPlaneElevation(level, plane);
  const selected = objects.find(item => item.id === selectedId);
  const resolved = selected ? resolveDraft(selected, levels) : null;
  const modelRevision = design.cad?.revision ?? 0;
  const writable = !readOnly && remoteRevision === null;
  useEffect(() => {
    // Remote restoration/recovery cannot inherit an undo stack from a different document.
    if (expected.current !== design) { history.current = { past: [], future: [] }; setPreview(null); setHistoryVersion(n => n + 1); }
    expected.current = design;
  }, [design]);
  const commit = useCallback((next: Design, label: string) => {
    if (!writable) { setStatus("This project is read-only or has a remote revision conflict. Resolve access/conflict before editing."); setPreview(null); return; }
    try {
      const result = executeCadCommand(source.current, { type: "replace", next, expectedRevision: source.current.cad?.revision ?? 0 });
      if (JSON.stringify(result) === JSON.stringify(source.current)) { setPreview(null); return; }
      history.current.past = [...history.current.past.slice(-79), source.current]; history.current.future = [];
      expected.current = result; source.current = result; onChange(result); setPreview(null); setHistoryVersion(n => n + 1); setStatus(`${label} · model r${result.cad?.revision ?? 0}`);
    } catch (e) { setPreview(null); setStatus(e instanceof Error ? e.message : "Command rejected"); }
  }, [onChange, writable]);
  const command = useCallback((action: CadCommand, label: string) => {
    if (!writable) { setStatus("Project is read-only."); return; }
    try {
      const result = executeCadCommand(source.current, { ...action, expectedRevision: source.current.cad?.revision ?? 0 });
      if (result === source.current) return;
      history.current.past = [...history.current.past.slice(-79), source.current]; history.current.future = [];
      expected.current = result; source.current = result; onChange(result); setPreview(null); setHistoryVersion(n => n + 1); setStatus(label);
    } catch (e) { setStatus(e instanceof Error ? e.message : "Command rejected"); }
  }, [onChange, writable]);
  const travel = useCallback((forward: boolean) => {
    viewportApi?.cancelDrag(); setPreview(null);
    if (!writable) return;
    const stack = forward ? history.current.future : history.current.past;
    const next = stack.pop(); if (!next) return;
    (forward ? history.current.past : history.current.future).push(source.current);
    // Preserve the restored geometry/result pairing while keeping the command revision monotonic.
    const revision = (source.current.cad?.revision ?? 0) + 1;
    const restored: Design = { ...next, cad: { ...next.cad, version: 1, revision, analyses: next.cad?.analyses?.map(item => item.status === "current" ? { ...item, sourceRevision: revision } : item) } };
    expected.current = restored; source.current = restored; onChange(restored); setHistoryVersion(n => n + 1); setStatus(forward ? "Redo complete" : "Undo complete");
  }, [onChange, viewportApi, writable]);
  const remove = useCallback(() => { if (selectedId) { command({ type: "delete", ids: [selectedId] }, "Object deleted; affected relationships flagged"); setSelectedId(null); } }, [command, selectedId]);
  const duplicate = useCallback(() => { if (selectedId) command({ type: "duplicate", ids: [selectedId], offset: { x: 1, y: 0, z: 1 } }, "Duplicate created 1 m along X and Z"); }, [command, selectedId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || editable(event)) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === "z") { event.preventDefault(); travel(event.shiftKey); }
      else if (ctrl && event.key.toLowerCase() === "y") { event.preventDefault(); travel(true); }
      else if (ctrl && event.key.toLowerCase() === "d") { event.preventDefault(); duplicate(); }
      else if (ctrl && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
      else if (event.key === "Escape") { viewportApi?.cancelDrag(); setPreview(null); setTool("select"); setStatus("Operation cancelled; Select active."); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [duplicate, onSave, remove, travel, viewportApi]);
  const handleCanvasShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
      !(event.target instanceof HTMLCanvasElement) || !event.target.matches(".cad-viewport > canvas")) return;
    const key = event.key.toLowerCase();
    if (key === "f") viewportApi?.fit(Boolean(selectedId));
    const next = CANVAS_TOOLS.get(key);
    if (next && (next === "select" || writable)) setTool(next);
  };
  const attachNumericInput = useCallback((input: HTMLInputElement | null) => {
    numericInput.current = input;
    if (input && numericFocusRequested.current) {
      numericFocusRequested.current = false;
      input.focus({ preventScroll: true });
    }
  }, []);
  const requestNumericFocus = () => {
    if (numericInput.current) numericInput.current.focus({ preventScroll: true });
    else numericFocusRequested.current = true;
  };
  const modify = (patch: Partial<DraftElement>, label = "Properties updated") => { if (selected) command({ type: "modify", id: selected.id, patch }, label); };
  const resize = (axis: "x" | "y" | "z", value: number) => { if (selected) { try { modify(resizeDraft(selected, axis, 1, value, symmetric, levels), "Exact dimension committed"); } catch (e) { setStatus(e instanceof Error ? e.message : "Invalid dimension"); } } };
  const place = (point: { x: number; y: number; z: number }) => {
    if (!tool.startsWith("place:")) return;
    const object = createCadObject(tool.slice(6) as CadKind);
    object.x = point.x; object.z = point.z; object.elevationM = point.y;
    object.family = { ...object.family, levelId: level?.id, instanceParameters: { ...object.family?.instanceParameters, baseOffset: point.y - (level?.elevation ?? 0) } };
    command({ type: "create", object }, `${LABELS[cadKind(object)] ?? object.kind} placed`); setSelectedId(object.id); setTool("select"); setInspector("properties"); setRightOpen(true);
    if (window.innerWidth < 760) setLeftOpen(false);
  };
  const starter = () => {
    const commands = starterFrameCommands(level, workingElevation);
    command({ type: "batch", commands }, "Starter frame created as one undo transaction"); setSelectedId((commands[1] as { object: DraftElement }).object.id); setTimeout(() => viewportApi?.fit(false), 50);
  };
  const addLevel = () => {
    const next: BuildingLevel = { id: crypto.randomUUID(), name: `Level ${levels.length}`, elevation: Math.max(...levels.map(item => item.elevation), 0) + 3, floorHeight: 3 };
    const update: Design = design.community ? { ...design, community: { ...design.community, levels: [...levels, next] } } : { ...design, cad: { ...design.cad, version: 1, revision: modelRevision, levels: [...levels, next] } };
    commit(update, "Level added"); setLevelId(next.id); setPlane(null);
  };
  const quantities = useMemo(() => cadQuantities(active).filter(item => ["wall", "column", "circular-column", "beam", "slab", "roof"].includes(item.kind)).reduce((sum, item) => ({ count: sum.count + 1, volume: sum.volume + item.volumeM3, area: sum.area + (["slab", "roof"].includes(item.kind) ? item.areaM2 : 0) }), { count: 0, volume: 0, area: 0 }), [active]);
  const issues = useMemo(() => {
    const objects = cadObjects(design), levels = cadLevels(design);
    const result: { id: string; text: string }[] = [];
    const ids = new Set(objects.map(object => object.id));
    for (const object of objects) {
      if (result.length >= 80) break;
      if (!object.material) result.push({ id: object.id, text: `${object.label ?? LABELS[cadKind(object)] ?? object.kind}: material is unassigned; engineering properties are required separately.` });
      if (object.family?.hostId && !ids.has(object.family.hostId)) result.push({ id: object.id, text: "Hosting object is missing. Review the hosted element." });
    }
    // Conservative object-envelope screening; no automatic penetrations or structural cuts.
    const count = Math.min(objects.length, 200);
    for (let a = 0; a < count && result.length < 80; a++) for (let b = a + 1; b < count && result.length < 80; b++) {
      const first = objects[a], second = objects[b]; if (!["wall", "beam", "column"].includes(first.kind) || !["wall", "beam", "column"].includes(second.kind)) continue;
      const x = resolveDraft(first, levels), y = resolveDraft(second, levels);
      if (Math.abs(first.x - second.x) < (x.width + y.width) / 2 && Math.abs(first.z - second.z) < (x.depth + y.depth) / 2 && x.elevation < y.elevation + y.height - .005 && y.elevation < x.elevation + x.height - .005) result.push({ id: first.id, text: `Envelope review: ${first.label ?? first.kind} / ${second.label ?? second.kind}. Rotations and precise solid intersections require detailed review.` });
    }
    if (objects.length > 200) result.push({ id: objects[0].id, text: "Envelope screening is limited to the first 200 objects. Run the physical mesh check for the complete authored scope." });
    return result;
  }, [design]);
  const recordAnalysis = (record: CadAnalysisRecord) => command({ type: "record-analysis", record }, "Analysis recorded with source revision and authored basis");
  const exportModel = () => download(`${projectName || "groundwork"}-model.json`, JSON.stringify({ format: "groundwork-cad", version: 1, units: "m", sourceRevision: modelRevision, objects, levels, mep: design.community?.mep ?? design.infra?.mep ?? design.mep, networks: design.cadNetworks, analyses: design.cad?.analyses, engineeringBasis: design.engineeringBasis }, null, 2), "application/json");
  return <div className={`cad-workspace ${leftOpen ? "" : "cad-left-closed"} ${rightOpen ? "" : "cad-right-closed"}`} data-tool={tool}>
    <header className="cad-projectbar"><div className="cad-wordmark"><span aria-hidden="true">▰</span>GROUNDWORK <small>MODEL STUDIO</small></div><span className="cad-project-name" title={projectName}>{projectName}</span><span role="status" aria-live="polite" className={`cad-save-state ${remoteRevision ? "cad-conflict" : ""}`}>{readOnly ? "Read-only" : remoteRevision ? "Remote changes · resolve conflict" : saving ? "Saving…" : saved ? "Saved to project" : "Draft"}</span><div className="cad-project-actions">{projectControls}<button className="cad-button" onClick={() => onLegacy()}>Project modules</button><button className="cad-button" onClick={() => theme.setMode(theme.mode === "light" ? "dark" : "light")} aria-label="Switch workspace theme">◐</button></div><button className="cad-button cad-primary cad-save-action" onClick={onSave} disabled={!writable || saving}>{saving ? "Saving…" : "Save"}</button></header>
    <nav className="cad-disciplines" aria-label="Active discipline">{DISCIPLINES.map(([id, label]) => <button key={id} aria-pressed={discipline === id} className={discipline === id ? "active" : ""} onClick={() => { viewportApi?.cancelDrag(); setPreview(null); setDiscipline(id); setSelectedId(null); setHighlightedIds([]); setNumeric(""); setTool("select"); setInspector(id === "electrical" || id === "plumbing" ? "systems" : id === "coordination" ? "issues" : "properties"); }}>{label}</button>)}<span>SI model · r{modelRevision}</span></nav>
    <div className="cad-toolbar" role="toolbar" aria-label="Modeling tools"><div className="cad-tool-group">{([["select", "↖", "Select", "V"], ["move", "✥", "Move", "M"], ["rotate", "↻", "Rotate", "R"], ["resize", "↔", "Resize", "S"]] as const).map(([id, , label, key]) => <button key={id} className={tool === id ? "active" : ""} aria-pressed={tool === id} disabled={id !== "select" && !writable} title={`${label} (${key})`} onClick={() => { viewportApi?.cancelDrag(); setTool(id); }}><CadIcon name={id} />{label}</button>)}</div>
      {(discipline === "architecture" || discipline === "structure") && <div className="cad-tool-group">{(["column", "circular-column", "wall", "beam", "slab", "roof"] as CadKind[]).map(kind => <button key={kind} disabled={!writable} className={tool === `place:${kind}` ? "active" : ""} onClick={() => { viewportApi?.cancelDrag(); setNumeric(""); setTool(`place:${kind}`); setStatus(`Place ${LABELS[kind]}. Choose a snapped point or use Place at origin, then edit exact coordinates.`); }}><CadIcon name={kind} />{LABELS[kind]}</button>)}{tool.startsWith("place:") && <button className="cad-primary" disabled={!writable} title={`Place at X 0, Z 0, elevation ${workingElevation} m; then edit exact properties`} onClick={() => place({ x: 0, y: workingElevation, z: 0 })}>Place at origin</button>}</div>}
      <div className="cad-tool-group"><button onClick={() => travel(false)} disabled={!writable || !history.current.past.length} title="Undo Ctrl+Z">↶ Undo</button><button onClick={() => travel(true)} disabled={!writable || !history.current.future.length} title="Redo Ctrl+Shift+Z">↷ Redo</button><button onClick={duplicate} disabled={!writable || !selectedId}>Duplicate</button><button onClick={remove} disabled={!writable || !selectedId}>Delete</button></div><div className="cad-tool-group cad-toolbar-end">{draftingAvailable && <button onClick={() => { viewportApi?.cancelDrag(); onLegacy("drafting"); }}>2D drafting</button>}<Suspense fallback={<span>Loading exports…</span>}><DesignExportMenu design={design} projectName={projectName} onChange={writable ? next => commit(next, "Documentation updated") : undefined} /></Suspense><button onClick={exportModel}>Model JSON</button><button onClick={() => viewportApi?.exportGlb().then(blob => downloadBlob(`${projectName || "groundwork"}.glb`, blob)).catch(() => setStatus("Geometry export failed"))}>GLB</button></div>
    </div>
    <aside className="cad-explorer" aria-label="Model explorer"><div className="cad-panel-title"><strong>MODEL EXPLORER</strong><button aria-label="Collapse model explorer" onClick={() => setLeftOpen(false)}>‹</button></div><div className="cad-explorer-meta"><span>{objects.length} authored objects</span><span>{levels.length} levels</span></div>
      <div className="cad-group"><div className="cad-section-title"><h3>Levels</h3><button className="cad-inline" onClick={addLevel} disabled={!writable}>+ Level</button></div>{levels.map(item => <button key={item.id} className={`cad-level ${level?.id === item.id ? "active" : ""}`} onClick={() => { viewportApi?.cancelDrag(); setPreview(null); setLevelId(item.id); setPlane(null); }}><span>▱ {item.name}</span><span>{item.elevation.toFixed(2)} m</span></button>)}</div>
      <div className="cad-group"><h3>Model views</h3><div className="cad-view-list">{CAD_VIEWS.map(([view, label]) => <button className="cad-button" key={view} onClick={() => { viewportApi?.cancelDrag(); setPreview(null); setProjection(view === "iso" ? "perspective" : "orthographic"); viewportApi?.setView(view); setStatus(`${label} view · ${level?.name ?? "Ground"}`); }}>{label}</button>)}</div></div>
      {Object.entries(LABELS).map(([kind, label]) => { const list = objects.filter(item => cadKind(item) === kind); if (!list.length) return null; return <div className="cad-tree-category" key={kind}><h3>{label}<span>{list.length}</span></h3>{list.map(item => <div className={`cad-object-row ${selectedId === item.id ? "selected" : ""}`} key={item.id}><button className="cad-object-select" onClick={() => { setSelectedId(item.id); setInspector("properties"); }}><span className="cad-object-symbol" style={{ color: item.color }}>▢</span><span>{item.label ?? `${label} ${item.id.slice(0, 5)}`}</span></button><button aria-label={`${item.visible === false ? "Show" : "Hide"} ${item.label ?? item.kind}`} disabled={!writable} onClick={() => command({ type: "modify", id: item.id, patch: { visible: item.visible === false } }, "Visibility updated; quantities retained")}>{item.visible === false ? "○" : "◉"}</button><button aria-label={`${item.locked ? "Unlock" : "Lock"} ${item.label ?? item.kind}`} disabled={!writable} onClick={() => command({ type: "modify", id: item.id, patch: { locked: !item.locked } }, "Object lock updated")}>{item.locked ? "▣" : "□"}</button></div>)}</div>; })}
      {!objects.length && <div className="cad-group"><p className="cad-muted">Add elements to your existing project or begin with an editable structural bay.</p><button className="cad-button cad-primary" disabled={!writable} onClick={starter}>Create starter frame</button></div>}
      <div className="cad-group cad-takeoff"><h3>Model quantities</h3><dl><dt>Authored elements</dt><dd>{quantities.count}</dd><dt>Net solid volume</dt><dd>{quantities.volume.toFixed(3)} m³</dd><dt>Slab / roof footprint</dt><dd>{quantities.area.toFixed(2)} m²</dd></dl><p className="cad-muted">Includes hidden objects and explicit wall opening deductions. Material build-ups and fabrication quantities require detailed review.</p></div>
    </aside>
    <main className="cad-canvas-panel" aria-label="CAD modeling workspace" onKeyDown={handleCanvasShortcut}><div className="cad-view-toolbar"><button className="cad-icon-button" onClick={() => { setLeftOpen(!leftOpen); if (!leftOpen && window.innerWidth < 760) setRightOpen(false); }} aria-label="Toggle model explorer">☷</button><select aria-label="Camera projection" value={projection} onChange={e => setProjection(e.target.value as typeof projection)}><option value="perspective">Perspective</option><option value="orthographic">Orthographic</option></select><select aria-label="Viewport display" value={displayMode} onChange={e => setDisplayMode(e.target.value as typeof displayMode)}><option value="edges">Shaded with edges</option><option value="shaded">Shaded</option><option value="wireframe">Wireframe</option></select><button onClick={() => viewportApi?.fit(Boolean(selectedId))}>Fit {selectedId ? "selection" : "model"}</button><button aria-pressed={section} onClick={() => setSection(!section)}>Section {section ? "on" : "off"}</button><label className="cad-plane-elevation">Offset m<input aria-label="Working plane offset metres" type="number" step="0.1" value={Number((workingElevation - (level?.elevation ?? 0)).toFixed(6))} onChange={event => { const value = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(value) && Math.abs(value + (level?.elevation ?? 0)) < 1e6) { viewportApi?.cancelDrag(); setPreview(null); setPlane({ levelId: level?.id ?? "", offset: value }); } }} /></label><span className="cad-view-label">{level?.name ?? "Ground"} · Y {workingElevation.toFixed(2)} m absolute</span><button className="cad-icon-button" aria-label="Focus canvas" title="Hide both side panels and focus the canvas" onClick={() => { setLeftOpen(false); setRightOpen(false); viewportApi?.focus(); }}>Focus</button><button className="cad-icon-button" aria-label="Toggle properties inspector" onClick={() => { setRightOpen(!rightOpen); if (!rightOpen && window.innerWidth < 760) setLeftOpen(false); }}>☷</button></div>
      <Suspense fallback={<div className="cad-loading">Initializing geometry viewport…</div>}><CadViewport design={active} selectedId={selectedId} onSelect={id => { setSelectedId(id); if (id && window.innerWidth < 760) { setRightOpen(true); setLeftOpen(false); } }} onPreview={next => { setPreview(next); if (!next) setNumeric(""); }} onRequestNumericFocus={requestNumericFocus} onCommit={commit} tool={tool} discipline={discipline} levelId={level?.id} workingElevation={workingElevation} displayMode={displayMode} projection={projection} snapEnabled={snap} gridM={grid} symmetric={symmetric} readOnly={!writable} onStatus={setStatus} onApiReady={setViewportApi} onPlace={place} highlightedIds={highlightedIds} activeSystem={activeSystem} sectionElevation={section ? workingElevation + 1.5 : null} /></Suspense>
      <div className="cad-viewport-note">{selected ? `${LABELS[cadKind(selected)] ?? selected.kind} · ${selected.label ?? selected.id.slice(0, 8)}` : "No object selected"}{selected ? <span>Face grips resize · opposite face fixed</span> : <><span className="cad-mouse-help">Left click select · right drag orbit · middle drag pan · wheel zoom</span><span className="cad-touch-help">Tap select · two fingers pan / pinch zoom · view cube for orientation</span></>}</div>
      {(tool !== "select" || preview) && <div className="cad-dynamic-entry"><label>{tool === "rotate" ? "Rotation °" : "Exact value"} <input ref={attachNumericInput} aria-label="Exact operation measurement" type="number" step="any" value={numeric} placeholder={units} onChange={e => { setNumeric(e.target.value); const value = Number(e.target.value) / (tool === "rotate" ? 1 : factor(units)); if (e.target.value && Number.isFinite(value)) viewportApi?.setDragValue(value); }} onKeyDown={event => {
        if (event.key === "Enter") { viewportApi?.commitDrag(); setNumeric(""); }
        else if (event.key === "Escape") { viewportApi?.cancelDrag(); setPreview(null); }
        else return;
        event.stopPropagation();
        viewportApi?.focus();
      }} /></label><span>{tool === "rotate" ? "degrees" : units} · Enter accept · Esc cancel</span></div>}
    </main>
    <aside className="cad-inspector" aria-label="Contextual inspector"><div className="cad-panel-title"><strong>PROPERTIES & SYSTEMS</strong><button aria-label="Collapse properties" onClick={() => setRightOpen(false)}>›</button></div><nav className="cad-inspector-tabs">{([['properties','Object'],['systems','Systems'],['analysis','Analysis'],['issues',`Issues ${issues.length}`]] as const).map(([id,label]) => <button key={id} className={inspector === id ? "active" : ""} onClick={() => setInspector(id)}>{label}</button>)}</nav>
      {inspector === "properties" && (selected && resolved ? <div className="cad-inspector-content"><div className="cad-object-heading"><span>{LABELS[cadKind(selected)] ?? selected.kind}</span><small>{selected.id}</small></div><label className="cad-field">Object name<input key={`${selected.id}-${selected.label}`} defaultValue={selected.label ?? ""} onBlur={e => { if (e.target.value !== (selected.label ?? "")) modify({ label: e.target.value }); }} disabled={!writable || selected.locked} /></label>
        <div className="cad-group"><h3>Dimensions</h3><label className="cad-check"><input type="checkbox" checked={symmetric} onChange={e => setSymmetric(e.target.checked)} />Symmetric resize about center</label><NumberField label={selected.kind === "wall" ? "Length" : selected.kind === "beam" ? "Span" : cadKind(selected) === "circular-column" ? "Diameter" : "Width"} value={resolved.width} unit={units} onCommit={n => resize("x", n)} disabled={!writable || selected.locked} />{cadKind(selected) !== "circular-column" && <NumberField label={selected.kind === "wall" ? "Thickness" : "Depth"} value={resolved.depth} unit={units} onCommit={n => resize("z", n)} disabled={!writable || selected.locked} />}<NumberField label={["slab", "roof"].includes(selected.kind) ? "Thickness" : "Height"} value={resolved.height} unit={units} onCommit={n => resize("y", n)} disabled={!writable || selected.locked} /></div>
        <div className="cad-group"><h3>Position & orientation</h3><div className="cad-field-pair"><NumberField label="X" value={selected.x} unit={units} onCommit={x => modify({ x })} disabled={!writable || selected.locked} /><NumberField label="Z" value={selected.z} unit={units} onCommit={z => modify({ z })} disabled={!writable || selected.locked} /></div><NumberField label="Base elevation" value={resolved.elevation} unit={units} onCommit={value => modify({ elevationM: value, family: { ...selected.family, instanceParameters: { ...selected.family?.instanceParameters, baseOffset: selected.family?.levelId ? value - (levels.find(item => item.id === selected.family?.levelId)?.elevation ?? 0) : 0 } } })} disabled={!writable || selected.locked} /><NumberField label="Rotation" value={selected.rotationDeg} unit={units} angle onCommit={rotationDeg => modify({ rotationDeg })} disabled={!writable || selected.locked} /><label className="cad-field">Material<input key={`${selected.id}-${selected.material}`} defaultValue={selected.material ?? ""} placeholder="Unassigned" onBlur={e => { if (e.target.value !== (selected.material ?? "")) modify({ material: e.target.value }); }} disabled={!writable || selected.locked} /></label><label className="cad-field">Level<select value={selected.family?.levelId ?? ""} disabled={!writable || selected.locked} onChange={e => modify({ family: { ...selected.family, levelId: e.target.value || undefined } })}><option value="">Unhosted elevation</option>{levels.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
        {["slab", "roof"].includes(selected.kind) && <FootprintEditor object={selected} width={resolved.width} depth={resolved.depth} units={units} disabled={!writable || selected.locked === true} onModify={modify} />}
        {selected.kind === "wall" && <div className="cad-group"><h3>Wall openings</h3>{selected.openings?.map(opening => <div key={opening.id} className="cad-opening"><strong>{opening.kind}</strong><NumberField label="Opening width" value={opening.widthM} unit={units} onCommit={widthM => modify({ openings: selected.openings?.map(item => item.id === opening.id ? { ...item, widthM } : item) })} disabled={!writable || selected.locked} /><NumberField label="Opening height" value={opening.heightM} unit={units} onCommit={heightM => modify({ openings: selected.openings?.map(item => item.id === opening.id ? { ...item, heightM } : item) })} disabled={!writable || selected.locked} /><NumberField label="Opening offset" value={opening.offsetM} unit={units} onCommit={offsetM => modify({ openings: selected.openings?.map(item => item.id === opening.id ? { ...item, offsetM } : item) })} disabled={!writable || selected.locked} /><NumberField label="Sill" value={opening.sillM} unit={units} onCommit={sillM => modify({ openings: selected.openings?.map(item => item.id === opening.id ? { ...item, sillM } : item) })} disabled={!writable || selected.locked} /><button className="cad-button" onClick={() => modify({ openings: selected.openings?.filter(item => item.id !== opening.id) })} disabled={!writable || selected.locked}>Remove opening</button></div>)}<button className="cad-button" disabled={!writable || selected.locked} onClick={() => modify({ openings: [...selected.openings ?? [], { id: crypto.randomUUID(), kind: "door", offsetM: 0, widthM: Math.min(.9, resolved.width * .5), heightM: Math.min(2.1, resolved.height * .8), sillM: 0 }] }, "Explicit wall opening added")}>+ Rectangular opening</button></div>}
        <p className="cad-muted">Dimensions are semantic parameters in metres. Display-unit changes preserve physical size. Numeric edits and grips use the same validated command path.</p></div> : <div className="cad-group"><h3>Select an element</h3><p className="cad-muted">Click geometry or its model row. Selection reveals local face grips and exact dimensional properties.</p><p className="cad-muted">Create tools place elements on the active working plane.</p></div>)}
      {inspector === "analysis" && <CadAnalysisPanel design={design} selected={selected} readOnly={!writable} onRecord={recordAnalysis} />}
      {inspector === "systems" && activeSystem && <Suspense fallback={<p className="cad-muted">Loading system authoring…</p>}><CadSystemsPanel design={design} onCommand={commit} selectedId={selectedId} onSelect={setSelectedId} discipline={discipline} levelId={level?.id} levelName={level?.name} elevation={workingElevation} readOnly={!writable} onTrace={setHighlightedIds} system={activeSystem!} onSystemChange={setPreferredSystem} /></Suspense>}
      {inspector === "systems" && !activeSystem && <div className="cad-group"><h3>Choose a system discipline</h3><p className="cad-muted">Electrical and plumbing authoring use their own tools and compatible connectors. Architecture stays visible as context.</p>{(["electrical", "plumbing", "coordination"] as const).map(id => <button className="cad-button" key={id} onClick={() => { viewportApi?.cancelDrag(); setPreview(null); setSelectedId(null); setHighlightedIds([]); setTool("select"); setDiscipline(id); }}>{DISCIPLINES.find(([key]) => key === id)?.[1]}</button>)}</div>}
      {inspector === "issues" && <div><CadCoordinationPanel design={design} readOnly={!writable} onRecord={recordAnalysis} onFocus={ids => { setSelectedId(ids[0] ?? null); setHighlightedIds(ids); setTimeout(() => viewportApi?.fit(true), 0); }} /><div className="cad-group"><h3>Approximate envelope review</h3><p className="cad-muted">Envelope warnings are approximate. No structural cuts or penetrations are applied automatically. MEP port and continuity issues are listed under Systems.</p>{issues.length ? issues.map((issue, index) => <button className="cad-issue cad-linked-issue" key={`${issue.id}-${index}`} onClick={() => { setSelectedId(issue.id); setTimeout(() => viewportApi?.fit(true), 0); }}>{issue.text}<small>Focus object →</small></button>) : <p className="cad-muted">No object-envelope warnings in this authored subset.</p>}</div></div>}
    </aside>
    <footer className="cad-statusbar" data-history-version={historyVersion}><span className="cad-command-state">{tool.startsWith("place:") ? "PLACE" : tool.toUpperCase()}</span><span className="cad-guidance" role="status" aria-live="polite">{status}</span><label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} />Snap</label><label>Grid <select aria-label="Snap grid increment metres" value={grid} onChange={e => setGrid(Number(e.target.value))}><option value={.001}>1 mm</option><option value={.01}>10 mm</option><option value={.1}>100 mm</option><option value={.5}>500 mm</option><option value={1}>1 m</option></select></label><label>Units <select aria-label="Display units" value={units} onChange={e => setUnits(e.target.value as Unit)}><option value="m">m</option><option value="mm">mm</option><option value="ft">ft</option></select></label><span>{discipline} · {discipline === "electrical" || discipline === "plumbing" ? (activeSystem ? CAD_SYSTEM_LABELS[activeSystem] : "") + " · " : ""}{level?.name ?? "Ground"}</span></footer>
  </div>;
}
