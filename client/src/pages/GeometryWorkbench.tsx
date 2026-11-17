import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import type { ProjectDetail } from "../types";
import { Button, Card, Input } from "../components/ui";
import { ProjectWorkspacePanel } from "../components/ProjectWorkspacePanel";
import { StreamingGeometryViewport } from "../components/StreamingGeometryViewport";
import { download, downloadBlob } from "../lib/download";
import { inspectGeometryScene, MAX_SCENE_TRIANGLES, validVec3, type GeometryMesh, type GeometryScene, type Vec3 } from "../lib/meshGeometry";
import { inspectGeometryManifest, type GeometryManifest } from "../lib/geometryPipeline";
import { DEFAULT_TRACE_SETTINGS, type PathTraceSettings } from "../lib/pathTracer";
import { buildIfcStep } from "../lib/bim";
import { ifcGeometryCoverageWarnings, importIfcGeometry } from "../lib/ifcGeometry";
import type { MeshClashReport } from "../lib/meshClash";
import type { GeometryBenchmark, GeometryRequest, GeometryResponse } from "../lib/geometry.worker";
import { produceGeometryChunks, type ProducedGeometryChunks } from "../lib/geometryChunkProducer";
import { assertGeometrySource, geometryProductionReferences, inspectSavedGeometryProduction, recoverGeometryProduction, uploadGeometryProduction, type SavedGeometryProduction } from "../lib/geometryProductionWorkspace";
import { deleteWorkspaceArtifact, MAX_WORKSPACE_BYTES } from "../lib/workspaceApi";
import type { PrepareWorkspaceSave } from "../lib/workspaceSavePreparation";
import { RenderStudioModal } from "../components/RenderStudioModal";
import { PageIntro } from "../components/PageIntro";
import { WorkbenchGuide } from "../components/WorkbenchGuide";

interface RenderReport { kind: "path-trace"; verification: "unverified"; settings: PathTraceSettings; camera: GeometryScene["camera"]; meshes: number; triangles: number; elapsedMs: number; note: string }
interface Reports { clashes: MeshClashReport | null; benchmark: GeometryBenchmark | null; render: RenderReport | null }
interface SavedImage { dataUrl: string; width: number; height: number }
interface GeometryWorkspace { version: 1 | 2; scene: GeometryScene | null; manifest: GeometryManifest | null; settings: PathTraceSettings; tolerance: number; reports: Reports; image: SavedImage | null; production?: SavedGeometryProduction | null; sourceLabel?: string }
const emptyReports = (): Reports => ({ clashes: null, benchmark: null, render: null });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function finite(value: unknown, min: number, max: number, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label}.`); return value; }
function text(value: unknown, max: number, label: string): string { if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${label}.`); return value; }
function strings(value: unknown, count: number, maximum: number): string[] { if (!Array.isArray(value) || value.length > count) throw new Error("Invalid saved string array."); return value.map(item => text(item, maximum, "report text")); }
function inspectSettings(value: unknown): PathTraceSettings {
  if (!object(value)) throw new Error("Saved trace settings must be an object.");
  const width = finite(value.width, 16, 2048, "image width"), height = finite(value.height, 16, 2048, "image height"), samples = finite(value.samples, 1, 256, "samples"), bounces = finite(value.bounces, 1, 12, "bounces"), seed = finite(value.seed, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "seed"), exposure = finite(value.exposure, Number.MIN_VALUE, 100, "exposure");
  if (![width, height, samples, bounces, seed].every(Number.isSafeInteger) || width * height > 1_048_576 || width * height * samples * bounces > 40_000_000 || !validVec3(value.environment) || !validVec3(value.sunDirection) || !validVec3(value.sunIrradiance) || [...value.environment, ...value.sunIrradiance].some(item => item < 0 || item > 1e4) || Math.hypot(...value.sunDirection) < 1e-15) throw new Error("Saved trace settings exceed the renderer's pixel/ray limits or contain invalid lighting.");
  return { width, height, samples, bounces, seed, exposure, environment: [...value.environment] as Vec3, sunDirection: [...value.sunDirection] as Vec3, sunIrradiance: [...value.sunIrradiance] as Vec3 };
}
function boundedJson(value: unknown): void {
  let entries = 0, characters = 0; const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++entries > 2_000_000 || depth > 24) throw new Error("Saved report exceeds the recovery complexity limit.");
    if (typeof item === "string") { characters += item.length; if (characters > 8_000_000) throw new Error("Saved report text exceeds 8 MB."); return; }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("Saved report contains invalid non-JSON data.");
    ancestors.add(item); for (const [key, child] of Object.entries(item)) { characters += key.length; visit(child, depth + 1); } ancestors.delete(item);
  };
  visit(value, 0); if (JSON.stringify(value).length > 8_000_000) throw new Error("Saved report JSON exceeds 8 MB.");
}
function inspectReports(value: unknown, scene: GeometryScene | null, settings: PathTraceSettings, tolerance: number): Reports {
  boundedJson(value); if (!object(value)) throw new Error("Saved reports must be an object.");
  const meshIds = new Set(scene?.meshes.map(mesh => mesh.id) ?? []), sourceIds = new Set(scene?.meshes.map(mesh => mesh.sourceId) ?? []);
  let clashes: MeshClashReport | null = null, benchmark: GeometryBenchmark | null = null, render: RenderReport | null = null;
  if (value.clashes !== null) {
    const report = value.clashes;
    if (!scene || !object(report) || typeof report.complete !== "boolean" || !Array.isArray(report.clashes) || report.clashes.length > 200000 || finite(report.toleranceM, 1e-9, 0.01, "report tolerance") !== tolerance) throw new Error("Saved clash report scope is invalid.");
    finite(report.triangleTests, 0, 5_000_001, "triangle tests"); finite(report.candidatePairs, 0, 200001, "candidate pairs"); strings(report.warnings, 400001, 4000);
    if (!Number.isSafeInteger(report.triangleTests) || !Number.isSafeInteger(report.candidatePairs) || !strings(report.openMeshes, 100000, 240).every(id => meshIds.has(id))) throw new Error("Saved clash counts/mesh references are invalid.");
    for (const clash of report.clashes) if (!object(clash) || typeof clash.a !== "string" || !sourceIds.has(clash.a) || typeof clash.b !== "string" || !sourceIds.has(clash.b) || typeof clash.meshA !== "string" || !meshIds.has(clash.meshA) || typeof clash.meshB !== "string" || !meshIds.has(clash.meshB) || !["surface-intersection", "coplanar-contact", "solid-containment"].includes(String(clash.kind)) || !validVec3(clash.point)) throw new Error("Saved clash references/coordinates are invalid.");
    clashes = report as unknown as MeshClashReport;
  }
  if (value.benchmark !== null) {
    const report = value.benchmark;
    if (!object(report) || report.kind !== "synthetic-triangle-bvh" || (report.components !== 10000 && report.components !== 100000) || report.triangles !== report.components || report.rays !== 1000) throw new Error("Saved benchmark has an unsupported scope.");
    finite(report.buildMs, 0, 1e12, "BVH duration"); finite(report.rayQueryMs, 0, 1e12, "ray duration"); finite(report.hits, 0, 1000, "ray hits"); if (!Number.isSafeInteger(report.hits)) throw new Error("Invalid benchmark hits."); text(report.note, 4000, "benchmark note"); benchmark = report as unknown as GeometryBenchmark;
  }
  if (value.render !== null) {
    const report = value.render;
    if (!scene || !object(report) || report.kind !== "path-trace" || report.verification !== "unverified" || !object(report.camera)) throw new Error("Saved render report scope is invalid.");
    const rendered = inspectSettings(report.settings);
    if (JSON.stringify(rendered) !== JSON.stringify(settings) || JSON.stringify(report.camera) !== JSON.stringify(scene.camera) || report.meshes !== scene.meshes.length || report.triangles !== scene.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)) throw new Error("Saved render report differs from its scene/settings.");
    finite(report.elapsedMs, 0, 1e12, "trace duration"); text(report.note, 4000, "render note"); render = { ...report, settings: rendered } as unknown as RenderReport;
  }
  return { clashes, benchmark, render };
}
function inspectImage(value: unknown): SavedImage | null {
  if (value === null) return null;
  if (!object(value)) throw new Error("Saved image must be an object.");
  const dataUrl = text(value.dataUrl, 16_000_000, "PNG data"), prefix = "data:image/png;base64,", raw = dataUrl.slice(prefix.length);
  const width = finite(value.width, 16, 2048, "PNG width"), height = finite(value.height, 16, 2048, "PNG height");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > 1_048_576 || !dataUrl.startsWith(prefix) || raw.length < 44 || raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("Saved PNG encoding/dimensions are invalid.");
  // Check the signature/IHDR before browser allocation. The browser decoder
  // subsequently validates compressed pixel data and chunk checksums.
  const header = atob(raw.slice(0, 64)), byte = (index: number) => header.charCodeAt(index), uint32 = (index: number) => byte(index) * 16777216 + byte(index + 1) * 65536 + byte(index + 2) * 256 + byte(index + 3);
  if (header.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((item, index) => byte(index) !== item) || uint32(8) !== 13 || header.slice(12, 16) !== "IHDR" || uint32(16) !== width || uint32(20) !== height) throw new Error("Saved image is not a bounded PNG with matching metadata.");
  // Completed canvas exports are static PNGs. Reject animation chunks so a
  // one-frame pixel limit cannot hide an unbounded collection of decoded frames.
  const binary = atob(raw), lengthAt = (index: number) => binary.charCodeAt(index) * 16777216 + binary.charCodeAt(index + 1) * 65536 + binary.charCodeAt(index + 2) * 256 + binary.charCodeAt(index + 3);
  let offset = 8, chunks = 0, ended = false, hasPixels = false;
  while (offset + 12 <= binary.length) {
    const length = lengthAt(offset), kind = binary.slice(offset + 4, offset + 8);
    if (++chunks > 4096 || offset + length + 12 > binary.length || ["acTL", "fcTL", "fdAT"].includes(kind) || (kind === "IHDR" && offset !== 8)) throw new Error("Saved PNG has invalid, excessive or animated chunks.");
    if (kind === "IDAT") hasPixels = true;
    offset += length + 12;
    if (kind === "IEND") { if (length || offset !== binary.length) throw new Error("Saved PNG has invalid trailing data."); ended = true; break; }
  }
  if (!ended || !hasPixels) throw new Error("Saved PNG body is incomplete.");
  return { dataUrl, width, height };
}
function inspectWorkspace(value: unknown): GeometryWorkspace {
  if (!object(value) || (value.version !== 1 && value.version !== 2) || (value.scene !== null && value.manifest !== null)) throw new Error("Unsupported geometry workspace version or conflicting scene/manifest.");
  const captured = value.version === 2 && value.production !== null ? inspectSavedGeometryProduction(value.production) : null;
  const sourceLabel = value.version === 2 ? text(value.sourceLabel, 240, "source label") : "Restored geometry scene";
  if (!sourceLabel.trim() || captured && captured.record.label !== sourceLabel) throw new Error("Saved source label differs from its captured geometry package.");
  if (captured && (value.scene !== null || value.manifest === null)) throw new Error("A generated workspace requires its canonical source and saved manifest.");
  const scene = captured?.scene ?? (value.scene === null ? null : inspectGeometryScene(value.scene)), manifest = value.manifest === null ? null : inspectGeometryManifest(value.manifest), settings = inspectSettings(value.settings), tolerance = finite(value.tolerance, 1e-9, 0.01, "clash tolerance"), reports = inspectReports(value.reports, scene, settings, tolerance), image = inspectImage(value.image);
  if ((image && (!scene || !reports.render || image.width !== settings.width || image.height !== settings.height)) || (reports.render && !image)) throw new Error("Saved render/image does not match its scene and trace settings.");
  return { version: value.version, scene, manifest, settings, tolerance, reports, image, production: captured?.record ?? null, sourceLabel };
}
function projectScene(project: ProjectDetail): GeometryScene {
  if (!project.design) throw new Error("The selected project has no saved design geometry.");
  const source = buildIfcStep(project.design), document = importIfcGeometry(source), meshes: GeometryMesh[] = [], warnings: string[] = ["Linked editor import uses approximate IFC planning envelopes, not the editor's original meshes or construction-ready geometry.", "IFC Z-up metres are rotated into right-handed Y-up metres as (X, Z, -Y); triangle winding is retained.", "Constant diffuse material proxies are used. Openings, textures, parametric curves, terrain and unsupported IFC representations may be absent or approximated.", ...ifcGeometryCoverageWarnings(document)];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]; let triangles = 0, missing = 0;
  for (const product of document.products) {
    if (!product.meshes.length) missing++;
    for (const [index, mesh] of product.meshes.entries()) {
      triangles += mesh.triangles.length / 3; if (triangles > MAX_SCENE_TRIANGLES) throw new Error("Project proxy exceeds 400,000 triangles; import a smaller subsystem.");
      const positions: number[] = [], indices: number[] = [];
      for (let offset = 0; offset < mesh.vertices.length; offset += 3) {
        const point: Vec3 = [mesh.vertices[offset], mesh.vertices[offset + 2], -mesh.vertices[offset + 1]];
        if (!validVec3(point)) throw new Error("Project proxy contains invalid or oversized coordinates.");
        positions.push(...point); for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
      }
      for (let offset = 0; offset < mesh.triangles.length; offset += 3) indices.push(mesh.triangles[offset], mesh.triangles[offset + 1], mesh.triangles[offset + 2]);
      const authoredId = product.properties["Groundwork Source.SourceId"], sourceId = authoredId && authoredId.length <= 180 ? authoredId : product.globalId;
      meshes.push({ id: `ifc:${product.globalId}:${index}`, sourceId, positions, indices, material: { color: [0.65, 0.7, 0.78], emission: [0, 0, 0], model: "diffuse", ior: 1.5 } });
    }
  }
  if (!meshes.length) throw new Error("No supported proxy solids were available. Export visible geometry from the editor's Presentation controls instead.");
  if (missing) warnings.push(`${missing} IFC products had no supported Body mesh and were excluded from this proxy scene.`);
  const target = min.map((item, axis) => (item + max[axis]) / 2) as Vec3, distance = Math.max(2, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1.2), position: Vec3 = [target[0] + distance * 0.8, target[1] + distance * 0.6, target[2] + distance * 0.8];
  return inspectGeometryScene({ version: 1, units: "m", meshes, camera: { position, target, up: [0, 1, 0], fov: 50 }, warnings });
}

export function GeometryWorkbench() {
  const { user } = useAuth(), [params] = useSearchParams(), projectId = params.get("project") || "";
  const [scene, setScene] = useState<GeometryScene | null>(null), [manifest, setManifest] = useState<GeometryManifest | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [reports, setReports] = useState<Reports>(emptyReports), [settings, setSettings] = useState<PathTraceSettings>({ ...DEFAULT_TRACE_SETTINGS }), [tolerance, setTolerance] = useState(1e-6), [showViewport, setShowViewport] = useState(false), [hasImage, setHasImage] = useState(false), [image, setImage] = useState<SavedImage | null>(null);
  const [production, setProduction] = useState<SavedGeometryProduction | null>(null), [prepared, setPrepared] = useState<ProducedGeometryChunks | null>(null), [productionBusy, setProductionBusy] = useState(false), [productionNotice, setProductionNotice] = useState(""), [verified, setVerified] = useState(false), [streaming, setStreaming] = useState(false), [sourceLabel, setSourceLabel] = useState("Imported geometry scene");
  const [showRenderStudio, setShowRenderStudio] = useState(false);
  const productionController = useRef<AbortController | null>(null), productionSerial = useRef(0);
  const geometryIdentity = useRef({ projectId, userId: user?.id, scene, production, sourceLabel }); geometryIdentity.current = { projectId, userId: user?.id, scene, production, sourceLabel };
  const canvas = useRef<HTMLCanvasElement>(null), worker = useRef<Worker | null>(null), serial = useRef(0), alive = useRef(true), fileGeneration = useRef(0);
  // Progress previews are transient; only completed output changes saved state.
  const payload = useMemo<GeometryWorkspace>(() => ({ version: 2, scene: production ? null : scene, manifest, settings, tolerance, reports, image, production, sourceLabel }), [scene, manifest, settings, tolerance, reports, image, production, sourceLabel]);
  const managedReferences = useMemo(() => production ? geometryProductionReferences(production) : [], [production]);
  const report = reports.render ?? reports.clashes ?? reports.benchmark;
  const cancel = () => { serial.current++; worker.current?.terminate(); worker.current = null; setBusy(false); };
  const invalidateOutput = () => { setReports(emptyReports()); setImage(null); setHasImage(false); setProgress(0); };
  const cancelProduction = () => { productionSerial.current++; productionController.current?.abort(); productionController.current = null; setProductionBusy(false); };
  const clearProduction = () => { cancelProduction(); setPrepared(null); setProduction(null); setVerified(false); setStreaming(false); setProductionNotice(""); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; fileGeneration.current++; serial.current++; worker.current?.terminate(); }; }, []);
  useEffect(() => {
    cancelProduction(); setPrepared(null); setVerified(false); setStreaming(false); setShowViewport(false);
    return () => { productionSerial.current++; productionController.current?.abort(); };
  }, [projectId, user?.id]);
  const restoreWorkspace = (value: unknown) => {
    const restored = inspectWorkspace(value); // Validate everything before mutation.
    fileGeneration.current++; cancel(); const generation = fileGeneration.current, job = serial.current;
    clearProduction(); setProduction(restored.production ?? null); setSourceLabel(restored.sourceLabel ?? "Restored geometry scene");
    setScene(restored.scene); setManifest(restored.manifest); setSettings(restored.settings); setTolerance(restored.tolerance); setReports(restored.reports); setImage(restored.image); setShowViewport(false); setHasImage(false); setProgress(restored.image ? 1 : 0); setError("");
    if (restored.image) {
      const saved = restored.image, decoded = new Image();
      decoded.onload = () => {
        if (!alive.current || fileGeneration.current !== generation || serial.current !== job) return;
        const target = canvas.current;
        if (!target || decoded.naturalWidth !== saved.width || decoded.naturalHeight !== saved.height) { setError("Saved PNG decoded to unexpected dimensions."); setImage(null); setReports(current => ({ ...current, render: null })); return; }
        const context = target.getContext("2d");
        if (!context) { setError("Canvas drawing is unavailable; saved PNG data remains retained."); return; }
        target.width = saved.width; target.height = saved.height; context.drawImage(decoded, 0, 0); setHasImage(true);
      };
      decoded.onerror = () => { if (alive.current && fileGeneration.current === generation && serial.current === job) { setError("Saved PNG could not be decoded; scene/settings remain available."); setImage(null); setReports(current => ({ ...current, render: null })); } };
      decoded.src = saved.dataUrl;
    }
  };
  const importProject = (project: ProjectDetail) => {
    const imported = projectScene(project); fileGeneration.current++; cancel(); clearProduction(); setSourceLabel(`Editor IFC proxy: ${project.name}`.slice(0, 240)); setScene(imported); setManifest(null); invalidateOutput(); setShowViewport(false); setError("");
  };
  const load = async (file: File | undefined) => {
    if (!file) return; const attempt = ++fileGeneration.current; cancel(); cancelProduction(); invalidateOutput(); setError("");
    try { if (file.size > 32_000_000) throw new Error("File exceeds 32 MB."); const value: unknown = JSON.parse(await file.text()); if (!alive.current || attempt !== fileGeneration.current) return;
      if (value && typeof value === "object" && "chunks" in value) { setManifest(inspectGeometryManifest(value)); setScene(null); } else { setScene(inspectGeometryScene(value)); setManifest(null); }
      clearProduction(); setSourceLabel(file.name.slice(0, 240)); setShowViewport(false);
    } catch (failure) { if (alive.current && attempt === fileGeneration.current) setError(failure instanceof Error ? failure.message : "Import failed."); }
  };
  const start = (request: GeometryRequest) => {
    fileGeneration.current++; cancel(); invalidateOutput(); setError(""); setBusy(true); const id = serial.current, started = performance.now();
    try {
      if (request.operation === "trace") inspectSettings(request.settings);
      const task = new Worker(new URL("../lib/geometry.worker.ts", import.meta.url), { type: "module" }); worker.current = task;
      task.onerror = () => { if (serial.current === id) { setError("Geometry worker failed to load or crashed."); setHasImage(false); cancel(); } };
      task.onmessage = (event: MessageEvent<GeometryResponse>) => {
        if (!alive.current || serial.current !== id || event.data.id !== id) return;
        const message = event.data;
        try {
          if (message.kind === "error") { setError(message.message); setHasImage(false); cancel(); return; }
          if (message.kind === "progress" || message.kind === "image") {
            if (request.operation !== "trace" || message.width !== request.settings.width || message.height !== request.settings.height || message.pixels.length !== message.width * message.height * 4) throw new Error("Invalid geometry image response.");
            const target = canvas.current, context = target?.getContext("2d"); if (!target || !context) throw new Error("Canvas drawing is unavailable.");
            target.width = message.width; target.height = message.height; context.putImageData(new ImageData(new Uint8ClampedArray(message.pixels), message.width, message.height), 0, 0); setHasImage(true); setProgress(message.kind === "image" ? 1 : message.fraction);
            if (message.kind === "image") {
              const finalImage = inspectImage({ dataUrl: target.toDataURL("image/png"), width: message.width, height: message.height })!;
              const render: RenderReport = { kind: "path-trace", verification: "unverified", settings: inspectSettings(request.settings), camera: request.scene.camera, meshes: request.scene.meshes.length, triangles: request.scene.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), elapsedMs: performance.now() - started, note: "Completed CPU Monte Carlo image on this device. Constant material proxies; no texture maps, volumetrics, denoising or external validation." };
              setImage(finalImage); setReports({ ...emptyReports(), render });
            }
          } else if (message.kind === "clashes") { const saved = { ...emptyReports(), clashes: message.report }; inspectReports(saved, request.operation === "clash" ? request.scene : scene, settings, tolerance); setReports(saved); }
          else { const saved = { ...emptyReports(), benchmark: message.report }; inspectReports(saved, scene, settings, tolerance); setReports(saved); }
          if (message.kind !== "progress") cancel();
        } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not retain geometry output."); setHasImage(false); cancel(); }
      };
      task.postMessage({ ...request, id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not start geometry worker."); cancel(); }
  };
  const saveImage = () => { if (image && hasImage) canvas.current?.toBlob(blob => { if (blob) downloadBlob("path-traced.png", blob); else setError("Image export failed."); }, "image/png"); };
  const changeSettings = (key: "width" | "height" | "samples" | "bounces" | "exposure", value: number) => { fileGeneration.current++; cancel(); invalidateOutput(); setSettings(previous => ({ ...previous, [key]: value })); };
  const generate = async () => {
    if (!scene) return; cancelProduction(); cancel(); setError(""); setProductionNotice(""); setProductionBusy(true);
    const controller = new AbortController(), token = productionSerial.current, captured = geometryIdentity.current; productionController.current = controller;
    const active = () => alive.current && token === productionSerial.current && geometryIdentity.current.projectId === captured.projectId && geometryIdentity.current.userId === captured.userId && geometryIdentity.current.scene === captured.scene;
    try {
      const result = await produceGeometryChunks(scene, { signal: controller.signal, context: { label: sourceLabel, projectId: null, sourceRevision: null }, onProgress: event => { if (active()) setProductionNotice(`${event.stage}: ${event.completedMeshes}/${event.totalMeshes} meshes`); } });
      if (!active()) return;
      setPrepared(result); setProductionNotice(`${result.chunks.length} exact chunks prepared; ${(result.source.bytes / 1048576).toFixed(1)} MiB captured source. Save a project workspace to upload and retain the package.`);
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : "Geometry production failed."); }
    finally { if (active()) { productionController.current = null; setProductionBusy(false); } }
  };
  const verifySaved = async () => {
    if (!production) return; cancelProduction(); setError(""); setProductionBusy(true);
    const controller = new AbortController(), token = productionSerial.current, captured = geometryIdentity.current; productionController.current = controller;
    const check = () => { if (!alive.current || token !== productionSerial.current || geometryIdentity.current.projectId !== captured.projectId || geometryIdentity.current.userId !== captured.userId || geometryIdentity.current.production !== captured.production) throw new DOMException("Geometry recovery context changed.", "AbortError"); };
    try {
      const recovered = await recoverGeometryProduction(production, projectId, controller.signal, check); check();
      if (JSON.stringify(recovered.bound.manifest) !== JSON.stringify(manifest)) throw new Error("Saved manifest differs from the regenerated artifact bindings.");
      setVerified(true); setStreaming(true); setShowViewport(true); setProductionNotice("Retained source and provenance verified. Chunks are hash-checked when streamed.");
    } catch (cause) { if (token === productionSerial.current && alive.current) setError(cause instanceof Error ? cause.message : "Package recovery failed."); }
    finally { if (token === productionSerial.current && alive.current) { productionController.current = null; setProductionBusy(false); } }
  };
  const prepareSave: PrepareWorkspaceSave = async (request, value) => {
    const identity = geometryIdentity.current, sourceGeneration = fileGeneration.current;
    const context = { ...request, assertActive: () => {
      request.assertActive();
      if (fileGeneration.current !== sourceGeneration || geometryIdentity.current.scene !== identity.scene || geometryIdentity.current.production !== identity.production || geometryIdentity.current.sourceLabel !== identity.sourceLabel || geometryIdentity.current.projectId !== identity.projectId || geometryIdentity.current.userId !== identity.userId) throw new Error("Geometry source context changed during preparation.");
    } };
    context.assertActive();
    const captured = inspectWorkspace(value);
    if (!captured.scene) throw new Error("Exact chunk production requires a retained scene.");
    if (captured.production) {
      if (captured.production.sourceRevision !== context.sourceRevision) throw new Error("Generated geometry was captured under another source revision. Reimport the current model and explicitly detach obsolete package references before preparing a replacement.");
      const recovered = await recoverGeometryProduction(captured.production, context.projectId, context.signal, context.assertActive);
      if (JSON.stringify(recovered.bound.manifest) !== JSON.stringify(captured.manifest)) throw new Error("Generated manifest differs from saved bindings.");
      return { payload: value, referencedArtifactIds: geometryProductionReferences(captured.production), uploadedArtifactIds: [] };
    }
    const liveSource = geometryIdentity.current.scene;
    if (!liveSource || JSON.stringify(liveSource) !== JSON.stringify(captured.scene)) throw new Error("Retained scene differs from the captured save inputs.");
    // Capture the owned live scene rather than JSON.parse(draft): generic JSON serialization converts -0 to 0.
    const generated = await produceGeometryChunks(liveSource, { signal: context.signal, context: { label: geometryIdentity.current.sourceLabel, projectId: context.projectId, sourceRevision: context.sourceRevision } });
    await assertGeometrySource(generated, liveSource, context);
    // Reserve room for escaped canonical source JSON and the small package/manifest metadata.
    const upperPayloadBytes = new Blob([JSON.stringify({ ...captured, scene: null, production: { sourceJson: await generated.source.blob.text() } })]).size + 131072;
    if (upperPayloadBytes > MAX_WORKSPACE_BYTES) throw new Error("Generated workspace payload exceeds 64 MiB.");
    const uploaded = await uploadGeometryProduction(generated, context, upperPayloadBytes, context.pendingFileBytes);
    try {
      await assertGeometrySource(generated, liveSource, context);
      return { payload: { ...captured, version: 2, scene: null, manifest: uploaded.bound.manifest, production: uploaded.record }, referencedArtifactIds: uploaded.referencedArtifactIds, uploadedArtifactIds: uploaded.uploadedArtifactIds };
    } catch (cause) { for (const id of uploaded.uploadedArtifactIds) await deleteWorkspaceArtifact(context.projectId, id).catch(() => undefined); throw cause; }
  };
  return <div className="space-y-5">
    <PageIntro eyebrow="Geometry & rendering" title="See the whole picture." description="Bring in your model, inspect geometry, find intersections, and explore rendering. Connect a project to save your work." />
    {!scene && !manifest && <WorkbenchGuide kind="geometry" />}
    <ProjectWorkspacePanel kind="geometry" payload={payload} onRestore={restoreWorkspace} onImportProject={importProject} managedReferencedArtifactIds={managedReferences} prepareSave={prepared || production ? prepareSave : undefined} onPreparedSaved={value => { restoreWorkspace(value); setVerified(true); setProductionNotice("Exact geometry package saved with protected source, chunk and provenance references."); }} />
    <Card className="space-y-3 p-4"><Input label="Geometry scene or streaming manifest (JSON)" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void load(file); }} />
      <p className="text-sm">{scene ? `${scene.meshes.length.toLocaleString()} meshes · ${scene.meshes.reduce((sum, m) => sum + m.indices.length / 3, 0).toLocaleString()} triangles` : manifest ? `${manifest.chunks.length.toLocaleString()} streaming chunks` : "No geometry loaded."}</p>
      <Button variant="outline" disabled={!scene && !manifest} onClick={() => setShowViewport(v => !v)}>{showViewport ? "Close viewport" : "Open viewport"}</Button>
      {showViewport && <StreamingGeometryViewport scene={streaming && verified ? null : scene} manifest={production ? streaming && verified ? manifest : null : manifest} sourceCamera={production ? scene?.camera : undefined} />}
      {scene?.warnings.map((warning, i) => <p className="text-xs text-amber-300" key={i}>{warning}</p>)}
    </Card>
    <Card className="space-y-3 p-4"><h2 className="font-semibold">Exact geometry chunks</h2><p className="text-xs text-slate-400">Prepare bounded whole-mesh partitions from imported visible editor meshes or linked IFC proxies. Saving uploads exact source, chunks and provenance. Original files can be attached separately above. Unsupported oversized meshes fail without simplification.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={!scene || productionBusy || busy || Boolean(production)} onClick={() => { void generate(); }}>Prepare exact chunks</Button>{production && <Button variant="outline" disabled={productionBusy || busy} onClick={() => { void verifySaved(); }}>Verify retained package and stream</Button>}{production && <Button variant="outline" disabled={!verified} onClick={() => { setStreaming(current => !current); setShowViewport(true); }}>{streaming ? "Show retained source" : "Stream verified chunks"}</Button>}{(prepared || production) && <Button variant="ghost" disabled={productionBusy} onClick={() => { clearProduction(); setManifest(null); setShowViewport(false); }}>Discard generated package from inputs</Button>}{productionBusy && <Button variant="danger" onClick={cancelProduction}>Cancel geometry preparation</Button>}</div>
      {production && <p className="text-xs text-slate-400">Captured project {production.projectId} · source revision {production.sourceRevision} · {production.chunks.length} chunks. Discarding keeps source geometry and server history; explicitly detach unwanted package artifacts before a replacement save.</p>}{productionNotice && <p role="status" className="text-xs text-slate-400">{productionNotice}</p>}
    </Card>
    <Card className="space-y-3 p-4"><h2 className="font-semibold">Mesh clashes</h2><Input label="Tolerance (metres)" type="number" min={1e-9} max={0.01} step="any" value={tolerance} onChange={event => { fileGeneration.current++; cancel(); invalidateOutput(); setTolerance(Number(event.target.value)); }} /><Button disabled={!scene || busy} onClick={() => scene && start({ id: 0, operation: "clash", scene, tolerance })}>Check mesh geometry</Button><p className="text-xs text-slate-400">Triangle intersections, coplanar contacts and closed-mesh containment. Partial reports explicitly identify budgets and ambiguous containment.</p></Card>
    <Card className="space-y-3 p-4"><h2 className="font-semibold">Path-traced image</h2><div className="grid grid-cols-2 gap-3 md:grid-cols-5">{(["width", "height", "samples", "bounces", "exposure"] as const).map(key => <Input key={key} label={key} type="number" step={key === "exposure" ? 0.1 : 1} value={settings[key]} onChange={event => changeSettings(key, Number(event.target.value))} />)}</div>
      <Button disabled={!scene || busy} onClick={() => scene && start({ id: 0, operation: "trace", scene, settings })}>Trace image</Button><span className="ml-3 text-sm">{Math.round(progress * 100)}%</span>
      <p className="text-xs text-slate-400">Diffuse indirect illumination, hard sun shadows, mirror and glass materials. Constant linear-RGB materials; texture maps, volumetrics and denoising are outside this renderer. Only a completed PNG is saved with its render report.</p>
      <canvas ref={canvas} className={hasImage ? "max-w-full rounded-xl border border-slate-700" : "hidden"} /><Button variant="outline" disabled={!image || !hasImage || busy} onClick={saveImage}>Download PNG</Button>
    </Card>
    <Card className="space-y-3 p-4 border-indigo-500/20 bg-indigo-950/10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-100 flex items-center gap-2">
            <span>Architectural render studio</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Create styled images from a saved project revision and keep every result alongside your design.
          </p>
        </div>
        <Button
          disabled={!projectId}
          onClick={() => setShowRenderStudio(true)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white shrink-0"
        >
          Open Render Studio
        </Button>
      </div>
      {!projectId && (
        <p className="text-xs text-amber-300">
          Load a project workspace to associate and retain AI render job artifacts.
        </p>
      )}
    </Card>
    {showRenderStudio && projectId && (
      <RenderStudioModal
        projectId={projectId}
        sourceRevision={production?.sourceRevision ?? 0}
        initialSourceImageBase64={image?.dataUrl || null}
        isOpen={showRenderStudio}
        onClose={() => setShowRenderStudio(false)}
      />
    )}
    <Card className="space-y-3 p-4"><h2 className="font-semibold">Performance measurements</h2><p className="text-xs text-slate-400">Explicitly measure a synthetic triangle BVH in a worker. Full editor performance needs representative project data and device measurements.</p>{([10_000, 100_000] as const).map(components => <Button key={components} className="mr-2" variant="outline" disabled={busy} onClick={() => start({ id: 0, operation: "benchmark", components })}>Measure {components.toLocaleString()}</Button>)}</Card>
    {busy && <Button variant="danger" onClick={() => { cancel(); setHasImage(false); setProgress(0); }}>Cancel job</Button>}{error && <p role="alert" className="text-amber-300">{error}</p>}
    {report !== null && <Card className="p-4"><Button variant="outline" onClick={() => download("geometry-report.json", JSON.stringify(report, null, 2), "application/json")}>Download report</Button><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(report, null, 2).slice(0, 150_000)}</pre></Card>}
    <Link className="text-sm text-emerald-300" to="/dashboard">Return to projects</Link>
  </div>;
}
