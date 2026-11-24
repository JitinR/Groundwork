import * as THREE from "three";
import type { MepDesign, MepElement, MepElementKind, MepPoint, MepPlanningInputs, VisualizationSettings } from "../types";
import { material, prismAt, uid } from "./modelcore";
import { calculateMepPlan, mepPressureLosses, mepRouteLength, validateMepInputs } from "./mep-calculations";
import { defaultSystem, electricalPlanningLoads } from "./mepNetwork";
import { engineeringProfile } from "./engineering";
import { familyForMepKind, familyMetadata } from "./families";
import { phaseVisible } from "./visualization";

export const MEP_KINDS: { kind: MepElementKind; label: string; color: string }[] = [
  { kind: "duct", label: "Duct", color: "#f59e0b" },
  { kind: "pipe", label: "Pipe", color: "#38bdf8" },
  { kind: "cable-tray", label: "Cable tray", color: "#a78bfa" },
  { kind: "equipment", label: "Equipment", color: "#f43f5e" },
  { kind: "fixture", label: "Fixture", color: "#34d399" },
];

export function defaultMep(): MepDesign { return { version: 1, enabled: true, elements: [] }; }

export const DEFAULT_MEP_PLANNING: MepPlanningInputs = {
  areaM2: 20,
  ceilingHeightM: 2.7,
  occupancy: 4,
  airChangesPerHour: 6,
  coolingLoadWPerM2: 100,
  designAirVelocityMps: 5,
  pipeVelocityMps: 1.5,
  plumbingFlowLps: 2,
  minimumClearanceM: 0.2,
  electricalDemandFactor: 0.8,
  designPressurePa: 300,
  designVoltageV: 230,
};

export function normalizeMep(value: MepDesign | undefined): MepDesign {
  const base = defaultMep();
  const elements = value?.elements ?? [];
  return value ? { ...base, ...value, elements: elements.map((element) => ({ ...element, system: defaultSystem(element), connectedTo: element.connectedTo ?? [] })), zones: value.zones ?? [], planning: { ...DEFAULT_MEP_PLANNING, ...value.planning } } : { ...base, planning: { ...DEFAULT_MEP_PLANNING }, zones: [] };
}

export interface MepPlanningSummary {
  airflowM3h: number;
  airflowLps: number;
  coolingLoadKw: number;
  ductAreaM2: number;
  ductCapacityM3h: number;
  connectedLoadKw: number;
  demandLoadKw: number;
  ductLengthM: number;
  pipeLengthM: number;
  pipeCapacityLps: number;
  connectedSystems: number;
  ductPressureLossPa: number;
  pipePressureLossPa: number;
  connectivityWarnings: string[];
  warnings: string[];
}

export function mepPlanningSummary(value: MepDesign | undefined): MepPlanningSummary {
  const mep = normalizeMep(value); const p = mep.planning ?? DEFAULT_MEP_PLANNING;
  const volume = Math.max(p.areaM2, 0) * Math.max(p.ceilingHeightM, 0);
  const airflowM3h = volume * Math.max(p.airChangesPerHour, 0);
  const ductElements = mep.elements.filter((element) => element.kind === "duct");
  const pipeElements = mep.elements.filter((element) => element.kind === "pipe");
  const ductAreaM2 = ductElements.reduce((sum, element) => sum + Math.max(element.width, 0) * Math.max(element.height, 0), 0);
  const ductCapacityM3h = ductAreaM2 * Math.max(p.designAirVelocityMps, 0) * 3600;
  const pipeCapacityLps = pipeElements.reduce((sum, element) => sum + Math.PI * Math.pow(Math.max(element.diameter, 0), 2) / 4 * Math.max(p.pipeVelocityMps, 0) * 1000, 0);
  const electricalElements = mep.elements.filter((element) => defaultSystem(element) === "electrical-power");
  const { connectedKw: connectedLoadKw, demandKw: demandLoadKw } = electricalPlanningLoads(electricalElements, p.electricalDemandFactor);
  const warnings: string[] = [];
  const connectivityWarnings: string[] = [];
  const elementIds = new Set(mep.elements.map((element) => element.id));
  const connectedSystems = mep.elements.filter((element) => element.connectedTo?.some((id) => elementIds.has(id))).length;
  const ductLengthM = ductElements.reduce((sum, element) => sum + mepRouteLength(element), 0);
  const pipeLengthM = pipeElements.reduce((sum, element) => sum + mepRouteLength(element), 0);
  const pressureLosses = mepPressureLosses(ductLengthM, pipeLengthM, p);
  if (ductElements.length === 0) warnings.push("No duct routes are modeled for the estimated HVAC airflow.");
  else if (ductCapacityM3h < airflowM3h) warnings.push(`Duct cross-section screens below target airflow (${Math.round(ductCapacityM3h).toLocaleString()} vs ${Math.round(airflowM3h).toLocaleString()} m³/h).`);
  if (pipeElements.length > 0 && pipeCapacityLps < Math.max(p.plumbingFlowLps, 0)) warnings.push(`Pipe capacity screens below target flow (${pipeCapacityLps.toFixed(1)} vs ${p.plumbingFlowLps.toFixed(1)} L/s).`);
  for (const element of pipeElements) if (element.diameter < 0.05) warnings.push(`${element.name} is below the 50 mm preliminary pipe diameter screen.`);
  for (const element of mep.elements.filter((item) => item.route.length > 0)) {
    const lowestClearance = Math.min(...element.route.map((point) => p.ceilingHeightM - point.y - (element.kind === "duct" ? element.height : element.diameter) / 2));
    if (lowestClearance < p.minimumClearanceM) warnings.push(`${element.name} has about ${Math.max(lowestClearance, 0).toFixed(2)} m ceiling clearance, below the ${p.minimumClearanceM.toFixed(2)} m planning minimum.`);
  }
  if (connectedLoadKw > 0 && demandLoadKw < connectedLoadKw * 0.5) warnings.push("Demand factor is below 50%; confirm diversity assumptions with the electrical engineer.");
  if (electricalElements.some((element) => (element.kind === "equipment" || element.kind === "fixture") && element.ratedPowerKw === undefined)) warnings.push("Some electrical equipment or fixtures have no rated power. Enter their loads to complete the demand screen.");
  if (pressureLosses.ductPressureLossPa > (p.designPressurePa ?? 300)) warnings.push(`Estimated duct pressure loss ${pressureLosses.ductPressureLossPa.toFixed(0)} Pa exceeds the ${p.designPressurePa ?? 300} Pa duct planning allowance.`);
  for (const element of mep.elements) {
    if (element.route.length > 1 && !element.connectedTo?.length) connectivityWarnings.push(`${element.name} has no explicit system connection; verify source, terminal, and flow direction.`);
    if ((element.supportSpacingM ?? 0) <= 0 && ["duct", "pipe", "cable-tray"].includes(element.kind)) warnings.push(`${element.name} has no support spacing input; seismic restraint and hanger design are not screened.`);
    if (element.system === "fire-protection" && element.kind !== "pipe") warnings.push(`${element.name} is typed as fire protection but is not a pipe; verify fire system modeling.`);
  }
  if (mep.zones?.length === 0 && mep.elements.length) connectivityWarnings.push("No typed zones are defined; airflow and electrical demand are applied to the whole planning area.");
  return { airflowM3h, airflowLps: airflowM3h / 3.6, coolingLoadKw: Math.max(p.areaM2, 0) * Math.max(p.coolingLoadWPerM2, 0) / 1000, ductAreaM2, ductCapacityM3h, connectedLoadKw, demandLoadKw, ductLengthM, pipeLengthM, pipeCapacityLps, connectedSystems, ...pressureLosses, connectivityWarnings, warnings };
}

export function buildMepReport(value: MepDesign | undefined): string {
  const mep = normalizeMep(value); const p = mep.planning!; const s = mepPlanningSummary(mep);
  return [
    "PRELIMINARY MEP PLANNING REPORT",
    "Not code-compliant, for coordination only; verify with licensed discipline engineers.",
    "",
    `Inputs: ${p.areaM2} m² area | ${p.ceilingHeightM} m ceiling | ${p.occupancy} occupants | ${p.airChangesPerHour} ACH | ${p.designVoltageV ?? 230} V`,
    `HVAC: ${s.airflowM3h.toFixed(0)} m³/h (${s.airflowLps.toFixed(0)} L/s) airflow | ${s.coolingLoadKw.toFixed(2)} kW cooling screen`,
    `Ducts: ${s.ductLengthM.toFixed(1)} m modeled | ${s.ductAreaM2.toFixed(3)} m² section | ${s.ductCapacityM3h.toFixed(0)} m³/h capacity | ${s.ductPressureLossPa.toFixed(0)} Pa route loss screen`,
    `Pipes: ${s.pipeLengthM.toFixed(1)} m modeled | ${s.pipeCapacityLps.toFixed(1)} L/s capacity | ${s.pipePressureLossPa.toFixed(0)} Pa route loss screen`,
    `Electrical: ${s.connectedLoadKw.toFixed(2)} kW connected | ${s.demandLoadKw.toFixed(2)} kW demand screen`,
    `Connectivity: ${s.connectedSystems} explicitly connected element(s) across ${(mep.zones ?? []).length} typed zone(s).`,
    "",
    "Warnings:",
    ...(s.warnings.length ? s.warnings.map((warning) => `- ${warning}`) : ["- None from these preliminary screens."]),
    ...s.connectivityWarnings.map((warning) => `- Connectivity: ${warning}`),
    "",
    "Clash envelopes use axis-aligned route bounds and conservative section sizes; they are approximations, not rotated segment solids or code clearances.",
    "Confirm equipment schedules, diversity, velocities, pressure loss, pipe sizing, voltage/drop, fault current, access, fire/life safety, supports, local codes, and construction clearances before use.",
  ].join("\n");
}

/** Machine-readable companion to the legacy text report. */
export function buildMepMachineReport(value: MepDesign | undefined) {
  const mep = normalizeMep(value);
  return { ...calculateMepPlan(mep, engineeringProfile()), reportType: "preliminary-mep" as const, professionalReviewRequired: true as const, validationErrors: validateMepInputs(mep) };
}

/** Pure planning calculation export for tests and non-UI consumers. */
export { calculateMepPlan, validateMepInputs };

export function makeMepElement(kind: MepElementKind, index = 0): MepElement {
  const option = MEP_KINDS.find((item) => item.kind === kind) ?? MEP_KINDS[0];
  const route: MepPoint[] = [{ x: -2, y: kind === "fixture" ? 2.4 : 2.7, z: index * 0.8 }, { x: 2, y: kind === "fixture" ? 2.4 : 2.7, z: index * 0.8 }];
  const family = familyForMepKind(kind)[0];
  return { id: uid("mep"), kind, name: `${option.label} ${index + 1}`, route, width: kind === "duct" ? 0.45 : 0.2, height: kind === "duct" ? 0.3 : 0.2, diameter: 0.15, color: option.color, visible: true, system: defaultSystem({ kind }), connectedTo: [], family: family ? familyMetadata(family) : undefined };
}

function bounds(element: MepElement) {
  const xs = element.route.map((p) => p.x); const ys = element.route.map((p) => p.y); const zs = element.route.map((p) => p.z);
  return { minX: Math.min(...xs) - element.width / 2, maxX: Math.max(...xs) + element.width / 2, minY: Math.min(...ys) - element.height / 2, maxY: Math.max(...ys) + element.height / 2, minZ: Math.min(...zs) - element.width / 2, maxZ: Math.max(...zs) + element.width / 2 };
}

export function mepClashWarnings(mep: MepDesign | undefined): string[] {
  const elements = normalizeMep(mep).elements.filter((element) => element.visible && element.route.length > 0);
  const warnings: string[] = [];
  for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
    const a = bounds(elements[i]); const b = bounds(elements[j]);
    if (a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ) warnings.push(`${elements[i].name} overlaps ${elements[j].name}`);
  }
  return warnings;
}

function segment(g: THREE.Group, a: MepPoint, b: MepPoint, radius: number, color: string) {
  const start = new THREE.Vector3(a.x, a.y, a.z); const end = new THREE.Vector3(b.x, b.y, b.z);
  const delta = end.clone().sub(start); const length = delta.length();
  if (length < 0.01) return;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material(color, { rough: 0.45, metal: 0.15 }));
  mesh.position.copy(start.clone().add(end).multiplyScalar(0.5)); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); mesh.userData.noSelect = true; g.add(mesh);
}

export function buildMepScene(mep: MepDesign | undefined, visualization?: VisualizationSettings): THREE.Group {
  const g = new THREE.Group(); const data = normalizeMep(mep);
  if (!data.enabled) return g;
  for (const element of data.elements) {
    if (!element.visible || element.route.length === 0) continue;
    const item = new THREE.Group(); item.userData.selectId = element.id; item.userData.selectKind = "mep";
    item.userData.phaseId = element.phaseId;
    item.visible = !visualization || phaseVisible(element.phaseId, visualization);
    if (element.kind === "equipment" || element.kind === "fixture") {
      const p = element.route[0]; const body = prismAt(p.x, p.y, p.z, Math.max(element.width, 0.2), Math.max(element.height, 0.2), Math.max(element.diameter, element.width, 0.2), material(element.color)); item.add(body);
    } else for (let i = 1; i < element.route.length; i++) segment(item, element.route[i - 1], element.route[i], element.kind === "duct" ? Math.min(element.width, element.height) / 2 : element.diameter / 2, element.color);
    g.add(item);
  }
  return g;
}

