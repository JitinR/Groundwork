import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AmenityData,
  BuildingLevel,
  BuildingBranch,
  CommercialStyle,
  CommunityDesign,
  DraftElement,
  DoorFacing,
  ExteriorPanel,
  InteriorRoom,
  TowerData,
  TowerOpening,
  ResidentialStyle,
  UnitSystem,
} from "../types";
import { Badge, Button, Input, Modal, Select, Toggle } from "../components/ui";
import { ParametricControls } from "../components/ParametricControls";
import { CadToolPalette, type CadTool } from "../components/CadToolPalette";
import { CommunityScene, type SceneContextTarget } from "../editor/CommunityScene";
import { RoomEditor } from "../editor/RoomEditor";
import { SiteLocator } from "../editor/SiteLocator";
import { type BoundaryMetrics } from "../lib/geo";
import { communityAtSite } from "../lib/siteLocation";
import { useToast } from "../components/Toast";
import { cn } from "../lib/cn";
import { SectionControls } from "../components/SectionControls";
import { TerrainControls } from "../components/TerrainControls";
import { uid } from "../lib/modelcore";
import { catalogEntry } from "../lib/catalog";
import { download } from "../lib/download";
import { computeTakeoff } from "../lib/takeoff";
import { buildBoqCsv, buildNotesText, boqFilename, copyToClipboard, notesFilename, shareText } from "../lib/notes";
import { reviewMarkers, reviewRiskScore } from "../lib/review";
import { useReviewFindings } from "../lib/useReviewFindings";
import { ReviewAnalysisState } from "../components/ReviewAnalysisState";
import { CoordinationPanel } from "../components/CoordinationPanel";
import { StructuralResultsPanel } from "../components/StructuralResultsPanel";
import { applyDraftOperation, constrainedDraftSize, duplicateDraftArray, draftingSettings, patchDraftGrip, solveDraftConstraintGraph } from "../lib/drafting";
import { familyForId, familyMetadata } from "../lib/families";
import { analyzeCommunity, buildStructuralReport, structuralSettings } from "../lib/structural";
import { buildStructuralSolverExchange, screenStructuralDesign } from "../lib/structuralEngine";
import { describeObject, furnitureDimMm, parseObjectQuery } from "../lib/objects";
import { MepPanel } from "../components/MepPanel";
import { DesignExportMenu } from "../components/DesignExportMenu";
import { DesignAssistantPanel, type AssistantMessage } from "../components/DesignAssistantPanel";
import { VisualizationControls } from "../components/VisualizationControls";
import { requestAssistantPlan } from "../api";
import { applyCommunityAssistantActions, isAssistantActionPreviewOnly, previewAssistantActions } from "../lib/assistant";
import type { AssistantPlan } from "../types";
import { visualizationSettings } from "../lib/visualization";
import type { PresentationApi } from "../lib/presentation";
import {
  AMENITIES,
  DOOR_FACING_LABELS,
  FACADES,
  INTERIOR_TYPES,
  UNIT_LABELS,
  amenityKind,
  amenitiesFor,
  defaultUnderground,
  interiorLabel,
  landAreaSqYards,
  landMeters,
  levelsForDesign,
  makeAmenity,
  makeRoom,
  towerMeters,
} from "../lib/community";

type StepId = "land" | "parking" | "basement" | "levels" | "drafting" | "analysis" | "amenities" | "towers" | "exterior" | "interiors" | "mep" | "takeoff" | "review";

const COMMUNITY_LAYERS = [
  { id: "buildings", name: "Buildings", color: "#d6a84a" },
  { id: "site", name: "Site features", color: "#7fb6c9" },
  { id: "drafting", name: "Drafting geometry", color: "#e5bd67" },
  { id: "interiors", name: "Interior room plans", color: "#5eead4" },
  { id: "mep", name: "MEP coordination", color: "#f59e0b" },
] as const;

const STEPS: { id: StepId; label: string }[] = [
  { id: "land", label: "Land" },
  { id: "parking", label: "Parking" },
  { id: "basement", label: "Basement" },
  { id: "levels", label: "Levels & grid" },
  { id: "drafting", label: "Drafting & structure" },
  { id: "analysis", label: "Preliminary analysis" },
  { id: "amenities", label: "Amenities" },
  { id: "towers", label: "Towers & floors" },
  { id: "exterior", label: "Exterior" },
  { id: "interiors", label: "Interiors" },
  { id: "mep", label: "MEP coordination" },
  { id: "takeoff", label: "Takeoff & notes" },
  { id: "review", label: "Review" },
];

interface CommunityEditorProps {
  branch: BuildingBranch;
  community: CommunityDesign;
  onChange: (c: CommunityDesign) => void;
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
  label, value, onChange, min, max, step, unit, disabled,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string; disabled?: boolean;
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
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw !== "") onChange(Number(raw));
        }}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500 disabled:opacity-50"
      />
    </div>
  );
}

function UndergroundForm({
  park, update,
}: {
  park: CommunityDesign["parking"];
  update: (patch: Partial<CommunityDesign>) => void;
}) {
  const ug = park.underground ?? defaultUnderground();
  const setUg = (patch: Partial<typeof ug>) => update({ parking: { ...park, underground: { ...ug, ...patch } } });
  const total = ug.levels * ug.floorHeight + ug.foundationDepth;
  return (
    <>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        The site will be excavated below the tower footprint. Choose the number & height of basement levels and the excavation depth. The dig happens after you confirm these numbers.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Basement floors" value={ug.levels} onChange={(v) => setUg({ levels: Math.max(Math.round(v) || 1, 1) })} min={1} step={1} unit=" lvl" />
        <Num label="Clear height / floor" value={ug.floorHeight} onChange={(v) => setUg({ floorHeight: Math.max(v || 2.4, 2.4) })} min={2.4} step={0.1} unit=" m" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num
          label="Parking Breadth (Width)"
          value={ug.parkingWidthM ?? 36}
          onChange={(v) => {
            const width = Math.max(v || 10, 6);
            const cols = Math.max(1, Math.floor((width - 4) / ((ug.bayWidth || 2.5) + 0.5)));
            setUg({ parkingWidthM: width, bayCols: cols });
          }}
          min={6}
          step={1}
          unit=" m"
        />
        <Num
          label="Parking Length (Depth)"
          value={ug.parkingLengthM ?? 28}
          onChange={(v) => {
            const length = Math.max(v || 10, 6);
            const rows = Math.max(1, Math.floor((length - 6) / ((ug.bayLength || 5) + 2.0)));
            setUg({ parkingLengthM: length, bayRows: rows });
          }}
          min={6}
          step={1}
          unit=" m"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Foundation depth" value={ug.foundationDepth} onChange={(v) => setUg({ foundationDepth: Math.max(v || 0.5, 0.5) })} min={0.5} step={0.1} unit=" m" />
        <Num label="Total dig depth" value={total} onChange={() => {}} disabled unit=" m" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Ramp width" value={ug.rampWidth} onChange={(v) => setUg({ rampWidth: Math.max(v || 2.5, 2.5) })} min={2.5} step={0.25} unit=" m" />
        <Num label="Ramp length" value={ug.rampLength} onChange={(v) => setUg({ rampLength: Math.max(v || 8, 8) })} min={8} step={1} unit=" m" />
      </div>
      <Num label="Ramp slope" value={ug.rampSlope} onChange={(v) => setUg({ rampSlope: Math.max(v || 2, 2) })} min={2} step={0.5} unit=" %" />
    </>
  );
}

export function CommunityEditor({ branch, community, onChange, projectName, design, onVisualizationChange, initialStep }: CommunityEditorProps) {
  const toast = useToast();
  const [step, setStep] = useState<StepId>(initialStep ?? "land");
  const [focusMode, setFocusMode] = useState(false);
  const [focusPanelOpen, setFocusPanelOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<CadTool>("select");
  const [layersOpen, setLayersOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [pickKind, setPickKind] = useState(() => amenitiesFor(branch)[0]?.kind ?? AMENITIES[0].kind);
  const [newRoomType, setNewRoomType] = useState("living");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<SceneContextTarget | null>(null);
  const [gen, setGen] = useState<{ mode: "site" | "room"; roomId?: string; x: number; z: number; text: string } | null>(null);
  const [furnishRoomId, setFurnishRoomId] = useState<string | null>(null);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([]);
  const [assistantPlan, setAssistantPlan] = useState<AssistantPlan | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantPreviewOpen, setAssistantPreviewOpen] = useState(false);

  const [presentationApi, setPresentationApi] = useState<PresentationApi | null>(null);
  const c = community;
  const visualization = visualizationSettings(design?.visualization);
  const phaseOptions = visualization.phases.slice(0, 1000);
  const levels = levelsForDesign(c);
  const activeLevelId = c.activeLevelId && levels.some((level) => level.id === c.activeLevelId) ? c.activeLevelId : levels[0]?.id;
  const historyRef = useRef<{ past: CommunityDesign[]; future: CommunityDesign[] }>({ past: [], future: [] });

  useEffect(() => {
    const available = amenitiesFor(branch, c.commercialStyle);
    if (!available.some((a) => a.kind === pickKind)) setPickKind(available[0]?.kind ?? AMENITIES[0].kind);
  }, [branch, c.commercialStyle, pickKind]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFocusMode(document.fullscreenElement === workspaceRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFocusMode = async () => {
    if (document.fullscreenElement === workspaceRef.current) {
      await document.exitFullscreen?.();
      setFocusPanelOpen(false);
      return;
    }
    try {
      await workspaceRef.current?.requestFullscreen?.();
    } catch {
      setFocusMode((value) => !value);
      setFocusPanelOpen(false);
    }
  };

  const takeoff = useMemo(() => computeTakeoff(c), [c]);
  const structuralAnalysis = useMemo(() => analyzeCommunity(c), [c]);
  const structuralDesign = useMemo(() => screenStructuralDesign(c), [c]);
  const assistantPreviews = useMemo(() => assistantPlan ? previewAssistantActions(assistantPlan.actions, c, branch) : [], [assistantPlan, c, branch]);

  const commitDesign = (next: CommunityDesign) => {
    historyRef.current.past = [...historyRef.current.past.slice(-49), c];
    historyRef.current.future = [];
    onChange(next);
  };

  const update = (patch: Partial<CommunityDesign>) => commitDesign({ ...c, ...patch });

  const layers = c.layers ?? COMMUNITY_LAYERS.map((layer) => ({ ...layer, visible: true }));
  const toggleLayer = (id: string) => update({ layers: layers.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer) });

  const undo = () => {
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.unshift(c);
    onChange(previous);
  };

  const redo = () => {
    const next = historyRef.current.future.shift();
    if (!next) return;
    historyRef.current.past.push(c);
    onChange(next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  const selectedTower = c.towers.find((t) => t.id === selectedId);
  const selectedAmenity = c.amenities.find((a) => a.id === selectedId);
  const selectedDraft = (c.drafts ?? []).find((d) => d.id === selectedId);
  const reviewAnalysis = useReviewFindings("community", c);
  const reviewFindings = reviewAnalysis.findings;
  const reviewReady = reviewAnalysis.status === "ready" || reviewAnalysis.status === "fallback-ready";
  const markers = reviewMarkers(c.review);

  const requestPlan = async (message: string) => {
    setAssistantMessages((items) => [...items, { role: "user", text: message }]);
    setAssistantBusy(true);
    try {
      const response = await requestAssistantPlan({ message, context: { projectName, branch, design: c } });
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
    const result = applyCommunityAssistantActions(assistantPlan.actions, c, branch);
    if (!result.applied.length) {
      toast.push({ title: "Nothing applicable", description: "The proposed actions could not be safely applied to this editor.", tone: "error" });
      return;
    }
    commitDesign(result.design);
    setStep(result.step ?? "land");
    setSelectedId(result.selectedId ?? null);
    setAssistantPreviewOpen(false);
    const previewOnly = result.skipped.filter((item) => isAssistantActionPreviewOnly(item.action)).length;
    toast.push({ title: "Assistant actions applied", description: `${result.applied.length} editor update${result.applied.length === 1 ? "" : "s"}${previewOnly ? `; ${previewOnly} preview-only action${previewOnly === 1 ? "" : "s"} remain unapplied` : ""}.`, tone: "success" });
  };

  const assistantHasInvalidActions = assistantPreviews.some((item) => !item.applicable && !isAssistantActionPreviewOnly(item.action));



  const addSiteObject = (recipe: ReturnType<typeof parseObjectQuery>, x: number, z: number) => {
    if (!recipe) return;
    const r = recipe.recipe;
    const count = recipe.qty;
    const added: AmenityData[] = [];
    for (let i = 0; i < count; i++) {
      const spread = (i - (count - 1) / 2) * 1.6;
      if (r.kind === "furniture") {
        const dim = furnitureDimMm(r.catalogId);
        added.push({
          id: uid("am"),
          kind: r.catalogId,
          label: r.name,
          color: catalogEntry(r.catalogId)?.defaultColor ?? "#90a4ae",
          shape: "box",
          x: Math.round((x + spread) * 10) / 10,
          z: Math.round(z * 10) / 10,
          rotY: 0,
          w: dim.w / 1000,
          d: dim.d / 1000,
          h: dim.h / 1000,
        });
      } else {
        added.push({
          id: uid("am"),
          kind: r.key,
          label: r.name,
          color: r.color,
          shape: r.shape,
          x: Math.round((x + spread) * 10) / 10,
          z: Math.round(z * 10) / 10,
          rotY: 0,
          w: r.w,
          d: r.d,
          h: r.h,
        });
      }
    }
    update({ amenities: [...c.amenities, ...added] });
    toast.push({ title: "Object added", description: describeObject(recipe), tone: "success" });
  };

  const runGenerator = () => {
    if (!gen) return;
    const parsed = parseObjectQuery(gen.text);
    if (!parsed) {
      toast.push({ title: "Not recognised", description: "Try words like sofa, tree, car, bench, fountain.", tone: "error" });
      return;
    }
    if (gen.mode === "room" && gen.roomId) {
      const room = c.interiors.find((r) => r.id === gen.roomId);
      if (!room) return;
      if (parsed.recipe.kind === "outdoor") {
        toast.push({ title: "Furniture only", description: "That looks like an outdoor object.", tone: "error" });
        return;
      }
      const catalogId = parsed.recipe.catalogId;
      const name = parsed.recipe.name;
      const color = catalogEntry(catalogId)?.defaultColor ?? "#90a4ae";
      const items = Array.from({ length: parsed.qty }).map((_, i) => ({
        id: uid("fu"),
        type: catalogId,
        name: parsed.qty > 1 ? `${name} ${i + 1}` : name,
        x: Math.round((gen.x + i * 0.5) * 10) / 10,
        z: Math.round(gen.z * 10) / 10,
        rotationDeg: 0,
        scale: 1,
        color,
      }));
      update({
        interiors: c.interiors.map((r) => (r.id === room.id ? { ...r, furniture: [...(r.furniture ?? []), ...items] } : r)),
      });
      toast.push({ title: "Furniture added", description: `${describeObject(parsed)} → ${room.name}`, tone: "success" });
    } else {
      addSiteObject(parsed, gen.x, gen.z);
    }
    setGen(null);
  };

  const applyFacadeToTower = (id: string, key: string) => {
    const opt = FACADES.find((f) => f.key === key);
    update({ towers: c.towers.map((t) => (t.id === id ? { ...t, facadeMaterial: key, facadeColor: opt?.color ?? t.facadeColor } : t)) });
  };

  const duplicateAmenity = (id: string) => {
    const a = c.amenities.find((x) => x.id === id);
    if (!a) return;
    update({ amenities: [...c.amenities, { ...a, id: uid("am"), x: a.x + 4, z: a.z + 4 }] });
  };

  const duplicateTower = (id: string) => {
    const t = c.towers.find((x) => x.id === id);
    if (!t) return;
    update({ towers: [...c.towers, { ...t, id: uid("tw"), label: `${t.label} (copy)`, x: t.x + 12, z: t.z }] });
  };

  /* ------------------------------- Land step ------------------------------- */
  const land = c.land;
  const terrainPanel = <TerrainControls value={c.terrain} width={landMeters(land).w} depth={landMeters(land).d} onChange={(terrain) => update({ terrain })} />;
  const landPanel = (
    <>
      {terrainPanel}
      <Section title="Plot size">
      <SiteLocator
        location={c.location}
        onChange={(loc, metrics) => commitDesign(communityAtSite(c, loc, metrics))}
        onApplyBoundary={(m: BoundaryMetrics) => {
          toast.push({ title: "Plot size applied", description: `${m.widthM} × ${m.depthM} m from boundary`, tone: "success" });
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Unit" value={land.unit} onChange={(e) => update({ land: { ...land, unit: e.target.value as UnitSystem } })}>
          {(Object.keys(UNIT_LABELS) as UnitSystem[]).map((u) => (
            <option key={u} value={u}>{UNIT_LABELS[u]}</option>
          ))}
        </Select>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
          <p className="text-slate-500">Plot area</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-200">
            {Math.round(landAreaSqYards(land)).toLocaleString()} sq yd
          </p>
          <p className="text-[11px] text-slate-500">
            ≈ {Math.round(landMeters(land).w * landMeters(land).d).toLocaleString()} m²
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Width" value={land.width} onChange={(v) => update({ land: { ...land, width: Math.max(v > 0 ? v : 1, 1) } })} min={1} step={0.5} unit={` ${UNIT_LABELS[land.unit]}`} />
        <Num label="Depth" value={land.depth} onChange={(v) => update({ land: { ...land, depth: Math.max(v > 0 ? v : 1, 1) } })} min={1} step={0.5} unit={` ${UNIT_LABELS[land.unit]}`} />
      </div>
      </Section>
    </>
  );

  /* ------------------------------ Parking step ----------------------------- */
  const park = c.parking;
  const parkPanel = (
    <Section title="Vehicle parking">
      <Select label="Parking type" value={park.mode} onChange={(e) => {
        const mode = e.target.value as typeof park.mode;
        update({ parking: { ...park, mode, underground: mode === "underground" && !park.underground ? defaultUnderground() : park.underground } });
      }}>
        <option value="none">No parking</option>
        <option value="surface">Surface parking</option>
        <option value="underground">Underground parking</option>
      </Select>
      {park.mode === "surface" && (
        <Num label="Surface bays" value={park.surfaceBays} onChange={(v) => update({ parking: { ...park, surfaceBays: Math.max(Math.round(v) || 0, 0) } })} min={0} step={1} unit=" bays" />
      )}
      {park.mode === "underground" && (
        <UndergroundForm park={park} update={update} />
      )}
    </Section>
  );

  /* ----------------------------- Basement step ------------------------------ */
  const ug = park.underground;
  const basementPanel = park.mode !== "underground" || !ug ? (
    <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
      Select <span className="text-emerald-300">Underground parking</span> in the previous step to build the basement structure.
    </p>
  ) : (
    <Section title="Basement structure (below grade)">
      <div className="grid grid-cols-2 gap-3">
        <Num
          label="Parking Breadth (Width)"
          value={ug.parkingWidthM ?? 36}
          onChange={(v) => {
            const width = Math.max(v || 10, 6);
            const cols = Math.max(1, Math.floor((width - 4) / ((ug.bayWidth || 2.5) + 0.5)));
            update({ parking: { ...park, underground: { ...ug, parkingWidthM: width, bayCols: cols } } });
          }}
          min={6}
          step={1}
          unit=" m"
        />
        <Num
          label="Parking Length (Depth)"
          value={ug.parkingLengthM ?? 28}
          onChange={(v) => {
            const length = Math.max(v || 10, 6);
            const rows = Math.max(1, Math.floor((length - 6) / ((ug.bayLength || 5) + 2.0)));
            update({ parking: { ...park, underground: { ...ug, parkingLengthM: length, bayRows: rows } } });
          }}
          min={6}
          step={1}
          unit=" m"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Pillar spacing X" value={ug.pillarSpacingX} onChange={(v) => update({ parking: { ...park, underground: { ...ug, pillarSpacingX: Math.max(v || 4, 4) } } })} min={4} step={0.5} unit=" m" />
        <Num label="Pillar spacing Z" value={ug.pillarSpacingZ} onChange={(v) => update({ parking: { ...park, underground: { ...ug, pillarSpacingZ: Math.max(v || 4, 4) } } })} min={4} step={0.5} unit=" m" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Car bay width" value={ug.bayWidth} onChange={(v) => update({ parking: { ...park, underground: { ...ug, bayWidth: Math.max(v || 2.3, 2.3) } } })} min={2.3} step={0.05} unit=" m" />
        <Num label="Car bay length" value={ug.bayLength} onChange={(v) => update({ parking: { ...park, underground: { ...ug, bayLength: Math.max(v || 4.8, 4.8) } } })} min={4.8} step={0.05} unit=" m" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Bay columns" value={ug.bayCols} onChange={(v) => update({ parking: { ...park, underground: { ...ug, bayCols: Math.max(Math.round(v) || 1, 1) } } })} min={1} step={1} unit="" />
        <Num label="Bay rows" value={ug.bayRows} onChange={(v) => update({ parking: { ...park, underground: { ...ug, bayRows: Math.max(Math.round(v) || 1, 1) } } })} min={1} step={1} unit="" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Toggle checked={ug.liftLobby} onChange={(v) => update({ parking: { ...park, underground: { ...ug, liftLobby: v } } })} label="Lift lobby" />
        <Toggle checked={ug.stairLobby} onChange={(v) => update({ parking: { ...park, underground: { ...ug, stairLobby: v } } })} label="Staircase lobby" />
      </div>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
        Capacity: up to <span className="text-emerald-300">{ug.bayCols * ug.bayRows * ug.levels}</span> cars across {ug.levels} level{ug.levels > 1 ? "s" : ""}.
      </p>
    </Section>
  );

  /* ----------------------------- Amenities step ----------------------------- */
  const nextSpot = (): { x: number; z: number } => {
    const { w: W, d: D } = landMeters(land);
    const n = c.amenities.length;
    const rowW = 12;
    const col = n % Math.max(1, Math.floor(Math.max(1, (W - 16)) / rowW));
    const rowNum = Math.floor(n / Math.max(1, Math.floor(Math.max(1, (W - 16)) / rowW)));
    return { x: -W / 2 + 10 + col * rowW, z: D / 2 - 8 - rowNum * 12 };
  };

  const addAmenity = () => {
    const spot = nextSpot();
    const a = makeAmenity(pickKind, spot.x, spot.z);
    update({ amenities: [...c.amenities, a] });
    toast.push({ title: "Amenity added", description: amenityKind(pickKind)?.label ?? pickKind, tone: "info" });
  };

  const patchAmenity = (id: string, patch: Partial<AmenityData>) =>
    update({ amenities: c.amenities.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  const patchDraft = (id: string, patch: Partial<DraftElement>) => {
    const drafts = c.drafts ?? [];
    update({ drafts: solveDraftConstraintGraph(drafts, id, patch) });
  };

  const operateDraft = (operation: "trim" | "extend" | "offset" | "rotate" | "mirror" | "fillet" | "chamfer") => {
    if (selectedDraft) patchDraft(selectedDraft.id, applyDraftOperation(selectedDraft, operation));
  };

  const arrayDraft = () => {
    if (!selectedDraft) return;
    const copies = duplicateDraftArray(selectedDraft);
    update({ drafts: [...(c.drafts ?? []), ...copies.slice(1)] });
    setSelectedId(copies[copies.length - 1].id);
  };

  const patchLevel = (id: string, patch: Partial<BuildingLevel>) =>
    update({ levels: levels.map((level) => (level.id === id ? { ...level, ...patch } : level)) });

  const levelsPanel = (
    <Section title="Levels & structural grid">
      <Select label="Floor plan level" value={activeLevelId ?? ""} onChange={(e) => update({ activeLevelId: e.target.value })}>
        {levels.map((level) => <option key={level.id} value={level.id}>{level.name} · {level.elevation.toFixed(2)} m</option>)}
      </Select>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        The selected level controls which room plans and grid elevation are shown in the scene. Tower floor numbers start at 0 for the ground floor.
      </p>
      <Button size="sm" onClick={() => {
        const index = levels.length;
        const level: BuildingLevel = { id: uid("lvl"), name: `Level ${index + 1}`, elevation: index * 3.2, floorHeight: 3.2 };
        update({ levels: [...levels, level], activeLevelId: level.id });
      }}>+ Add level</Button>
      <div className="space-y-2">
        {levels.map((level, index) => (
          <div key={level.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <Input label={`Level ${index + 1} name`} value={level.name} onChange={(e) => patchLevel(level.id, { name: e.target.value })} />
              {levels.length > 1 && <button onClick={() => update({ levels: levels.filter((item) => item.id !== level.id), activeLevelId: activeLevelId === level.id ? levels.find((item) => item.id !== level.id)?.id : activeLevelId })} className="mt-4 text-xs font-semibold text-rose-400">Remove</button>}
            </div>
             <div className="mt-2 grid grid-cols-2 gap-2">
              <Num label="Elevation" value={level.elevation} onChange={(v) => patchLevel(level.id, { elevation: v })} step={0.1} unit=" m" />
              <Num label="Floor height" value={level.floorHeight} onChange={(v) => patchLevel(level.id, { floorHeight: Math.max(v || 2.4, 2.4) })} step={0.1} unit=" m" />
            </div>
          </div>
        ))}
      </div>
      <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-emerald-400">Grid axes</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => update({ structuralGrid: [...(c.structuralGrid ?? []), { id: uid("grid"), axis: "x", label: `A${(c.structuralGrid?.length ?? 0) + 1}`, position: 0, extent: Math.max(landMeters(land).d, 20), color: "#38bdf8" }] })}>+ X axis</Button>
        <Button size="sm" variant="secondary" onClick={() => update({ structuralGrid: [...(c.structuralGrid ?? []), { id: uid("grid"), axis: "z", label: `${(c.structuralGrid?.length ?? 0) + 1}`, position: 0, extent: Math.max(landMeters(land).w, 20), color: "#fbbf24" }] })}>+ Z axis</Button>
      </div>
      {(c.structuralGrid ?? []).map((axis) => (
        <div key={axis.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-200">{axis.label} · {axis.axis.toUpperCase()} axis</p><button onClick={() => update({ structuralGrid: (c.structuralGrid ?? []).filter((item) => item.id !== axis.id) })} className="text-xs font-semibold text-rose-400">Remove</button></div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Input label="Label" value={axis.label} onChange={(e) => update({ structuralGrid: (c.structuralGrid ?? []).map((item) => item.id === axis.id ? { ...item, label: e.target.value } : item) })} />
            <Num label="Position" value={axis.position} onChange={(v) => update({ structuralGrid: (c.structuralGrid ?? []).map((item) => item.id === axis.id ? { ...item, position: v } : item) })} step={0.5} unit=" m" />
            <Num label="Extent" value={axis.extent} onChange={(v) => update({ structuralGrid: (c.structuralGrid ?? []).map((item) => item.id === axis.id ? { ...item, extent: Math.max(v || 1, 1) } : item) })} step={1} unit=" m" />
            <label className="block text-xs font-medium text-slate-400">Color<input type="color" value={axis.color} onChange={(e) => update({ structuralGrid: (c.structuralGrid ?? []).map((item) => item.id === axis.id ? { ...item, color: e.target.value } : item) })} className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-slate-700 bg-slate-900" /></label>
          </div>
        </div>
      ))}
    </Section>
  );

  const amenitiesPanel = (
    <Section title="Site features & amenities">
      {branch === "commercial" && (
        <p className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-relaxed text-slate-400">
          Office blocks use commercial amenities only. Hotels and resorts also unlock the full residential amenity catalog.
          Parking and basement structure are configured separately in their own steps.
        </p>
      )}
      <div className="flex gap-2">
        <div className="flex-1">
          <Select value={pickKind} onChange={(e) => setPickKind(e.target.value)}>
            {amenitiesFor(branch, c.commercialStyle).map((a) => (
              <option key={a.kind} value={a.kind}>{a.label}</option>
            ))}
          </Select>
        </div>
        <Button size="sm" onClick={addAmenity} className="shrink-0">Add</Button>
      </div>
      <div className="space-y-2">
        {c.amenities.length === 0 && <p className="text-xs text-slate-600">No amenities yet — add some above.</p>}
        {c.amenities.map((a) => (
          <div key={a.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-200">{amenityKind(a.kind)?.label ?? a.kind}</p>
              <button onClick={() => update({ amenities: c.amenities.filter((x) => x.id !== a.id) })} className="text-xs font-semibold text-rose-400 hover:text-rose-300">
                Remove
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Num label="X" value={a.x} onChange={(v) => patchAmenity(a.id, { x: v })} step={1} unit=" m" />
              <Num label="Z" value={a.z} onChange={(v) => patchAmenity(a.id, { z: v })} step={1} unit=" m" />
              <Num label="W" value={a.w} onChange={(v) => patchAmenity(a.id, { w: Math.max(v || 1, 1) })} step={0.5} unit=" m" />
              <Num label="D" value={a.d} onChange={(v) => patchAmenity(a.id, { d: Math.max(v || 1, 1) })} step={0.5} unit=" m" />
              <Num label="H" value={a.h} onChange={(v) => patchAmenity(a.id, { h: Math.max(v || 0.1, 0.1) })} min={0.1} step={0.1} unit=" m" />
            </div>
            <Select label="Construction phase" value={a.phaseId ?? ""} onChange={(e) => patchAmenity(a.id, { phaseId: e.target.value || undefined })}>
              <option value="">Unassigned / always visible</option>
              {a.phaseId && !phaseOptions.some((phase) => phase.id === a.phaseId) && <option value={a.phaseId}>Missing or outside selection limit ({a.phaseId})</option>}
              {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
            </Select>
          </div>
        ))}
      </div>
    </Section>
  );

  const draftingPanel = (
    <Section title="Drafting & structural elements">
      {(() => {
        const settings = draftingSettings(c.drafting);
        const setDrafting = (patch: Partial<typeof settings>) => update({ drafting: { ...settings, ...patch } });
        return (
          <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
            <div>
              <p className="text-sm font-semibold text-slate-200">Constraint phase</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">Snapping is bounded to nearby grid and alignment references. Existing draft data stays unchanged.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Num label="Grid size" value={settings.gridSize} onChange={(v) => setDrafting({ gridSize: Math.min(Math.max(v || 0.5, 0.1), 10) })} min={0.1} max={10} step={0.1} unit=" m" />
              <Select label="Angle snap" value={String(settings.angleIncrement)} onChange={(e) => setDrafting({ angleIncrement: Number(e.target.value) })}>
                <option value="0">Free angle</option><option value="5">5°</option><option value="15">15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Toggle checked={settings.gridVisible} onChange={(gridVisible) => setDrafting({ gridVisible })} label="Show grid" />
              <Toggle checked={settings.snapEnabled} onChange={(snapEnabled) => setDrafting({ snapEnabled })} label="Snap to grid" />
              <Toggle checked={settings.orthogonal} onChange={(orthogonal) => setDrafting({ orthogonal })} label="Orthogonal lines" />
              <Toggle checked={settings.alignment} onChange={(alignment) => setDrafting({ alignment })} label="Align nearby" />
            </div>
          </div>
        );
      })()}
      {selectedDraft ? (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold capitalize text-slate-200">{selectedDraft.kind}</p>
            <button onClick={() => update({ drafts: (c.drafts ?? []).filter((d) => d.id !== selectedDraft.id) })} className="text-xs font-semibold text-rose-400">Remove</button>
          </div>
           <Select label="Civil annotation" value={selectedDraft.civilKind ?? "contour"} onChange={(e) => patchDraft(selectedDraft.id, { civilKind: e.target.value as DraftElement["civilKind"] })}>
            <option value="contour">Contour reference</option>
            <option value="alignment">Alignment</option>
            <option value="grade">Grade annotation</option>
           </Select>
           <Select label="Construction phase" value={selectedDraft.phaseId ?? ""} onChange={(e) => patchDraft(selectedDraft.id, { phaseId: e.target.value || undefined })}>
             <option value="">Unassigned / always visible</option>
             {selectedDraft.phaseId && !phaseOptions.some((phase) => phase.id === selectedDraft.phaseId) && <option value={selectedDraft.phaseId}>Missing or outside selection limit ({selectedDraft.phaseId})</option>}
             {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
           </Select>
           <ParametricControls
             family={selectedDraft.family}
             locks={selectedDraft.locks}
             constraints={selectedDraft.constraints}
             targets={(c.drafts ?? []).filter((draft) => draft.id !== selectedDraft.id).map((draft) => ({ id: draft.id, label: draft.family?.instance || draft.label || `${draft.kind} ${draft.id.slice(-4)}` }))}
              onChange={(patch) => patchDraft(selectedDraft.id, patch)}
            />
           <div className="grid grid-cols-3 gap-1.5">
             {(["trim", "extend", "offset", "fillet", "chamfer", "rotate", "mirror"] as const).map((operation) => <Button key={operation} size="sm" variant="secondary" onClick={() => operateDraft(operation)}>{operation[0].toUpperCase() + operation.slice(1)}</Button>)}
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
            <Num label="X" value={selectedDraft.x} onChange={(v) => patchDraft(selectedDraft.id, { x: v })} step={0.5} unit=" m" />
            <Num label="Z" value={selectedDraft.z} onChange={(v) => patchDraft(selectedDraft.id, { z: v })} step={0.5} unit=" m" />
            <Num label="Width" value={selectedDraft.w} onChange={(v) => patchDraft(selectedDraft.id, { w: constrainedDraftSize(v, draftingSettings(c.drafting)) })} min={0.1} step={0.5} unit=" m" />
            <Num label="Depth" value={selectedDraft.d} onChange={(v) => patchDraft(selectedDraft.id, { d: constrainedDraftSize(v, draftingSettings(c.drafting)) })} min={0.1} step={0.5} unit=" m" />
            {(selectedDraft.kind === "wall" || selectedDraft.kind === "slab" || selectedDraft.kind === "column" || selectedDraft.kind === "roof") && <Num label="Height" value={selectedDraft.h ?? 0.2} onChange={(v) => patchDraft(selectedDraft.id, { h: Math.max(v || 0.05, 0.05) })} min={0.05} step={0.1} unit=" m" />}
            <Num label="Elevation" value={selectedDraft.elevationM ?? 0} onChange={(v) => patchDraft(selectedDraft.id, { elevationM: v })} step={0.1} unit=" m" />
            <Num label="Grade" value={selectedDraft.gradePct ?? 0} onChange={(v) => patchDraft(selectedDraft.id, { gradePct: v })} step={0.1} unit=" %" />
            <Num label="Rotation" value={selectedDraft.rotationDeg} onChange={(v) => patchDraft(selectedDraft.id, { rotationDeg: v })} step={15} unit=" °" />
          </div>
          <label className="block text-xs font-medium text-slate-400">Element color<input type="color" value={selectedDraft.color} onChange={(e) => patchDraft(selectedDraft.id, { color: e.target.value })} className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-slate-700 bg-slate-900" /></label>
        </div>
      ) : (
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs leading-relaxed text-slate-500">Choose a CAD/BIM tool from the toolbar (line, polyline, arc, spline, wall, slab, column, roof and more), then select the element to edit geometry and parametric relationships.</p>
      )}
    </Section>
  );

  const analysisPanel = (
    <Section title="Preliminary structural analysis">
       <div className="flex items-start justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"><p className="text-xs leading-relaxed text-amber-200">
         Planning-level estimates only. This is not certified engineering, a code check, or a substitute for a licensed structural engineer, geotechnical report, sealed drawings, or site-specific loads.
       </p><div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => { const blob = new Blob([buildStructuralReport(c)], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "preliminary-structural-report.txt"; link.click(); URL.revokeObjectURL(url); }}>Report</Button><Button size="sm" variant="outline" onClick={() => download("structural-analysis-model.json", buildStructuralSolverExchange(c, design?.engineeringBasis), "application/json")}>Solver model</Button></div></div>
      {(() => {
        const settings = structuralSettings(c.structural);
        const setStructural = (patch: Partial<typeof settings>) => update({ structural: { ...settings, ...patch } });
        return <>
          <Toggle checked={settings.enabled} onChange={(enabled) => setStructural({ enabled })} label="Enable screening estimates" />
          <div className="grid grid-cols-2 gap-2">
            <Num label="Dead load" value={settings.deadLoadKPa} onChange={(v) => setStructural({ deadLoadKPa: Math.max(v, 0) })} step={0.5} unit=" kPa" />
            <Num label="Live load" value={settings.liveLoadKPa} onChange={(v) => setStructural({ liveLoadKPa: Math.max(v, 0) })} step={0.5} unit=" kPa" />
            <Num label="Concrete strength" value={settings.concreteStrengthMPa} onChange={(v) => setStructural({ concreteStrengthMPa: Math.max(v, 10) })} step={1} unit=" MPa" />
            <Num label="Soil bearing input" value={settings.soilBearingKPa} onChange={(v) => setStructural({ soilBearingKPa: Math.max(v, 25) })} step={10} unit=" kPa" />
            <Num label="Column width" value={settings.columnWidthM} onChange={(v) => setStructural({ columnWidthM: Math.max(v, 0.15) })} step={0.05} unit=" m" />
            <Num label="Column depth" value={settings.columnDepthM} onChange={(v) => setStructural({ columnDepthM: Math.max(v, 0.15) })} step={0.05} unit=" m" />
            <Num label="Beam width" value={settings.beamWidthM} onChange={(v) => setStructural({ beamWidthM: Math.max(v, 0.15) })} step={0.05} unit=" m" />
            <Num label="Beam depth" value={settings.beamDepthM} onChange={(v) => setStructural({ beamDepthM: Math.max(v, 0.2) })} step={0.05} unit=" m" />
            <Num label="Footing width" value={settings.footingWidthM} onChange={(v) => setStructural({ footingWidthM: Math.max(v, 0.5) })} step={0.1} unit=" m" />
            <Num label="Footing depth" value={settings.footingDepthM} onChange={(v) => setStructural({ footingDepthM: Math.max(v, 0.5) })} step={0.1} unit=" m" />
            <Num label="Wind pressure" value={settings.windPressureKPa ?? 1} onChange={(v) => setStructural({ windPressureKPa: Math.max(v, 0) })} step={0.1} unit=" kPa" />
             <Num label="Seismic coefficient" value={settings.seismicCoefficient ?? 0.12} onChange={(v) => setStructural({ seismicCoefficient: Math.max(v, 0) })} step={0.01} unit=" g" />
             <Select label="Material" value={settings.material ?? "reinforced-concrete"} onChange={(e) => setStructural({ material: e.target.value as typeof settings.material })}><option value="reinforced-concrete">Reinforced concrete</option><option value="steel">Steel (screen inputs still RCC-based)</option><option value="masonry">Masonry (screen inputs still RCC-based)</option></Select>
             <Select label="Soil type" value={settings.soilType ?? "unknown"} onChange={(e) => setStructural({ soilType: e.target.value as typeof settings.soilType })}>{["unknown", "rock", "dense-sand", "stiff-soil", "soft-soil"].map((item) => <option key={item} value={item}>{item}</option>)}</Select>
             <Select label="Wind exposure" value={settings.windExposure ?? "unknown"} onChange={(e) => setStructural({ windExposure: e.target.value as typeof settings.windExposure })}>{["unknown", "urban", "open", "coastal"].map((item) => <option key={item} value={item}>{item}</option>)}</Select>
             <Select label="Seismic site class" value={settings.seismicSiteClass ?? "unknown"} onChange={(e) => setStructural({ seismicSiteClass: e.target.value as typeof settings.seismicSiteClass })}>{["unknown", "A", "B", "C", "D", "E", "F"].map((item) => <option key={item} value={item}>{item}</option>)}</Select>
             <Select label="Occupancy" value={settings.occupancyCategory ?? "unknown"} onChange={(e) => setStructural({ occupancyCategory: e.target.value as typeof settings.occupancyCategory })}>{["unknown", "residential", "commercial", "assembly", "essential"].map((item) => <option key={item} value={item}>{item}</option>)}</Select>
          </div>
          <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs font-semibold text-slate-300">Editable screening combinations</p>
            <p className="text-[11px] leading-relaxed text-slate-500">Factors are planning assumptions only. D = dead, L = live, W = wind, E = seismic.</p>
            {structuralAnalysis.loadCombinations.map((combination, index) => <div key={combination.id} className="grid grid-cols-[1.3fr_repeat(4,minmax(0,1fr))] gap-1.5">
              <Input aria-label={`${combination.label} label`} value={combination.label} onChange={(e) => setStructural({ loadCombinations: structuralAnalysis.loadCombinations.map((item, itemIndex) => itemIndex === index ? { ...item, label: e.target.value } : item) })} placeholder="Combination" />
              <Num label="D" value={combination.deadFactor} onChange={(v) => setStructural({ loadCombinations: structuralAnalysis.loadCombinations.map((item, itemIndex) => itemIndex === index ? { ...item, deadFactor: Math.max(v, 0) } : item) })} step={0.1} />
              <Num label="L" value={combination.liveFactor} onChange={(v) => setStructural({ loadCombinations: structuralAnalysis.loadCombinations.map((item, itemIndex) => itemIndex === index ? { ...item, liveFactor: Math.max(v, 0) } : item) })} step={0.1} />
              <Num label="W" value={combination.windFactor} onChange={(v) => setStructural({ loadCombinations: structuralAnalysis.loadCombinations.map((item, itemIndex) => itemIndex === index ? { ...item, windFactor: Math.max(v, 0) } : item) })} step={0.1} />
              <Num label="E" value={combination.seismicFactor} onChange={(v) => setStructural({ loadCombinations: structuralAnalysis.loadCombinations.map((item, itemIndex) => itemIndex === index ? { ...item, seismicFactor: Math.max(v, 0) } : item) })} step={0.1} />
            </div>)}
          </div>
        </>;
      })()}
      <div className="grid grid-cols-2 gap-2">
         {[['Total floor area', `${structuralAnalysis.totalAreaM2.toFixed(0)} m²`], ['Estimated gravity load', `${structuralAnalysis.totalLoadKN.toFixed(0)} kN`], ['Wind base shear screen', `${structuralAnalysis.totalWindBaseShearKN.toFixed(0)} kN`], ['Seismic base shear screen', `${structuralAnalysis.totalSeismicBaseShearKN.toFixed(0)} kN`]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2"><p className="text-[11px] text-slate-500">{label}</p><p className="text-sm font-semibold text-slate-200">{value}</p></div>)}
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-300">Analysis model / member screening</p><Badge tone={structuralDesign.governingUtilization <= 1 ? "emerald" : "amber"}>{(structuralDesign.governingUtilization * 100).toFixed(0)}% governing</Badge></div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400"><p>Nodes <strong className="text-slate-200">{structuralDesign.frame.nodes.length}</strong></p><p>Members <strong className="text-slate-200">{structuralDesign.frame.members.length}</strong></p><p>Foundation screens <strong className="text-slate-200">{structuralDesign.foundations.length}</strong></p><p>External solver <strong className="text-amber-300">{structuralDesign.verification.status}</strong></p></div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Exchange target adapters: {structuralDesign.verification.supportedTargets.join(", ")}. External solver verification is still required before engineering use.</p>
      </div>
      <div className="space-y-2">
        {structuralAnalysis.results.map((result) => <div key={result.tower.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <p className="text-sm font-semibold text-slate-200">{result.tower.label}</p>
           <p className="mt-1 text-xs text-slate-400">{result.areaM2.toFixed(1)} m² footprint · {(result.areaM2 * Math.max(result.tower.floors, 1)).toFixed(1)} m² floor area · {result.heightM.toFixed(1)} m high · {result.estimatedLoadKN.toFixed(0)} kN gravity load</p>
            <p className="mt-1 text-xs text-cyan-300">Governing screen: {result.governingCombination} at {result.governingLoadKN.toFixed(0)} kN · W {result.windBaseShearKN.toFixed(0)} kN · E {result.seismicBaseShearKN.toFixed(0)} kN</p>
            <p className="mt-1 text-xs text-slate-400">Drift proxy {(result.driftRatio * 100).toFixed(2)}% · slenderness {result.slendernessRatio.toFixed(0)}x · load path {result.loadPath.join(" > ")}</p>
           <div className="mt-2 space-y-1">{result.checks.map((check) => <p key={check.text} className={`text-xs ${check.status === "warning" ? "text-amber-300" : "text-emerald-300"}`}>{check.status === "warning" ? "Warning" : "Screened"}: {check.text}</p>)}</div>
           <p className="mt-2 text-[11px] leading-relaxed text-amber-300">Reinforcement: {result.reinforcementWarning}</p>
           {result.connectionWarnings.map((warning) => <p key={warning} className="text-[11px] leading-relaxed text-amber-300">Connection: {warning}</p>)}
        </div>)}
      </div>
      <StructuralResultsPanel design={c} model={structuralDesign} onChange={commitDesign} />
      {structuralAnalysis.warnings.map((warning) => <p key={warning} className="text-[11px] leading-relaxed text-slate-500">{warning}</p>)}
    </Section>
  );

  /* ------------------------------ Towers step ------------------------------ */
  const towerSpot = (index: number): { x: number; z: number } => {
    const { w: W, d: D } = landMeters(land);
    const count = Math.max(c.towers.length, index + 1);
    const gap = Math.min(10, (W - 12) / Math.max(count, 1));
    const offset = ((count - 1) * gap) / 2;
    return { x: -offset + index * gap, z: -D / 2 + 14 };
  };

  const addTower = () => {
    const next = c.towers.length;
    const spot = towerSpot(next);
    const style: ResidentialStyle | CommercialStyle = branch === "residential"
      ? c.residentialStyle ?? "high-rise"
      : c.commercialStyle ?? "office";
    const names = branch === "residential"
      ? style === "individual-house"
        ? ["House 1", "House 2", "House 3", "House 4"]
        : style === "villa-community"
          ? ["Villa 1", "Villa 2", "Villa 3", "Villa 4"]
          : style === "townhouse"
            ? ["Townhouse 1", "Townhouse 2", "Townhouse 3", "Townhouse 4"]
            : ["Tower A", "Tower B", "Tower C", "Tower D"]
      : style === "hotel"
        ? ["Hotel A", "Hotel B", "Hotel C", "Hotel D"]
        : style === "resort"
          ? ["Resort A", "Resort B", "Resort C", "Resort D"]
          : ["Block A", "Block B", "Block C", "Block D", "Block E", "Block F", "Block G", "Block H"];
    update({ towers: [...c.towers, { ...defaultTowerFor(branch, names[next % names.length], spot, style), id: uid("tw") }] });
  };

  const patchTower = (id: string, patch: Partial<TowerData>) => {
    const tower = c.towers.find((item) => item.id === id);
    if (!tower) return;
    const next = { ...patch };
    if (tower.locks?.x) delete next.x;
    if (tower.locks?.z) delete next.z;
    if (tower.locks?.width) delete next.unitWidth;
    if (tower.locks?.depth) delete next.unitDepth;
    if (tower.locks?.height) delete next.floorHeight;
    for (const constraint of tower.constraints ?? []) {
      const target = c.towers.find((item) => item.id === constraint.targetId);
      if (!constraint.locked || !target) continue;
      if (constraint.kind === "alignment") {
        if (constraint.axis === "x") next.x = target.x;
        else if (constraint.axis === "z") next.z = target.z;
        else { next.x = target.x; next.z = target.z; }
      } else if (constraint.kind === "parallel") next.rotY = target.rotY ?? 0;
      else if (constraint.kind === "perpendicular") next.rotY = (target.rotY ?? 0) + 90;
      else if (constraint.kind === "equal") { next.unitWidth = target.unitWidth; next.unitDepth = target.unitDepth; }
    }
    update({ towers: c.towers.map((t) => (t.id === id ? { ...t, ...next } : t)) });
  };

  const customizeOpenings = (tower: TowerData) => patchTower(tower.id, { openings: tower.openings ?? [] });

  const addOpening = (tower: TowerData, kind: TowerOpening["kind"]) => {
    const opening: TowerOpening = {
      id: uid("op"),
      kind,
      face: tower.doorFacing,
      floor: 1,
      offset: 0,
      width: kind === "door" ? 1.1 : 2,
      height: kind === "door" ? 2.1 : 1.5,
      sill: kind === "door" ? 0 : 1,
      family: { ...familyMetadata(familyForId(kind === "door" ? "door-single" : "window-basic")!), hostId: `${tower.id}-facade-${tower.doorFacing}` },
    };
    patchTower(tower.id, { openings: [...(tower.openings ?? []), opening] });
  };

  const patchOpening = (tower: TowerData, openingId: string, patch: Partial<TowerOpening>) => {
    patchTower(tower.id, { openings: (tower.openings ?? []).map((o) => {
      if (o.id !== openingId) return o;
      const next = { ...o, ...patch };
      const family = next.family ? { ...next.family, typeParameters: { ...(next.family.typeParameters ?? {}) }, instanceParameters: { ...(next.family.instanceParameters ?? {}) } } : undefined;
      if (family && typeof patch.width === "number") family.typeParameters!.width = patch.width;
      if (family && typeof patch.height === "number") family.typeParameters!.height = patch.height;
      if (family && typeof patch.sill === "number") family.instanceParameters!.sill = patch.sill;
      return { ...next, family: patch.face && family ? { ...family, hostId: `${tower.id}-facade-${patch.face}` } : family };
    }) });
  };

  const towersPanel = (
    <Section title={branch === "residential" ? "Residential buildings" : "Commercial buildings"}>
      {branch === "residential" && (
        <Select
          label="Residential building type"
          value={c.residentialStyle ?? "high-rise"}
          onChange={(e) => update({ residentialStyle: e.target.value as ResidentialStyle })}
        >
          <option value="high-rise">High-rise apartments</option>
          <option value="individual-house">Individual houses</option>
          <option value="villa-community">Villa community</option>
          <option value="townhouse">Townhouse community</option>
        </Select>
      )}
      {branch === "commercial" && (
        <Select
          label="Commercial building type"
          value={c.commercialStyle ?? "office"}
          onChange={(e) => update({ commercialStyle: e.target.value as CommercialStyle })}
        >
          <option value="office">Office / commercial block</option>
          <option value="hotel">Hotel</option>
          <option value="resort">Resort</option>
        </Select>
      )}
      <Button size="sm" onClick={addTower} className="mb-2">+ {branch === "residential" ? "Add building" : "Add block"}</Button>
      <div className="space-y-2">
        {c.towers.length === 0 && <p className="text-xs text-slate-600">No towers yet.</p>}
        {c.towers.map((t, i) => (
          <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <Input label={`${branch === "residential" ? "Tower" : "Block"} name`} value={t.label} onChange={(e) => patchTower(t.id, { label: e.target.value })} />
              <button onClick={() => update({ towers: c.towers.filter((x) => x.id !== t.id) })} className="mt-4 text-xs font-semibold text-rose-400 hover:text-rose-300">Remove</button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Num label="Floors" value={t.floors} onChange={(v) => patchTower(t.id, { floors: Math.max(Math.round(v) || 1, 1) })} step={1} />
              <Num label="Units / floor" value={t.unitsPerFloor} onChange={(v) => patchTower(t.id, { unitsPerFloor: Math.max(Math.round(v) || 1, 1) })} step={1} />
              <Num label="Unit width" value={t.unitWidth} onChange={(v) => patchTower(t.id, { unitWidth: Math.max(v || 3, 3) })} step={0.5} unit=" m" />
              <Num label="Unit depth" value={t.unitDepth} onChange={(v) => patchTower(t.id, { unitDepth: Math.max(v || 3, 3) })} step={0.5} unit=" m" />
              <Num label="Floor height" value={t.floorHeight} onChange={(v) => patchTower(t.id, { floorHeight: Math.max(v || 2.4, 2.4) })} step={0.1} unit=" m" />
              <Select label="Main door facing" value={t.doorFacing} onChange={(e) => patchTower(t.id, { doorFacing: e.target.value as DoorFacing })}>
               {(Object.keys(DOOR_FACING_LABELS) as DoorFacing[]).map((f) => <option key={f} value={f}>{DOOR_FACING_LABELS[f]}</option>)}
               </Select>
             </div>
             <Select label="Construction phase" value={t.phaseId ?? ""} onChange={(e) => patchTower(t.id, { phaseId: e.target.value || undefined })}>
               <option value="">Unassigned / always visible</option>
               {t.phaseId && !phaseOptions.some((phase) => phase.id === t.phaseId) && <option value={t.phaseId}>Missing or outside selection limit ({t.phaseId})</option>}
               {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
             </Select>
             <div className="mt-3">
               <ParametricControls
                 family={t.family}
                 locks={t.locks}
                 constraints={t.constraints}
                 targets={c.towers.filter((target) => target.id !== t.id).map((target) => ({ id: target.id, label: target.label }))}
                 onChange={(patch) => patchTower(t.id, patch)}
               />
             </div>
             <div className="mt-2 grid grid-cols-2 gap-2">
              <Num label="Common area / floor" value={t.commonAreaPerFloor} onChange={(v) => patchTower(t.id, { commonAreaPerFloor: Math.max(v || 0, 0) })} step={1} unit=" m²" />
              <Num label="Open space / floor" value={t.openAreaPerFloor} onChange={(v) => patchTower(t.id, { openAreaPerFloor: Math.max(v || 0, 0) })} step={1} unit=" m²" />
            </div>
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-300">Windows & doors</p>
                {t.openings === undefined ? (
                  <Button variant="secondary" size="sm" onClick={() => customizeOpenings(t)}>Customize</Button>
                ) : (
                  <div className="flex gap-1">
                    <Button variant="secondary" size="sm" onClick={() => addOpening(t, "window")}>+ Window</Button>
                    <Button variant="secondary" size="sm" onClick={() => addOpening(t, "door")}>+ Door</Button>
                  </div>
                )}
              </div>
              {t.openings === undefined ? (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">Uses a generated preview. Customize to place each opening yourself.</p>
              ) : t.openings.length === 0 ? (
                <p className="mt-1 text-[11px] text-slate-500">No openings yet. Add windows and doors to build this facade.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {t.openings.map((o, openingIndex) => (
                    <div key={o.id} className="rounded-lg border border-slate-800 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-400">Opening {openingIndex + 1}</span>
                        <button onClick={() => patchTower(t.id, { openings: t.openings?.filter((x) => x.id !== o.id) })} className="text-[11px] font-semibold text-rose-400 hover:text-rose-300">Remove</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Select label="Type" value={o.kind} onChange={(e) => patchOpening(t, o.id, { kind: e.target.value as TowerOpening["kind"] })}>
                          <option value="window">Window</option>
                          <option value="door">Door</option>
                        </Select>
                        <Select label="Face" value={o.face} onChange={(e) => patchOpening(t, o.id, { face: e.target.value as TowerOpening["face"] })}>
                          <option value="north">North</option><option value="south">South</option><option value="east">East</option><option value="west">West</option>
                        </Select>
                        <Num label="Floor" value={o.floor} onChange={(v) => patchOpening(t, o.id, { floor: Math.max(Math.min(Math.round(v) || 1, t.floors), 1) })} min={1} step={1} />
                        <Num label="Offset" value={o.offset} onChange={(v) => patchOpening(t, o.id, { offset: v || 0 })} step={0.5} unit=" m" />
                        <Num label="Width" value={o.width} onChange={(v) => patchOpening(t, o.id, { width: Math.max(v || 0.3, 0.3) })} min={0.3} step={0.1} unit=" m" />
                        <Num label="Height" value={o.height} onChange={(v) => patchOpening(t, o.id, { height: Math.max(v || 0.3, 0.3) })} min={0.3} step={0.1} unit=" m" />
                        {o.kind === "window" && <Num label="Sill height" value={o.sill} onChange={(v) => patchOpening(t, o.id, { sill: Math.max(v || 0, 0) })} min={0} step={0.1} unit=" m" />}
                        <div className="col-span-2"><ParametricControls family={o.family} targets={[]} onChange={(patch) => patchOpening(t, o.id, patch)} /></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">Footprint: {towerMeters(t).w.toFixed(1)} × {towerMeters(t).d.toFixed(1)} m, height {towerMeters(t).h.toFixed(1)} m ({i > 0 ? "auto-placed" : "placed on site"})</p>
          </div>
        ))}
      </div>
    </Section>
  );

  /* ----------------------------- Exterior step ----------------------------- */
  const exteriorsPanel = (
    <Section title="Building exterior">
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        Pick the facade material for every {branch === "residential" ? "tower" : "block"}. Panels let you place a second material (e.g. glass) on specific bands — the scene updates live.
      </p>
      {c.towers.map((t) => (
        <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <p className="mb-2 text-sm font-semibold text-slate-200">{t.label}</p>
          <Select label="Facade material" value={t.facadeMaterial} onChange={(e) => {
            const opt = FACADES.find((f) => f.key === e.target.value);
            patchTower(t.id, { facadeMaterial: e.target.value, facadeColor: opt?.color ?? t.facadeColor });
          }}>
            {FACADES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </Select>
        </div>
      ))}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-medium text-slate-300">Material placement panels</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (c.towers.length === 0) return;
              const panel: ExteriorPanel = {
                id: uid("px"),
                towerId: c.towers[0].id,
                face: "front",
                x: 0, y: 0, w: Math.min(c.towers[0].unitWidth * 2, 12), h: 2.4,
                material: "glass",
                color: FACADES[0].color,
              };
              update({ exteriors: [...c.exteriors, panel] });
            }}
          >
            + Panel
          </Button>
        </div>
        {c.exteriors.length === 0 && <p className="text-xs text-slate-600">No panels — whole facades use their material.</p>}
        {c.exteriors.map((p) => (
          <div key={p.id} className="mb-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-300">{FACADES.find((f) => f.key === p.material)?.label ?? p.material}</p>
              <button onClick={() => update({ exteriors: c.exteriors.filter((x) => x.id !== p.id) })} className="text-xs font-semibold text-rose-400 hover:text-rose-300">Remove</button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Select label="Block" value={p.towerId} onChange={(e) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, towerId: e.target.value } : x) })}>
                {c.towers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
              <Select label="Face" value={p.face} onChange={(e) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, face: e.target.value as ExteriorPanel["face"] } : x) })}>
                <option value="front">Front</option><option value="back">Back</option>
                <option value="left">Left</option><option value="right">Right</option>
              </Select>
              <Num label="Offset (x)" value={p.x} onChange={(v) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, x: v } : x) })} step={0.5} unit=" m" />
              <Num label="Height above ground" value={p.y} onChange={(v) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, y: v } : x) })} step={0.5} unit=" m" />
              <Num label="Width" value={p.w} onChange={(v) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, w: Math.max(v || 1, 1) } : x) })} step={0.5} unit=" m" />
              <Num label="Height" value={p.h} onChange={(v) => update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, h: Math.max(v || 1, 1) } : x) })} step={0.5} unit=" m" />
              <Select label="Material" value={p.material} onChange={(e) => {
                const opt = FACADES.find((f) => f.key === e.target.value);
                update({ exteriors: c.exteriors.map((x) => x.id === p.id ? { ...x, material: e.target.value, color: opt?.color ?? x.color } : x) });
              }}>
                {FACADES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </Select>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );

  /* ----------------------------- Interiors step ---------------------------- */
  const patchRoom = (id: string, patch: Partial<InteriorRoom>) => {
    const room = c.interiors.find((item) => item.id === id);
    if (!room) return;
    const next = { ...patch };
    if (room.locks?.x) delete next.x;
    if (room.locks?.z) delete next.z;
    if (room.locks?.width) delete next.w;
    if (room.locks?.depth) delete next.d;
    if (room.locks?.level) delete next.floor;
    for (const constraint of room.constraints ?? []) {
      const target = c.interiors.find((item) => item.id === constraint.targetId);
      if (!constraint.locked || !target) continue;
      if (constraint.kind === "alignment") {
        if (constraint.axis === "x") next.x = target.x;
        else if (constraint.axis === "z") next.z = target.z;
        else { next.x = target.x; next.z = target.z; }
      } else if (constraint.kind === "equal") { next.w = target.w; next.d = target.d; }
      else if (constraint.kind === "level") next.floor = target.floor;
    }
    update({ interiors: c.interiors.map((item) => item.id === id ? { ...item, ...next } : item) });
  };
  const interiorsPanel = (
    <Section title="Interiors">
      <div className="flex gap-2">
        <div className="flex-1">
          <Select value={newRoomType} onChange={(e) => setNewRoomType(e.target.value)}>
            {INTERIOR_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
        </div>
        <Button size="sm" onClick={() => {
          if (c.towers.length === 0) {
            toast.push({ title: "Add a tower first", tone: "info" });
            return;
          }
          const tower = c.towers[0];
          const room = makeRoom(tower.id, 0, interiorLabel(newRoomType), newRoomType);
          update({ interiors: [...c.interiors, room] });
        }}>+ Room</Button>
      </div>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
        Name and size the rooms inside each {branch === "residential" ? "apartment" : "office"} unit. Room plans are shown on the canvas when the Interior room plans layer is visible.
      </p>
      {c.interiors.length === 0 && <p className="text-xs text-slate-600">No rooms yet.</p>}
      {c.interiors.map((r) => (
         <div key={r.id} className={cn("rounded-xl border bg-slate-950/50 p-3", r.id === selectedId ? "border-teal-400/60" : "border-slate-800")}>
          <div className="flex items-center justify-between gap-2">
            <Input label="Room name" value={r.name} onChange={(e) => patchRoom(r.id, { name: e.target.value })} />
            <button onClick={() => update({ interiors: c.interiors.filter((x) => x.id !== r.id) })} className="mt-4 text-xs font-semibold text-rose-400 hover:text-rose-300">Remove</button>
          </div>
           <div className="mt-2 grid grid-cols-2 gap-2">
              <Num label="Plan X" value={r.x} onChange={(v) => patchRoom(r.id, { x: v })} step={0.5} unit=" m" />
              <Num label="Plan Z" value={r.z} onChange={(v) => patchRoom(r.id, { z: v })} step={0.5} unit=" m" />
              <Select label="Type" value={r.type} onChange={(e) => patchRoom(r.id, { type: e.target.value })}>
               {INTERIOR_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
             </Select>
               <Select label="Level" value={String(r.floor)} onChange={(e) => patchRoom(r.id, { floor: Math.max(0, Math.min(Number(e.target.value), levels.length - 1)) })}>
                {levels.map((level, index) => <option key={level.id} value={index}>{level.name}</option>)}
              </Select>
              <Select label="Construction phase" value={r.phaseId ?? ""} onChange={(e) => patchRoom(r.id, { phaseId: e.target.value || undefined })}>
                <option value="">Unassigned / always visible</option>
                {r.phaseId && !phaseOptions.some((phase) => phase.id === r.phaseId) && <option value={r.phaseId}>Missing or outside selection limit ({r.phaseId})</option>}
                {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
              </Select>
              <div className="col-span-2">
                <ParametricControls
                  family={r.family}
                  locks={r.locks}
                  constraints={r.constraints}
                  targets={c.interiors.filter((target) => target.id !== r.id).map((target) => ({ id: target.id, label: target.name }))}
                  onChange={(patch) => patchRoom(r.id, patch)}
                />
              </div>
              <Num label="Width" value={r.w} onChange={(v) => patchRoom(r.id, { w: Math.max(v || 1, 1) })} step={0.5} unit=" m" />
              <Num label="Depth" value={r.d} onChange={(v) => patchRoom(r.id, { d: Math.max(v || 1, 1) })} step={0.5} unit=" m" />
              <Select label="Door facing" value={r.doorFacing} onChange={(e) => patchRoom(r.id, { doorFacing: e.target.value as DoorFacing })}>
              {(Object.keys(DOOR_FACING_LABELS) as DoorFacing[]).map((f) => <option key={f} value={f}>{DOOR_FACING_LABELS[f]}</option>)}
            </Select>
           </div>
           <button onClick={() => setSelectedId(r.id)} className="mt-2 w-full rounded-lg border border-slate-700 px-2 py-1.5 text-[11px] font-semibold text-slate-300 hover:border-teal-400 hover:text-teal-300">Select room plan on canvas</button>

          {/* Furniture */}
          <div className="mt-2 rounded-lg border border-slate-800/70 bg-slate-950/40 p-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Furniture · {r.furniture?.length ?? 0}
              </p>
              <button
                onClick={() => setGen({ mode: "room", roomId: r.id, x: 0, z: 0, text: "" })}
                className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300"
              >
                + Add / generate
              </button>
            </div>
            <button
              onClick={() => setFurnishRoomId(r.id)}
              className="mt-2 w-full rounded-lg border border-slate-700 px-2 py-1.5 text-[11px] font-semibold text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            >
              Open room editor · drag furniture
            </button>
            {(r.furniture ?? []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(r.furniture ?? []).map((f) => (
                  <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">
                    {f.name}
                    <button
                      onClick={() => update({ interiors: c.interiors.map((x) => x.id === r.id ? { ...x, furniture: (x.furniture ?? []).filter((y) => y.id !== f.id) } : x) })}
                      className="text-slate-500 hover:text-rose-300"
                      aria-label={`Remove ${f.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </Section>
  );

  /* ----------------------------- Takeoff step ------------------------------ */
  const notesText = () => buildNotesText({ projectName: projectName || "Untitled project", design: c, takeoff });

  const exportNotes = async (how: "download" | "copy" | "share") => {
    const text = notesText();
    if (how === "download") {
      download(notesFilename(projectName || "project"), text, "text/plain;charset=utf-8");
      toast.push({ title: "Brief downloaded", description: "Open in Notepad, Notes or any editor.", tone: "success" });
      return;
    }
    if (how === "copy") {
      const ok = await copyToClipboard(text);
      toast.push({ title: ok ? "Copied to clipboard" : "Copy failed", description: ok ? "Paste into Notepad, Samsung Notes or Apple Notes." : undefined, tone: ok ? "success" : "error" });
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
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
        <p className="gw-kicker text-emerald-300">BOQ ready</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">Review the planning quantities below, then download the CSV for estimating or share the project brief with your team.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[
          ["Site area", `${takeoff.summary.siteAreaM2.toLocaleString()} m²`],
          ["Built-up", `${takeoff.summary.builtUpM2.toLocaleString()} m²`],
          ["FAR / FSI", `${takeoff.summary.far}`],
          ["Floors", `${takeoff.summary.floors}`],
          ["Parking", `${takeoff.summary.parkingBays} bays`],
          ["Open area", `${takeoff.summary.openAreaM2.toLocaleString()} m²`],
          ["Excavation", `${takeoff.summary.excavationM3.toLocaleString()} m³`],
          ["Concrete", `${takeoff.summary.concreteM3.toLocaleString()} m³`],
          ["Steel", `${takeoff.summary.steelT} t`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
            <p className="text-[11px] text-slate-500">{k}</p>
            <p className="text-sm font-semibold text-slate-200">{v}</p>
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
        Quantities follow conventional RCC practice and standard work-item norms — verify against structural
        drawings and a certified BOQ before procurement.
      </p>
    </Section>
  );

  const reviewPanel = (
    <Section title="Coordination review">
      <div className="flex items-center justify-between rounded-xl border border-rose-500/20 bg-rose-500/5 px-3 py-2">
        <span className="text-xs font-semibold text-rose-200">Review gate</span>
        <span className="text-xs text-rose-300">{reviewReady ? `${reviewFindings.length} automatic checks` : "Checks updating or unavailable"} · {markers.length} markup{markers.length === 1 ? "" : "s"}</span>
      </div>
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
         Rotated footprint, vertical-envelope, clearance, MEP/building, and approximate structure checks. Scores are screening priorities, not code compliance.
      </p>
      <div className="space-y-2">
         <p className="text-xs font-semibold text-slate-300">Automatic checks {reviewReady ? `(${reviewFindings.length}) · risk ${reviewRiskScore(reviewFindings)}/100` : "awaiting results"}</p>
        <ReviewAnalysisState status={reviewAnalysis.status} error={reviewAnalysis.error} retry={reviewAnalysis.retry} runFallback={reviewAnalysis.runFallback} />
        {reviewReady && reviewFindings.length === 0 && <p className="text-xs text-emerald-300">No tower or amenity footprint clashes detected.</p>}
        {reviewFindings.map((finding) => (
          <button key={finding.id} onClick={() => setSelectedId(finding.targetIds[0])} className="block w-full rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-left text-xs text-rose-200 hover:bg-rose-500/10">
             <span className="font-semibold">{finding.severity} · {finding.score}/100</span> · {finding.category} · {finding.text}
             <span className="mt-1 block text-[10px] text-rose-300/70">Approximation: {finding.approximation}</span>
          </button>
        ))}
      </div>
      <CoordinationPanel markers={markers} findings={reviewReady ? reviewFindings : []} onChange={(next) => update({ review: { markers: next } })}
        modelIds={[...c.towers, ...c.amenities, ...c.interiors, ...c.exteriors, ...(c.drafts ?? []), ...(c.mep?.elements ?? []), ...(c.structuralGrid ?? []), ...c.towers.flatMap(tower => tower.openings ?? []), ...c.interiors.flatMap(room => [...(room.openings ?? []), ...(room.furniture ?? []), ...(room.mep?.elements ?? [])])].map(item => item.id)}
        gridIds={(c.structuralGrid ?? []).map(grid => grid.id)} selectedId={selectedId} selectedPosition={selectedTower ?? selectedAmenity ?? selectedDraft}
        onSelect={setSelectedId} presentationApi={presentationApi} projectName={projectName} />
    </Section>
  );

  const mepPanel = <Section title="MEP coordination"><MepPanel value={c.mep} phases={visualization.phases} onChange={(mep) => update({ mep })} /></Section>;

  const panels: Record<StepId, React.ReactNode> = {
    land: landPanel,
    parking: parkPanel,
    basement: basementPanel,
    levels: levelsPanel,
    drafting: draftingPanel,
    analysis: analysisPanel,
    amenities: amenitiesPanel,
    towers: towersPanel,
    exterior: exteriorsPanel,
    interiors: interiorsPanel,
    mep: mepPanel,
    takeoff: takeoffPanel,
    review: reviewPanel,
  };

  const runSceneTool = (tool: CadTool) => {
    setActiveTool(tool);
    if (tool === "add-building") {
      addTower();
      setStep("towers");
    }
    if (tool === "add-feature") {
      addAmenity();
      setStep("amenities");
    }
    if (tool === "line" || tool === "rectangle" || tool === "circle" || tool === "dimension" || tool === "wall" || tool === "slab" || tool === "column" || tool === "roof") {
      setStep("drafting");
    }
    if (tool === "rotate" && selectedId) {
      if (selectedAmenity) patchAmenity(selectedId, { rotY: (selectedAmenity.rotY + 90) % 360 });
      if (selectedTower) patchTower(selectedId, { rotY: ((selectedTower.rotY ?? 0) + 90) % 360 });
    }
    if (selectedDraft && ["trim", "extend", "offset", "rotate", "mirror"].includes(tool)) operateDraft(tool as "trim" | "extend" | "offset" | "rotate" | "mirror");
    if (selectedDraft && tool === "array") arrayDraft();
  };

  const activeIndex = STEPS.findIndex((s) => s.id === step);

  return (
      <div ref={workspaceRef} className={cn(
      "relative flex min-h-0 flex-1 flex-col",
      focusMode && "fixed left-0 top-0 z-50 h-[100dvh] w-screen bg-slate-950 p-3",
    )}>
      <div className="gw-sheet-toolbar mb-2 mt-2 flex min-h-10 items-center gap-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/80 px-2 py-1.5 backdrop-blur">
         <span className="hidden px-2 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:inline">
           Workspace
         </span>
         {design && <DesignExportMenu design={design} projectName={projectName} onChange={(next) => onChange(next.community ?? community)} />}
        {focusMode && (
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Workspace tools">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => { setStep(s.id); setFocusPanelOpen(true); }}
                aria-current={step === s.id ? "step" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition",
                  step === s.id ? "bg-emerald-500/15 text-emerald-300" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                )}
                title={s.label}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-[10px]">{i + 1}</span>
                <span className="hidden md:inline">{s.label}</span>
              </button>
            ))}
          </nav>
        )}
        {!focusMode && <div className="flex-1" />}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void toggleFocusMode()}
          title={focusMode ? "Show feature panels" : "Expand the 3D workspace"}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {focusMode ? <path d="M9 3H3v6M3 3l7 7M15 21h6v-6M21 21l-7-7" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M3 9V3h6M3 3l7 7M21 15v6h-6M21 21l-7-7" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
          <span className="hidden sm:inline">{focusMode ? "Show tools" : "Expand canvas"}</span>
        </Button>
        <div className="hidden items-center gap-1 border-l border-slate-800 pl-2 sm:flex">
          <Button variant="ghost" size="sm" onClick={undo} disabled={historyRef.current.past.length === 0} title="Undo (Ctrl/Cmd+Z)">Undo</Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={historyRef.current.future.length === 0} title="Redo (Ctrl/Cmd+Shift+Z)">Redo</Button>
          <Button variant="ghost" size="sm" onClick={() => setLayersOpen((open) => !open)} title="Layer visibility">Layers</Button>
        </div>
      </div>
      {layersOpen && (
        <div className="absolute right-3 top-12 z-30 w-56 rounded-xl border border-slate-700 bg-slate-900/95 p-2 shadow-2xl backdrop-blur">
          <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">Layer visibility</p>
          {layers.map((layer) => (
            <button key={layer.id} onClick={() => toggleLayer(layer.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-300 hover:bg-slate-800">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: layer.color }} />
              <span className="flex-1">{layer.name}</span>
              <span className={cn("text-[10px] font-bold", layer.visible ? "text-emerald-300" : "text-slate-600")}>{layer.visible ? "ON" : "OFF"}</span>
            </button>
          ))}
        </div>
      )}
      {focusMode && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 px-2 py-1.5">
          <span className="px-2 text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">Tools</span>
          <CadToolPalette active={activeTool} onChange={runSceneTool} compact />
          <Button variant="ghost" size="sm" onClick={() => setFocusPanelOpen((open) => !open)}>
            {focusPanelOpen ? "Close features" : "Open features"}
          </Button>
          <span className="ml-auto hidden text-[11px] text-slate-500 md:inline">
            {activeTool === "measure" && (selectedAmenity ? `${selectedAmenity.w} × ${selectedAmenity.d} m` : selectedTower ? `${towerMeters(selectedTower).w.toFixed(1)} × ${towerMeters(selectedTower).d.toFixed(1)} m` : "Select an object")}
            {activeTool === "move" && "Drag a selected object in the canvas"}
            {activeTool === "select" && "Click an object to inspect it"}
          </span>
        </div>
      )}
      {focusMode && focusPanelOpen && (
        <aside className="absolute bottom-3 left-3 top-[6.75rem] z-20 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">Feature controls</p>
              <p className="mt-1 text-sm font-semibold text-slate-100">{STEPS.find((item) => item.id === step)?.label}</p>
            </div>
            <button onClick={() => setFocusPanelOpen(false)} className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100">Close</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto space-y-4 p-4">{panels[step]}</div>
        </aside>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: stepper + params */}
        <div className={cn(
          "flex w-full shrink-0 flex-col border-r border-slate-800 bg-slate-900/40 lg:w-96",
          focusMode && "hidden",
        )}>
          <div className="flex gap-1 overflow-x-auto border-b border-slate-800 px-3 py-2">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setStep(s.id)}
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
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"><SectionControls value={c.section} onChange={(section) => update({ section })} />{panels[step]}</div>
        </div>

        {/* Right: 3D scene */}
        <div className="relative min-h-[420px] flex-1">
           <CommunityScene
             onPresentationReady={setPresentationApi}
            design={c}
            selectedId={selectedId}
            onSelect={setSelectedId}
             onChange={commitDesign}
             activeTool={activeTool}
             visualization={visualization}
            onContextTarget={(t) => {
              setSelectedId(t.id ?? null);
              setContext(t);
            }}
           />
           {design && <div className="absolute bottom-3 left-3 z-10"><VisualizationControls design={design} presentationApi={presentationApi} onChange={(next) => onVisualizationChange?.(next)} /></div>}
          <div className="pointer-events-none absolute left-3 top-3 rounded-xl bg-slate-950/80 px-3 py-2 text-xs text-slate-300 backdrop-blur">
            {branch === "residential" ? "Residential community" : "Commercial complex"} · drag objects to move · right-click for actions
          </div>
          {selectedTower && (
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-slate-950/85 px-3 py-2 text-xs text-emerald-300 backdrop-blur">
              {selectedTower.label} · {towerMeters(selectedTower).w.toFixed(1)} × {towerMeters(selectedTower).d.toFixed(1)} m
            </div>
          )}
          {selectedAmenity && (
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-slate-950/85 px-3 py-2 text-xs text-emerald-300 backdrop-blur">
              {selectedAmenity.label ?? amenityKind(selectedAmenity.kind)?.label ?? selectedAmenity.kind} · {selectedAmenity.w} × {selectedAmenity.d} m
            </div>
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {context && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContext(null)} onContextMenu={(e) => { e.preventDefault(); setContext(null); }} />
          <div
            className="fixed z-50 w-52 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 text-sm shadow-2xl"
            style={{ left: Math.min(context.clientX, window.innerWidth - 220), top: Math.min(context.clientY, window.innerHeight - 260) }}
          >
            {context.kind === "ground" && (
              <>
                <ContextItem onClick={() => { setGen({ mode: "site", x: context.x, z: context.z, text: "" }); setContext(null); }}>Add object…</ContextItem>
                <ContextItem onClick={() => { addTower(); setStep("towers"); setContext(null); }}>Add {branch === "residential" ? "tower" : "block"}</ContextItem>
                <ContextItem onClick={() => { setStep("amenities"); setContext(null); }}>Open amenities</ContextItem>
              </>
            )}
            {context.kind === "tower" && context.id && (
              <>
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {c.towers.find((t) => t.id === context.id)?.label ?? "Tower"}
                </p>
                <p className="px-3 pb-1 pt-1 text-[11px] text-slate-500">Apply facade material</p>
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                  {FACADES.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => { applyFacadeToTower(context.id!, f.key); setContext(null); }}
                      className="rounded-md border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
                      style={{ borderLeftColor: f.color, borderLeftWidth: 3 }}
                    >
                      {f.label.split(" ")[0]}
                    </button>
                  ))}
                </div>
                <ContextItem onClick={() => { duplicateTower(context.id!); setContext(null); }}>Duplicate</ContextItem>
                <ContextItem danger onClick={() => { update({ towers: c.towers.filter((t) => t.id !== context.id), exteriors: c.exteriors.filter((p) => p.towerId !== context.id) }); setContext(null); }}>Delete</ContextItem>
              </>
            )}
             {context.kind === "room" && context.id && (
               <>
                 <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                   {c.interiors.find((room) => room.id === context.id)?.name ?? "Room plan"}
                 </p>
                 <ContextItem onClick={() => { setStep("interiors"); setSelectedId(context.id!); setContext(null); }}>Edit room plan</ContextItem>
                 <ContextItem onClick={() => { setFurnishRoomId(context.id!); setContext(null); }}>Open room editor</ContextItem>
               </>
             )}
             {context.kind === "amenity" && context.id && (
              <>
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {c.amenities.find((a) => a.id === context.id)?.label ?? amenityKind(c.amenities.find((a) => a.id === context.id)?.kind ?? "")?.label ?? "Object"}
                </p>
                <ContextItem onClick={() => { update({ amenities: c.amenities.map((a) => (a.id === context.id ? { ...a, rotY: (a.rotY + 90) % 360 } : a)) }); setContext(null); }}>Rotate 90°</ContextItem>
                <ContextItem onClick={() => { duplicateAmenity(context.id!); setContext(null); }}>Duplicate</ContextItem>
                <ContextItem danger onClick={() => { update({ amenities: c.amenities.filter((a) => a.id !== context.id) }); setContext(null); }}>Delete</ContextItem>
              </>
            )}
          </div>
        </>
      )}

      {/* Offline object generator */}
      <Modal open={Boolean(gen)} onClose={() => setGen(null)} title={gen?.mode === "room" ? "Add furniture" : "Add object"}>
        <div className="space-y-4">
          <Input
            label="What should I add?"
            placeholder={gen?.mode === "room" ? "e.g. two sofas, a queen bed, coffee table" : "e.g. 3 trees, a car, fountain, bench"}
            value={gen?.text ?? ""}
            autoFocus
            onChange={(e) => setGen((g) => (g ? { ...g, text: e.target.value } : g))}
          />
          {(() => {
            const parsed = gen ? parseObjectQuery(gen.text) : null;
            if (!gen?.text.trim()) return <p className="text-xs text-slate-500">Understands plain words — “sofa”, “tree”, “car”, “fountain”, “bench”, “2 chairs”.</p>;
            if (!parsed) return <p className="text-xs text-rose-400">Not recognised. Try sofa, bed, table, chair, rug, plant, tv, tree, car, bench, statue, fountain, shed, fence.</p>;
            const dims = parsed.recipe.kind === "furniture" ? "furniture" : `${parsed.recipe.w} × ${parsed.recipe.d} m`;
            return (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
                {describeObject(parsed)}
                <span className="ml-2 text-xs text-emerald-400/80">{dims}</span>
              </div>
            );
          })()}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setGen(null)}>Cancel</Button>
            <Button onClick={runGenerator} disabled={!gen?.text.trim()}>Add</Button>
          </div>
        </div>
      </Modal>

      {furnishRoomId && (() => {
        const room = c.interiors.find((r) => r.id === furnishRoomId);
        if (!room) return null;
        const tower = c.towers.find((t) => t.id === room.towerId)?.label ?? "Building";
        return (
          <RoomEditor
            room={room}
            title={`${room.name} · ${tower} · floor ${room.floor}`}
            onClose={() => setFurnishRoomId(null)}
            onChange={(next) => update({ interiors: c.interiors.map((r) => (r.id === next.id ? next : r)) })}
          />
        );
      })()}
      <div className="pointer-events-auto absolute bottom-3 right-3 z-20">
        <DesignAssistantPanel
          messages={assistantMessages}
          onCommand={(message) => void requestPlan(message)}
           plan={assistantPlan}
           busy={assistantBusy}
           previews={assistantPreviews}
           onPreview={() => setAssistantPreviewOpen(true)}
           onApply={() => setAssistantPreviewOpen(true)}
         />
       </div>
      <Modal open={assistantPreviewOpen} onClose={() => setAssistantPreviewOpen(false)} title="Assistant action preview" wide>
        <div className="space-y-3">
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">Review the typed actions before confirming. Nothing is persisted by the assistant, and infrastructure, MEP, structural, and analysis actions stay preview-only in this building editor.</p>
           <div className="max-h-[50vh] space-y-2 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3">
             {assistantPreviews.length === 0 && <p className="text-xs text-slate-500">No plan available.</p>}
             {assistantPreviews.map((item, index) => <div key={`${item.action.type}-${index}`} className="rounded-lg border border-slate-800 px-3 py-2 text-xs">
               <p className={item.applicable ? "text-emerald-300" : "text-amber-300"}>{item.applicable ? "Ready to apply" : "Preview only / not applied"}</p>
               <p className="mt-1 text-slate-300">{item.label}</p>
               {item.reason && <p className="mt-1 text-slate-500">{item.reason}</p>}
             </div>)}
           </div>
           {assistantHasInvalidActions && <p className="text-xs text-rose-300">One or more editor actions failed client-side validation. Correct the plan before applying any changes.</p>}
           <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setAssistantPreviewOpen(false)}>Cancel</Button><Button onClick={confirmAssistantPlan} disabled={assistantHasInvalidActions || !assistantPreviews.some((item) => item.applicable)}>Confirm and apply</Button></div>
         </div>
       </Modal>
    </div>
  );
}

function ContextItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-1.5 text-left text-sm transition hover:bg-slate-800",
        danger ? "text-rose-300 hover:text-rose-200" : "text-slate-200",
      )}
    >
      {children}
    </button>
  );
}

function defaultTowerFor(
  branch: BuildingBranch,
  label: string,
  spot: { x: number; z: number },
  style: ResidentialStyle | CommercialStyle = "high-rise",
): TowerData {
  const residential = branch === "residential";
  const individual = style === "individual-house";
  const villa = style === "villa-community";
  const townhouse = style === "townhouse";
  const hotel = style === "hotel";
  const resort = style === "resort";
  return {
    id: uid("tw"),
    label,
    x: spot.x,
    z: spot.z,
    floors: !residential ? hotel ? 10 : resort ? 3 : 8 : individual ? 1 : villa || townhouse ? 2 : 12,
    unitsPerFloor: !residential ? hotel || resort ? 12 : 8 : 1,
    unitWidth: !residential ? hotel ? 5 : resort ? 8 : 6 : individual ? 10 : villa ? 12 : townhouse ? 6 : 7,
    unitDepth: !residential ? hotel ? 7 : resort ? 10 : 8 : individual ? 12 : villa ? 15 : townhouse ? 12 : 9,
    floorHeight: 3.2,
    commonAreaPerFloor: residential && (individual || villa || townhouse) ? 0 : resort ? 120 : 60,
    openAreaPerFloor: residential && (individual || villa || townhouse) ? 0 : resort ? 240 : 30,
    doorFacing: "south",
    facadeMaterial: "glass",
    facadeColor: FACADES[0].color,
  };
}

