import { useEffect, useMemo, useRef, useState } from "react";
import type { AirportDesign, AssistantPlan, DamDesign, DraftElement, HighwayDesign, InfraDesign, InfraFacility, InfraKind, PortDesign, SiteLocation } from "../types";
import { Button, Modal, Select, Toggle } from "../components/ui";
import { ParametricControls } from "../components/ParametricControls";
import { CadToolPalette, type CadTool } from "../components/CadToolPalette";
import { InfraScene } from "../editor/InfraScene";
import { SiteLocator, type LocatorMode } from "../editor/SiteLocator";
import { infraAtSite } from "../lib/siteLocation";
import { useToast } from "../components/Toast";
import { requestAssistantPlan } from "../api";
import { DesignAssistantPanel, type AssistantMessage } from "../components/DesignAssistantPanel";
import { VisualizationControls } from "../components/VisualizationControls";
import { cn } from "../lib/cn";
import { MepPanel } from "../components/MepPanel";
import { DesignExportMenu } from "../components/DesignExportMenu";
import { SectionControls } from "../components/SectionControls";
import { TerrainControls } from "../components/TerrainControls";
import { CivilControls } from "../components/CivilControls";
import { download } from "../lib/download";
import { buildBoqCsv, boqFilename, copyToClipboard, notesFilename, shareText } from "../lib/notes";
import { reviewMarkers, reviewRiskScore } from "../lib/review";
import { useReviewFindings } from "../lib/useReviewFindings";
import { ReviewAnalysisState } from "../components/ReviewAnalysisState";
import { CoordinationPanel } from "../components/CoordinationPanel";
import { applyDraftOperation, constrainedDraftPatch, duplicateDraftArray, patchDraftGrip } from "../lib/drafting";
import { syncDraftFamilyParameters } from "../lib/parametric";
import {
  INFRA_LABELS,
  buildInfraNotesText,
  computeInfraTakeoff,
  infraSummary,
  infraExtent,
} from "../lib/infra";
import { applyInfrastructureAssistantActions, isInfrastructureActionPreviewOnly, previewInfrastructureAssistantActions } from "../lib/assistant";
import { visualizationSettings } from "../lib/visualization";
import type { PresentationApi } from "../lib/presentation";

type StepId = "location" | "design" | "takeoff" | "review";

const STEPS: { id: StepId; label: string }[] = [
  { id: "location", label: "Site & alignment" },
  { id: "design", label: "Design" },
  { id: "takeoff", label: "Takeoff & notes" },
  { id: "review", label: "Review" },
];

const FACILITY_OPTIONS: Record<InfraKind, { kind: string; label: string }[]> = {
  highway: [
    { kind: "rest-area", label: "Rest area" },
    { kind: "toll-plaza", label: "Toll plaza" },
    { kind: "service-station", label: "Service station" },
    { kind: "pedestrian-overpass", label: "Pedestrian overpass" },
    { kind: "bus-bay", label: "Bus bay" },
  ],
  airport: [
    { kind: "passenger-lounge", label: "Passenger lounge" },
    { kind: "terminal", label: "Terminal" },
    { kind: "runway", label: "Runway" },
    { kind: "taxiway", label: "Taxiway" },
    { kind: "aircraft-stand", label: "Aircraft stand" },
    { kind: "cargo-terminal", label: "Cargo terminal" },
    { kind: "fuel-farm", label: "Fuel farm" },
  ],
  ports: [
    { kind: "berth", label: "Berth" },
    { kind: "warehouse", label: "Storage warehouse" },
    { kind: "container-yard", label: "Container yard" },
    { kind: "crane", label: "Quay crane" },
    { kind: "customs-terminal", label: "Customs terminal" },
    { kind: "cold-storage", label: "Cold storage" },
    { kind: "breakwater", label: "Breakwater" },
  ],
  dams: [
    { kind: "spillway", label: "Spillway" },
    { kind: "radial-gate", label: "Radial gate" },
    { kind: "powerhouse", label: "Powerhouse" },
    { kind: "fish-ladder", label: "Fish ladder" },
    { kind: "visitor-center", label: "Visitor center" },
    { kind: "stilling-basin", label: "Stilling basin" },
  ],
};

const INFRA_LAYERS = [
  { id: "model", name: "Engineering model", color: "#d6a84a" },
  { id: "facilities", name: "Facilities", color: "#7fb6c9" },
  { id: "drafting", name: "Drafting geometry", color: "#e5bd67" },
  { id: "mep", name: "MEP coordination", color: "#f59e0b" },
] as const;

const LOCATOR_MODE: Record<InfraKind, LocatorMode> = {
  highway: "route",
  airport: "area",
  ports: "area",
  dams: "route",
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);

interface InfraEditorProps {
  kind: InfraKind;
  infra: InfraDesign;
  onChange: (infra: InfraDesign) => void;
  initialStep?: StepId;
  projectName?: string;
  design?: import("../types").Design;
  onVisualizationChange?: (design: import("../types").Design) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">{title}</p>
      {children}
    </div>
  );
}

function Num({
  label, value, onChange, min, max, step, unit,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ""));

  useEffect(() => {
    setDraft(Number.isFinite(value) ? String(value) : "");
  }, [value]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-slate-300">{label}</label>
        <span className="text-xs text-slate-500">{draft ? `${draft}${unit ?? ""}` : "Enter a value"}</span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw !== "") onChange(Number(raw));
        }}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
      />
    </div>
  );
}

export function InfraEditor({ kind, infra, onChange, projectName, design, onVisualizationChange, initialStep }: InfraEditorProps) {
  const toast = useToast();
  const [step, setStep] = useState<StepId>(initialStep ?? "location");
  const [facilityKind, setFacilityKind] = useState(FACILITY_OPTIONS[kind][0].kind);
  const [activeTool, setActiveTool] = useState<CadTool>("select");
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const historyRef = useRef<{ past: InfraDesign[]; future: InfraDesign[] }>({ past: [], future: [] });

  const [presentationApi, setPresentationApi] = useState<PresentationApi | null>(null);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([]);
  const [assistantPlan, setAssistantPlan] = useState<AssistantPlan | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantPreviewOpen, setAssistantPreviewOpen] = useState(false);
  const visualization = visualizationSettings(design?.visualization);
  const phaseOptions = visualization.phases.slice(0, 1000);

  useEffect(() => {
    setFacilityKind(FACILITY_OPTIONS[kind][0].kind);
  }, [kind]);

  const commitInfra = (next: InfraDesign) => {
    historyRef.current.past = [...historyRef.current.past.slice(-49), infra];
    historyRef.current.future = [];
    onChange(next);
  };
  const update = (patch: Partial<InfraDesign>) => commitInfra({ ...infra, ...patch });
  const undo = () => {
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.unshift(infra);
    onChange(previous);
  };
  const redo = () => {
    const next = historyRef.current.future.shift();
    if (!next) return;
    historyRef.current.past.push(infra);
    onChange(next);
  };
  const layers = infra.layers ?? INFRA_LAYERS.map((layer) => ({ ...layer, visible: true }));
  const toggleLayer = (id: string) => update({ layers: layers.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer) });

  const takeoff = useMemo(() => computeInfraTakeoff(infra), [infra]);
  const assistantPreviews = useMemo(() => assistantPlan ? previewInfrastructureAssistantActions(assistantPlan.actions, infra) : [], [assistantPlan, infra]);

  const patchHighway = (patch: Partial<HighwayDesign>) =>
    update({ highway: { ...infra.highway!, ...patch } });
  const patchAirport = (patch: Partial<AirportDesign>) =>
    update({ airport: { ...infra.airport!, ...patch } });
  const patchPort = (patch: Partial<PortDesign>) =>
    update({ ports: { ...infra.ports!, ...patch } });
  const patchDam = (patch: Partial<DamDesign>) =>
    update({ dams: { ...infra.dams!, ...patch } });

  const addFacility = () => {
    const facility: InfraFacility = {
      id: `facility-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: facilityKind,
      count: 1,
      lengthM: kind === "airport" && facilityKind === "runway" ? 1200 : 30,
      widthM: kind === "airport" && facilityKind === "runway" ? 45 : 15,
      heightM: kind === "dams" ? 8 : 4,
    };
    update({ facilities: [...(infra.facilities ?? []), facility] });
  };

  const patchFacility = (id: string, patch: Partial<InfraFacility>) =>
    update({ facilities: (infra.facilities ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const requestPlan = async (message: string) => {
    setAssistantMessages((items) => [...items, { role: "user", text: message }]);
    setAssistantBusy(true);
    try {
      const response = await requestAssistantPlan({ message, context: { projectName, kind, infra } });
      setAssistantPlan(response.plan);
      setAssistantMessages((items) => [...items, { role: "assistant", text: response.assistantMessage }]);
    } catch (error) {
      setAssistantMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? error.message : "Could not request an assistant plan." }]);
    } finally {
      setAssistantBusy(false);
    }
  };

  const confirmAssistantPlan = () => {
    if (!assistantPlan) return;
    const result = applyInfrastructureAssistantActions(assistantPlan.actions, infra);
    if (!result.applied.length) {
      toast.push({ title: "Nothing applicable", description: "The proposed actions failed infrastructure validation.", tone: "error" });
      return;
    }
    commitInfra(result.infra);
    setAssistantPreviewOpen(false);
    toast.push({ title: "Assistant actions applied", description: `${result.applied.length} infrastructure update${result.applied.length === 1 ? "" : "s"}. Review the generated model before professional use.`, tone: "success" });
  };

  const selectedDraft = (infra.drafts ?? []).find((draft) => draft.id === selectedId);
  const reviewAnalysis = useReviewFindings("infra", infra);
  const reviewFindings = reviewAnalysis.findings;
  const reviewReady = reviewAnalysis.status === "ready" || reviewAnalysis.status === "fallback-ready";
  const markers = reviewMarkers(infra.review);

  const patchDraft = (id: string, patch: Partial<DraftElement>) =>
    update({ drafts: (infra.drafts ?? []).map((draft) => draft.id === id ? { ...draft, ...syncDraftFamilyParameters(draft, constrainedDraftPatch(draft, patch, infra.drafts ?? [])) } : draft) });

  const operateDraft = (operation: "trim" | "extend" | "offset" | "rotate" | "mirror") => {
    if (selectedDraft) patchDraft(selectedDraft.id, applyDraftOperation(selectedDraft, operation));
  };

  const arrayDraft = () => {
    if (!selectedDraft) return;
    const copies = duplicateDraftArray(selectedDraft);
    update({ drafts: [...(infra.drafts ?? []), ...copies.slice(1)] });
    setSelectedId(copies[copies.length - 1].id);
  };

  const draftingPanel = (
    <Section title="Civil site drafting">
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        Draw a line or dimension on the generated site for a working alignment, grade note, or contour reference. Select it with the canvas and edit its measured values here.
      </p>
      {selectedDraft ? (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold capitalize text-slate-200">{selectedDraft.civilKind ?? selectedDraft.kind}</p>
            <button onClick={() => { update({ drafts: (infra.drafts ?? []).filter((draft) => draft.id !== selectedDraft.id) }); setSelectedId(null); }} className="text-xs font-semibold text-rose-400">Remove</button>
          </div>
           <Select label="Construction phase" value={selectedDraft.phaseId ?? ""} onChange={(e) => patchDraft(selectedDraft.id, { phaseId: e.target.value || undefined })}>
             <option value="">Unassigned / always visible</option>
             {selectedDraft.phaseId && !phaseOptions.some((phase) => phase.id === selectedDraft.phaseId) && <option value={selectedDraft.phaseId}>Missing or outside selection limit ({selectedDraft.phaseId})</option>}
             {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
           </Select>
           <Select label="Annotation" value={selectedDraft.civilKind ?? "contour"} onChange={(e) => patchDraft(selectedDraft.id, { civilKind: e.target.value as DraftElement["civilKind"] })}>
            <option value="contour">Contour reference</option>
            <option value="alignment">Alignment</option>
            <option value="grade">Grade annotation</option>
           </Select>
           <ParametricControls
             family={selectedDraft.family}
             locks={selectedDraft.locks}
             constraints={selectedDraft.constraints}
             targets={(infra.drafts ?? []).filter((draft) => draft.id !== selectedDraft.id).map((draft) => ({ id: draft.id, label: draft.family?.instance || draft.label || `${draft.kind} ${draft.id.slice(-4)}` }))}
              onChange={(patch) => patchDraft(selectedDraft.id, patch)}
            />
           <div className="grid grid-cols-3 gap-1.5">
             {(["trim", "extend", "offset", "rotate", "mirror"] as const).map((operation) => <Button key={operation} size="sm" variant="secondary" onClick={() => operateDraft(operation)}>{operation[0].toUpperCase() + operation.slice(1)}</Button>)}
             <Button size="sm" variant="secondary" onClick={arrayDraft}>Array x3</Button>
           </div>
           <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2">
             <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-amber-300">Editable grips</p>
             <div className="grid grid-cols-4 gap-1.5">
               <Button size="sm" variant="secondary" onClick={() => patchDraft(selectedDraft.id, patchDraftGrip(selectedDraft, "width-start", 0.5))}>W-</Button>
               <Button size="sm" variant="secondary" onClick={() => patchDraft(selectedDraft.id, patchDraftGrip(selectedDraft, "width-end", 0.5))}>W+</Button>
               <Button size="sm" variant="secondary" onClick={() => patchDraft(selectedDraft.id, patchDraftGrip(selectedDraft, "depth-start", 0.5))}>D-</Button>
               <Button size="sm" variant="secondary" onClick={() => patchDraft(selectedDraft.id, patchDraftGrip(selectedDraft, "depth-end", 0.5))}>D+</Button>
             </div>
           </div>
          <div className="grid grid-cols-2 gap-2">
            <Num label="X" value={selectedDraft.x} onChange={(v) => patchDraft(selectedDraft.id, { x: v })} step={1} unit=" m" />
            <Num label="Z" value={selectedDraft.z} onChange={(v) => patchDraft(selectedDraft.id, { z: v })} step={1} unit=" m" />
            <Num label="Length" value={selectedDraft.w} onChange={(v) => patchDraft(selectedDraft.id, { w: Math.max(v || 0.5, 0.5) })} min={0.5} step={1} unit=" m" />
            <Num label="Elevation" value={selectedDraft.elevationM ?? 0} onChange={(v) => patchDraft(selectedDraft.id, { elevationM: v })} step={0.1} unit=" m" />
            <Num label="Grade" value={selectedDraft.gradePct ?? 0} onChange={(v) => patchDraft(selectedDraft.id, { gradePct: v })} step={0.1} unit=" %" />
            <Num label="Rotation" value={selectedDraft.rotationDeg} onChange={(v) => patchDraft(selectedDraft.id, { rotationDeg: v })} step={1} unit=" °" />
          </div>
        </div>
      ) : <p className="text-xs text-slate-600">No civil annotation selected.</p>}
    </Section>
  );

  const facilitiesPanel = (
    <Section title={`${INFRA_LABELS[kind]} facilities`}>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        Add only the facilities required by this design. Nothing is placed automatically.
      </p>
      <div className="flex gap-2">
        <Select label="Facility" value={facilityKind} onChange={(e) => setFacilityKind(e.target.value)}>
          {FACILITY_OPTIONS[kind].map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
        </Select>
        <Button size="sm" onClick={addFacility} className="mt-6 shrink-0">Add</Button>
      </div>
      <div className="space-y-2">
        {(infra.facilities ?? []).length === 0 && <p className="text-xs text-slate-600">No facilities added yet.</p>}
        {(infra.facilities ?? []).map((facility) => (
          <div key={facility.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <Select label="Type" value={facility.kind} onChange={(e) => patchFacility(facility.id, { kind: e.target.value })}>
                {FACILITY_OPTIONS[kind].map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
              </Select>
              <button onClick={() => update({ facilities: (infra.facilities ?? []).filter((f) => f.id !== facility.id) })} className="mt-5 text-xs font-semibold text-rose-400 hover:text-rose-300">Remove</button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Select label="Construction phase" value={facility.phaseId ?? ""} onChange={(e) => patchFacility(facility.id, { phaseId: e.target.value || undefined })}>
                <option value="">Unassigned / always visible</option>
                {facility.phaseId && !phaseOptions.some((phase) => phase.id === facility.phaseId) && <option value={facility.phaseId}>Missing or outside selection limit ({facility.phaseId})</option>}
                {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
              </Select>
              <Num label="Count" value={facility.count} onChange={(v) => patchFacility(facility.id, { count: Math.max(Math.round(v) || 0, 0) })} min={0} step={1} unit=" nos" />
              <Num label="Length" value={facility.lengthM} onChange={(v) => patchFacility(facility.id, { lengthM: Math.max(v || 0.5, 0.5) })} min={0.5} step={1} unit=" m" />
              <Num label="Width" value={facility.widthM} onChange={(v) => patchFacility(facility.id, { widthM: Math.max(v || 0.5, 0.5) })} min={0.5} step={1} unit=" m" />
              <Num label="Height" value={facility.heightM} onChange={(v) => patchFacility(facility.id, { heightM: Math.max(v || 0.2, 0.2) })} min={0.2} step={0.5} unit=" m" />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );

  /* ------------------------------ Location step ----------------------------- */
  const applyFromLocation = (loc: SiteLocation | undefined = infra.location) => {
    if (!loc) return;
    const next = infraAtSite(infra, loc);
    commitInfra(next);
    if (kind === "airport") {
      const span = Math.max(loc.boundaryWidthM ?? 0, loc.boundaryDepthM ?? 0);
      if (span > 200) {
        toast.push({ title: "Preliminary runway dimensions set", description: `${next.airport!.runwayLengthM} m runway · axis bearing ${next.airport!.runwayHeadingDeg}° from north`, tone: "success" });
      } else {
        toast.push({ title: "Enter site dimensions over 200 m to fit the runway", tone: "info" });
      }
    } else if (kind === "ports") {
      const area = (loc.boundaryWidthM ?? 0) * (loc.boundaryDepthM ?? 0);
      if (area > 5000) {
        toast.push({ title: "Yard & berths fitted", description: `${clamp(Math.round(area * 0.45), 20000, 800000).toLocaleString()} m² yard`, tone: "success" });
      } else {
        toast.push({ title: "Enter site dimensions covering over 5,000 m² to fit the yard", tone: "info" });
      }
    } else if (kind === "dams") {
      const route = loc.routeLengthM ?? 0;
      if (route > 40) {
        toast.push({ title: "Crest length applied", description: `${clamp(Math.round(route), 60, 2000)} m from the entered axis`, tone: "success" });
      } else {
        toast.push({ title: "Enter a dam-axis length over 40 m first", tone: "info" });
      }
    } else {
      toast.push({ title: "Route drives the model", description: loc.routeLengthM ? `${Math.round(loc.routeLengthM)} m entered` : "Enter the measured alignment length", tone: "info" });
    }
  };

  const applyLabel =
    kind === "airport" ? "Fit runway to boundary"
      : kind === "ports" ? "Fit yard & berths"
        : kind === "dams" ? "Use axis as crest length"
          : "Route length in use";

  const locationPanel = (
    <Section title="Where will it be built?">
      <TerrainControls value={infra.terrain} width={infraExtent(infra).w} depth={infraExtent(infra).d} onChange={(terrain) => update({ terrain })} />
      <CivilControls value={infra} onChange={(civil) => update({ civil })} />
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        {kind === "highway"
          ? "Enter the corridor coordinates, measured length and bearing to set the local model reference. Map imagery is not loaded."
          : kind === "dams"
            ? "Enter the site coordinates and measured dam-axis length. The entered axis can set the preliminary crest length. Map imagery is not loaded."
            : kind === "airport"
              ? "Enter site coordinates and measured dimensions or boundary corners. The generated airport follows its runway axis bearing, clockwise from local north (0° north, 90° east). Terrain and authored annotations keep their coordinates. Map imagery is not loaded."
              : "Enter the site coordinates and measured dimensions or boundary corners to size the preliminary works. Map imagery is not loaded."}
      </p>
      <SiteLocator
        location={infra.location}
        mode={LOCATOR_MODE[kind]}
        onChange={(loc) => loc ? applyFromLocation(loc) : update({ location: undefined })}
      />
      <Button size="sm" variant="secondary" onClick={() => applyFromLocation()} disabled={!infra.location}>
        {applyLabel}
      </Button>
    </Section>
  );

  /* ------------------------------- Design step ------------------------------ */
  const h = infra.highway!;
  const a = infra.airport!;
  const p = infra.ports!;
  const d = infra.dams!;

  const designPanel =
    kind === "highway" ? (
      <Section title="Highway & roadways">
        <div className="grid grid-cols-2 gap-3">
          <Num label="Lanes" value={h.lanes} onChange={(v) => patchHighway({ lanes: clamp(Math.round(v) || 2, 2, 12) })} min={2} max={12} step={2} unit=" no" />
          <Num label="Lane width" value={h.laneWidthM} onChange={(v) => patchHighway({ laneWidthM: clamp(v || 3.5, 2.5, 4.5) })} min={2.5} max={4.5} step={0.1} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Median" value={h.medianM} onChange={(v) => patchHighway({ medianM: clamp(v || 0, 0, 20) })} min={0} max={20} step={0.5} unit=" m" />
          <Num label="Shoulder" value={h.shoulderM} onChange={(v) => patchHighway({ shoulderM: clamp(v || 0, 0, 5) })} min={0} max={5} step={0.25} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Design speed" value={h.designSpeedKph} onChange={(v) => patchHighway({ designSpeedKph: clamp(Math.round(v) || 60, 40, 140) })} min={40} max={140} step={10} unit=" km/h" />
          <Num label="Cross slope" value={h.crossSlopePct} onChange={(v) => patchHighway({ crossSlopePct: clamp(v || 2, 1, 4) })} min={1} max={4} step={0.5} unit=" %" />
        </div>
        <Select label="Surface" value={h.surface} onChange={(e) => patchHighway({ surface: e.target.value as HighwayDesign["surface"] })}>
          <option value="bituminous">Bituminous (flexible)</option>
          <option value="concrete">Concrete (rigid)</option>
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Pavement thickness" value={h.pavementThicknessMm} onChange={(v) => patchHighway({ pavementThicknessMm: clamp(Math.round(v) || 550, 300, 900) })} min={300} max={900} step={25} unit=" mm" />
          <Num label="Embankment height" value={h.embankmentHeightM} onChange={(v) => patchHighway({ embankmentHeightM: clamp(v || 0, 0, 20) })} min={0} max={20} step={0.5} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Culverts" value={h.culverts} onChange={(v) => patchHighway({ culverts: clamp(Math.round(v) || 0, 0, 40) })} min={0} max={40} step={1} unit=" nos" />
          <Num label="Interchanges" value={h.interchanges} onChange={(v) => patchHighway({ interchanges: clamp(Math.round(v) || 0, 0, 10) })} min={0} max={10} step={1} unit=" nos" />
        </div>
        <Num label="Terrain roughness" value={h.terrainRoughnessM} onChange={(v) => patchHighway({ terrainRoughnessM: clamp(v || 0, 0, 8) })} min={0} max={8} step={0.5} unit=" m" />
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">{infraSummary(infra)}</p>
      </Section>
    ) : kind === "airport" ? (
      <Section title="Airport">
        <div className="grid grid-cols-2 gap-3">
          <Num label="Runways" value={a.runways} onChange={(v) => patchAirport({ runways: clamp(Math.round(v) || 1, 1, 4) })} min={1} max={4} step={1} unit=" no" />
          <Select label="Aerodrome code" value={a.aerodromeCode} onChange={(e) => patchAirport({ aerodromeCode: e.target.value as AirportDesign["aerodromeCode"] })}>
            <option value="4F">4F — A380 / B747-8</option>
            <option value="4E">4E — B747 / A340</option>
            <option value="4C">4C — A320 / B737</option>
            <option value="3C">3C — regional</option>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Runway length" value={a.runwayLengthM} onChange={(v) => patchAirport({ runwayLengthM: clamp(Math.round(v) || 1200, 800, 5000) })} min={800} max={5000} step={50} unit=" m" />
          <Num label="Runway width" value={a.runwayWidthM} onChange={(v) => patchAirport({ runwayWidthM: clamp(Math.round(v) || 45, 23, 60) })} min={23} max={60} step={1} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Runway axis bearing" value={a.runwayHeadingDeg} onChange={(v) => patchAirport({ runwayHeadingDeg: clamp(Math.round(v) || 0, 0, 179) })} min={0} max={179} step={1} unit=" ° from north" />
          <Num label="Taxiways" value={a.taxiways} onChange={(v) => patchAirport({ taxiways: clamp(Math.round(v) || 1, 1, 8) })} min={1} max={8} step={1} unit=" no" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Apron depth" value={a.apronDepthM} onChange={(v) => patchAirport({ apronDepthM: clamp(Math.round(v) || 120, 60, 500) })} min={60} max={500} step={10} unit=" m" />
          <Num label="Stands" value={a.stands} onChange={(v) => patchAirport({ stands: clamp(Math.round(v) || 0, 0, 80) })} min={0} max={80} step={1} unit=" nos" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Terminal area" value={a.terminalAreaM2} onChange={(v) => patchAirport({ terminalAreaM2: clamp(Math.round(v) || 2000, 1000, 200000) })} min={1000} max={200000} step={500} unit=" m²" />
          <Num label="Elevation" value={a.elevationM} onChange={(v) => patchAirport({ elevationM: clamp(Math.round(v) || 0, 0, 4000) })} min={0} max={4000} step={10} unit=" m" />
        </div>
        <Toggle checked={a.fuelFarm} onChange={(v) => patchAirport({ fuelFarm: v })} label="Aviation fuel farm" />
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">{infraSummary(infra)}</p>
      </Section>
    ) : kind === "ports" ? (
      <Section title="Ports & harbours">
        <div className="grid grid-cols-2 gap-3">
          <Num label="Berths" value={p.berths} onChange={(v) => patchPort({ berths: clamp(Math.round(v) || 1, 1, 16) })} min={1} max={16} step={1} unit=" no" />
          <Num label="Berth length" value={p.berthLengthM} onChange={(v) => patchPort({ berthLengthM: clamp(Math.round(v) || 100, 80, 500) })} min={80} max={500} step={10} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Design draft" value={p.draftM} onChange={(v) => patchPort({ draftM: clamp(v || 8, 4, 25) })} min={4} max={25} step={0.5} unit=" m" />
          <Num label="Channel depth" value={p.channelDepthM} onChange={(v) => patchPort({ channelDepthM: clamp(v || 10, 5, 28) })} min={5} max={28} step={0.5} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Quay width" value={p.quayWidthM} onChange={(v) => patchPort({ quayWidthM: clamp(Math.round(v) || 30, 15, 120) })} min={15} max={120} step={5} unit=" m" />
          <Num label="Breakwater" value={p.breakwaterLengthM} onChange={(v) => patchPort({ breakwaterLengthM: clamp(Math.round(v) || 0, 0, 3000) })} min={0} max={3000} step={50} unit=" m" />
        </div>
        <Select label="Quay type" value={p.quayType} onChange={(e) => patchPort({ quayType: e.target.value as PortDesign["quayType"] })}>
          <option value="open-piled">Open-piled deck</option>
          <option value="solid">Solid quay wall</option>
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Container yard" value={p.containerYardM2} onChange={(v) => patchPort({ containerYardM2: clamp(Math.round(v) || 10000, 5000, 1500000) })} min={5000} max={1500000} step={5000} unit=" m²" />
          <Num label="STS cranes" value={p.cranes} onChange={(v) => patchPort({ cranes: clamp(Math.round(v) || 0, 0, 16) })} min={0} max={16} step={1} unit=" nos" />
        </div>
        <Num label="Warehouses" value={p.warehouses} onChange={(v) => patchPort({ warehouses: clamp(Math.round(v) || 0, 0, 12) })} min={0} max={12} step={1} unit=" nos" />
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">{infraSummary(infra)}</p>
      </Section>
    ) : (
      <Section title="Dams & spillways">
        <Select label="Dam type" value={d.damType} onChange={(e) => patchDam({ damType: e.target.value as DamDesign["damType"] })}>
          <option value="gravity">Concrete gravity</option>
          <option value="earthen">Earthen embankment</option>
          <option value="rockfill">Rockfill</option>
          <option value="arch">Arch</option>
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Height" value={d.heightM} onChange={(v) => patchDam({ heightM: clamp(v || 5, 5, 300) })} min={5} max={300} step={5} unit=" m" />
          <Num label="Crest length" value={d.crestLengthM} onChange={(v) => patchDam({ crestLengthM: clamp(Math.round(v) || 40, 40, 3000) })} min={40} max={3000} step={10} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Crest width" value={d.crestWidthM} onChange={(v) => patchDam({ crestWidthM: clamp(v || 3, 3, 30) })} min={3} max={30} step={0.5} unit=" m" />
          <Num label="Freeboard" value={d.freeboardM} onChange={(v) => patchDam({ freeboardM: clamp(v || 0, 0, 10) })} min={0} max={10} step={0.5} unit=" m" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Upstream slope" value={d.upstreamSlope} onChange={(v) => patchDam({ upstreamSlope: clamp(v || 0, 0, 3) })} min={0} max={3} step={0.05} unit=" H:1V" />
          <Num label="Downstream slope" value={d.downstreamSlope} onChange={(v) => patchDam({ downstreamSlope: clamp(v || 0, 0, 3) })} min={0} max={3} step={0.05} unit=" H:1V" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Reservoir area" value={d.reservoirAreaM2} onChange={(v) => patchDam({ reservoirAreaM2: clamp(Math.round(v) || 10000, 10000, 60000000) })} min={10000} max={60000000} step={10000} unit=" m²" />
          <Num label="Grout curtain" value={d.groutCurtainDepthM} onChange={(v) => patchDam({ groutCurtainDepthM: clamp(Math.round(v) || 0, 0, 120) })} min={0} max={120} step={5} unit=" m" />
        </div>
        <Select label="Spillway type" value={d.spillwayType} onChange={(e) => patchDam({ spillwayType: e.target.value as DamDesign["spillwayType"] })}>
          <option value="ogee">Ogee / overflow</option>
          <option value="chute">Chute</option>
          <option value="siphon">Siphon</option>
          <option value="morning-glory">Morning glory</option>
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Spillway capacity" value={d.spillwayCapacityCumec} onChange={(v) => patchDam({ spillwayCapacityCumec: clamp(Math.round(v) || 100, 100, 50000) })} min={100} max={50000} step={100} unit=" cumec" />
          <Num label="Radial gates" value={d.spillwayGates} onChange={(v) => patchDam({ spillwayGates: clamp(Math.round(v) || 1, 1, 12) })} min={1} max={12} step={1} unit=" nos" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Gate width" value={d.gateWidthM} onChange={(v) => patchDam({ gateWidthM: clamp(v || 1, 1, 30) })} min={1} max={30} step={0.5} unit=" m" />
          <Num label="Gate height" value={d.gateHeightM} onChange={(v) => patchDam({ gateHeightM: clamp(v || 1, 1, 25) })} min={1} max={25} step={0.5} unit=" m" />
        </div>
        <Toggle checked={d.stillingBasin} onChange={(v) => patchDam({ stillingBasin: v })} label="Stilling basin" />
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">{infraSummary(infra)}</p>
      </Section>
    );

  const modelActionPanel = (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Parametric model</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        {infra.modelReady === false
          ? "The canvas is intentionally empty. Adjust the design values, add facilities, then generate the model when you are ready."
          : "The model is generated from the current parameters. You can return to an empty canvas and rebuild it at any time."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => update({ modelReady: true })}>
          {infra.modelReady === false ? "Generate model" : "Regenerate model"}
        </Button>
        {infra.modelReady !== false && <Button size="sm" variant="secondary" onClick={() => update({ modelReady: false })}>Return to empty canvas</Button>}
      </div>
    </div>
  );

  /* ------------------------------ Takeoff step ------------------------------ */
  const exportNotes = async (how: "download" | "copy" | "share") => {
    const text = buildInfraNotesText({ projectName: projectName || "Untitled project", infra });
    if (how === "download") {
      download(notesFilename(projectName || "project"), text, "text/plain;charset=utf-8");
      toast.push({ title: "Brief downloaded", description: "Open in Notepad, Notes or any editor.", tone: "success" });
      return;
    }
    if (how === "copy") {
      const ok = await copyToClipboard(text);
      toast.push({ title: ok ? "Copied to clipboard" : "Copy failed", tone: ok ? "success" : "error" });
      return;
    }
    const ok = await shareText(projectName || "Project brief", text);
    if (!ok) {
      const copied = await copyToClipboard(text);
      toast.push({ title: copied ? "Copied instead" : "Sharing unavailable", tone: "info" });
    }
  };

  const exportBoq = () => {
    download(boqFilename(projectName || "project"), buildBoqCsv(takeoff.items), "text/csv;charset=utf-8");
    toast.push({ title: "BOQ downloaded", description: "Planning quantities exported as CSV.", tone: "success" });
  };

  const takeoffPanel = (
    <Section title="Material takeoff & notes">
      <div className="grid grid-cols-2 gap-2">
        {takeoff.summary.map((s) => (
          <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
            <p className="text-[11px] text-slate-500">{s.label}</p>
            <p className="text-sm font-semibold text-slate-200">{s.value}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void exportNotes("download")}>Download .txt</Button>
        <Button size="sm" variant="secondary" onClick={exportBoq}>Download BOQ .csv</Button>
        <Button size="sm" variant="secondary" onClick={() => void exportNotes("copy")}>Copy for notes</Button>
        <Button size="sm" variant="secondary" onClick={() => void exportNotes("share")}>Share</Button>
      </div>
      <div className="space-y-3">
        {takeoff.groups.map((grp) => (
          <div key={grp.group}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{grp.group}</p>
            <div className="space-y-1">
              {grp.items.map((item) => (
                <div key={item.key} className="flex items-baseline justify-between gap-2 rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-1.5">
                  <span className="text-xs text-slate-300">{item.label}</span>
                  <span className="shrink-0 text-xs font-semibold text-emerald-300">
                    {item.qty.toLocaleString()} {item.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[11px] leading-relaxed text-slate-500">
        Quantities follow conventional practice and standard work-item norms — verify against detailed design
        drawings and a certified BOQ before procurement.
      </p>
    </Section>
  );

  const reviewPanel = (
    <Section title="Coordination review">
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
         Site-fit, vertical-envelope, clearance, MEP-to-facility, and approximate structure checks. Scores are screening priorities, not code compliance.
      </p>
      <div className="space-y-2">
         <p className="text-xs font-semibold text-slate-300">Automatic checks {reviewReady ? `(${reviewFindings.length}) · risk ${reviewRiskScore(reviewFindings)}/100` : "awaiting results"}</p>
        <ReviewAnalysisState status={reviewAnalysis.status} error={reviewAnalysis.error} retry={reviewAnalysis.retry} runFallback={reviewAnalysis.runFallback} />
        {reviewReady && reviewFindings.length === 0 && <p className="text-xs text-emerald-300">No basic site-fit clashes detected.</p>}
         {reviewFindings.map((finding) => <button key={finding.id} onClick={() => setSelectedId(finding.targetIds[0])} className="block w-full rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-200"><span className="font-semibold">{finding.severity} · {finding.score}/100</span> · {finding.category} · {finding.text}<span className="mt-1 block text-[10px] text-amber-300/70">Approximation: {finding.approximation}</span></button>)}
      </div>
      <CoordinationPanel markers={markers} findings={reviewReady ? reviewFindings : []} onChange={(next) => update({ review: { markers: next } })}
        modelIds={[...(infra.facilities ?? []), ...(infra.drafts ?? []), ...(infra.mep?.elements ?? [])].map(item => item.id)} selectedId={selectedId} selectedPosition={selectedDraft}
        onSelect={setSelectedId} presentationApi={presentationApi} projectName={projectName} />
    </Section>
  );

  const mepPanel = <Section title="MEP coordination"><MepPanel value={infra.mep} phases={visualization.phases} onChange={(mep) => update({ mep })} /></Section>;

  const panels: Record<StepId, React.ReactNode> = {
    location: <>{locationPanel}{draftingPanel}</>,
    design: <>{modelActionPanel}{designPanel}{facilitiesPanel}{draftingPanel}{mepPanel}</>,
    takeoff: takeoffPanel,
    review: reviewPanel,
  };

  const activeIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="gw-sheet-toolbar relative mb-2 mt-2 flex min-h-10 items-center gap-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/80 px-2 py-1.5 backdrop-blur">
         <span className="hidden px-2 text-[10px] font-bold uppercase tracking-[.16em] text-slate-500 sm:inline">CAD tools</span>
         {design && <DesignExportMenu design={design} projectName={projectName} onChange={(next) => onChange(next.infra ?? infra)} />}
         <CadToolPalette active={activeTool} onChange={(tool) => { setActiveTool(tool); if (selectedDraft && ["trim", "extend", "offset", "rotate", "mirror"].includes(tool)) operateDraft(tool as "trim" | "extend" | "offset" | "rotate" | "mirror"); if (selectedDraft && tool === "array") arrayDraft(); }} compact tools={["select", "move", "measure", "rotate", "offset", "trim", "extend", "mirror", "array", "line", "rectangle", "circle", "dimension"]} />
        <Button variant="ghost" size="sm" onClick={() => setLayersOpen((open) => !open)}>Layers</Button>
        <Button variant="ghost" size="sm" onClick={undo} disabled={historyRef.current.past.length === 0}>Undo</Button>
        <Button variant="ghost" size="sm" onClick={redo} disabled={historyRef.current.future.length === 0}>Redo</Button>
        {layersOpen && (
          <div className="absolute right-2 top-12 z-30 w-56 rounded-xl border border-slate-700 bg-slate-900/95 p-2 shadow-2xl backdrop-blur">
            <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">Layer visibility</p>
            {layers.map((layer) => (
              <button key={layer.id} onClick={() => toggleLayer(layer.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-300 hover:bg-slate-800">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: layer.color }} />
                <span className="flex-1">{layer.name}</span>
                <span className={layer.visible ? "text-emerald-300" : "text-slate-600"}>{layer.visible ? "ON" : "OFF"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
         <div className="flex w-full shrink-0 flex-col border-r border-slate-800 bg-slate-900/40 lg:w-96">
          <div className="flex gap-1 overflow-x-auto border-b border-slate-800 px-3 py-2">
            {STEPS.map((s, i) => (
               <button
                key={s.id}
                onClick={() => setStep(s.id)}
                aria-current={step === s.id ? "step" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition",
                  step === s.id ? "bg-emerald-500/15 text-emerald-300" : "text-slate-500 hover:bg-slate-800",
                )}
              >
                <span className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                  i < activeIndex ? "bg-emerald-500/30 text-emerald-300" : i === activeIndex ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-400",
                )}>{i + 1}</span>
                {s.label}
              </button>
            ))}
          </div>
           <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"><SectionControls value={infra.section} onChange={(section) => update({ section })} />{panels[step]}</div>
        </div>

        <div className="relative min-h-[420px] flex-1">
           <InfraScene infra={infra} activeTool={activeTool} onSelect={setSelectedId} onChange={commitInfra} visualization={visualization} onPresentationReady={setPresentationApi} />
           {design && <div className="pointer-events-auto absolute bottom-3 left-3 z-10"><VisualizationControls design={design} presentationApi={presentationApi} onChange={(next) => onVisualizationChange?.(next)} /></div>}
           <div className="pointer-events-none absolute left-3 top-3 rounded-xl bg-slate-950/80 px-3 py-2 text-xs text-slate-300 backdrop-blur">
             {INFRA_LABELS[kind]} · {infra.section?.enabled ? `Section ${infra.section.axis.toUpperCase()} / ${infra.section.depth} m` : "Full model"}
          </div>
           <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-xl bg-slate-950/85 px-3 py-2 text-xs text-emerald-300 backdrop-blur">
             {infraSummary(infra)}
           </div>
           <div className="pointer-events-auto absolute bottom-3 right-3 z-20">
             <DesignAssistantPanel messages={assistantMessages} onCommand={(message) => void requestPlan(message)} plan={assistantPlan} busy={assistantBusy} previews={assistantPreviews} onPreview={() => setAssistantPreviewOpen(true)} onApply={() => setAssistantPreviewOpen(true)} />
           </div>
           <Modal open={assistantPreviewOpen} onClose={() => setAssistantPreviewOpen(false)} title="Assistant action preview" wide>
             <div className="space-y-3">
               <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">Confirm only the bounded infrastructure parameter, facility, and model-generation updates you intend to make. Structural, MEP, and analysis suggestions remain preview-only.</p>
               <div className="max-h-[50vh] space-y-2 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3">
                 {assistantPreviews.map((item, index) => <div key={`${item.action.type}-${index}`} className="rounded-lg border border-slate-800 px-3 py-2 text-xs"><p className={item.applicable ? "text-emerald-300" : "text-amber-300"}>{item.applicable ? "Ready to apply" : "Preview only / not applied"}</p><p className="mt-1 text-slate-300">{item.label}</p>{item.reason && <p className="mt-1 text-slate-500">{item.reason}</p>}</div>)}
               </div>
               <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setAssistantPreviewOpen(false)}>Cancel</Button><Button onClick={confirmAssistantPlan} disabled={!assistantPreviews.some((item) => item.applicable) || assistantPreviews.some((item) => !item.applicable && !isInfrastructureActionPreviewOnly(item.action))}>Confirm and apply</Button></div>
             </div>
           </Modal>
         </div>
      </div>
    </div>
  );
}

