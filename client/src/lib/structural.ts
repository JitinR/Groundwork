import type { CommunityDesign, StructuralLoadCombination, StructuralSettings, TowerData } from "../types";
import { towerMeters } from "./community";
import { profileFromStructuralSettings } from "./engineering";
import { calculateStructuralScreen } from "./structural-calculations";

export const DEFAULT_STRUCTURAL_SETTINGS: StructuralSettings = {
  enabled: true,
  deadLoadKPa: 5,
  liveLoadKPa: 2,
  concreteStrengthMPa: 25,
  soilBearingKPa: 150,
  columnWidthM: 0.4,
  columnDepthM: 0.4,
  beamWidthM: 0.25,
  beamDepthM: 0.5,
  footingWidthM: 2,
  footingDepthM: 2,
  safetyFactor: 1.5,
  windPressureKPa: 1,
  seismicCoefficient: 0.12,
  material: "reinforced-concrete",
  soilType: "unknown",
  windExposure: "unknown",
  seismicSiteClass: "unknown",
  occupancyCategory: "unknown",
  driftLimitRatio: 1 / 500,
  codeProfileId: "planning-si",
  loadCombinations: [
    { id: "gravity", label: "1.4D", deadFactor: 1.4, liveFactor: 0, windFactor: 0, seismicFactor: 0 },
    { id: "gravity-live", label: "1.2D + 1.6L", deadFactor: 1.2, liveFactor: 1.6, windFactor: 0, seismicFactor: 0 },
    { id: "wind", label: "1.2D + L + W", deadFactor: 1.2, liveFactor: 1, windFactor: 1, seismicFactor: 0 },
    { id: "seismic", label: "1.2D + L + E", deadFactor: 1.2, liveFactor: 1, windFactor: 0, seismicFactor: 1 },
    { id: "uplift-wind", label: "0.9D + W", deadFactor: 0.9, liveFactor: 0, windFactor: 1, seismicFactor: 0 },
  ],
};

export function defaultLoadCombinations(): StructuralLoadCombination[] {
  return DEFAULT_STRUCTURAL_SETTINGS.loadCombinations!.map((combination) => ({ ...combination }));
}

export function structuralSettings(value?: Partial<StructuralSettings>): StructuralSettings {
  const next = { ...DEFAULT_STRUCTURAL_SETTINGS, ...value };
  const input = (value: number, fallback: number, min: number) => Math.max(Number.isFinite(value) ? value : fallback, min);
  return {
    enabled: Boolean(next.enabled),
    deadLoadKPa: input(next.deadLoadKPa, 5, 0),
    liveLoadKPa: input(next.liveLoadKPa, 2, 0),
    concreteStrengthMPa: Math.max(Number(next.concreteStrengthMPa) || 25, 10),
    soilBearingKPa: Math.max(Number(next.soilBearingKPa) || 150, 25),
    columnWidthM: Math.max(Number(next.columnWidthM) || 0.4, 0.15),
    columnDepthM: Math.max(Number(next.columnDepthM) || 0.4, 0.15),
    beamWidthM: Math.max(Number(next.beamWidthM) || 0.25, 0.15),
    beamDepthM: Math.max(Number(next.beamDepthM) || 0.5, 0.2),
    footingWidthM: Math.max(Number(next.footingWidthM) || 2, 0.5),
    footingDepthM: Math.max(Number(next.footingDepthM) || 2, 0.5),
    safetyFactor: Math.max(Number(next.safetyFactor) || 1.5, 1),
    windPressureKPa: Math.max(Number.isFinite(Number(next.windPressureKPa)) ? Number(next.windPressureKPa) : 1, 0),
    seismicCoefficient: Math.max(Number.isFinite(Number(next.seismicCoefficient)) ? Number(next.seismicCoefficient) : 0.12, 0),
    material: next.material ?? "reinforced-concrete",
    soilType: next.soilType ?? "unknown",
    windExposure: next.windExposure ?? "unknown",
    seismicSiteClass: next.seismicSiteClass ?? "unknown",
    occupancyCategory: next.occupancyCategory ?? "unknown",
    codeProfileId: next.codeProfileId ?? "planning-si",
    driftLimitRatio: Math.max(Number(next.driftLimitRatio) || 1 / 500, 1 / 1000),
    loadCombinations: (next.loadCombinations?.length ? next.loadCombinations : defaultLoadCombinations()).map((combination) => ({
      ...combination,
      deadFactor: Number(combination.deadFactor) || 0,
      liveFactor: Number(combination.liveFactor) || 0,
      windFactor: Number(combination.windFactor) || 0,
      seismicFactor: Number(combination.seismicFactor) || 0,
    })),
  };
}

export type StructuralCheck = { status: "pass" | "warning"; text: string };

export interface TowerStructuralResult {
  tower: TowerData;
  areaM2: number;
  heightM: number;
  estimatedLoadKN: number;
  columnCount: number;
  draftedColumnCount: number;
  columnUtilization: number;
  beamSpanM: number;
  beamUtilization: number;
  foundationPressureKPa: number;
  footingAreaM2: number;
  windBaseShearKN: number;
  seismicBaseShearKN: number;
  governingCombination: string;
  governingLoadKN: number;
  lateralUtilization: number;
  driftRatio: number;
  slendernessRatio: number;
  loadPath: string[];
  reinforcementWarning: string;
  connectionWarnings: string[];
  checks: StructuralCheck[];
}

export interface StructuralAnalysis {
  settings: StructuralSettings;
  totalAreaM2: number;
  totalLoadKN: number;
  totalWindBaseShearKN: number;
  totalSeismicBaseShearKN: number;
  loadCombinations: StructuralLoadCombination[];
  results: TowerStructuralResult[];
  warnings: string[];
  assumptions: string[];
}

export function analyzeCommunity(design: CommunityDesign): StructuralAnalysis {
  const settings = structuralSettings(design.structural);
  if (!settings.enabled) {
    return {
      settings,
      totalAreaM2: 0,
      totalLoadKN: 0,
      totalWindBaseShearKN: 0,
      totalSeismicBaseShearKN: 0,
      loadCombinations: settings.loadCombinations ?? [],
      results: [],
      warnings: ["Preliminary screening estimates are disabled.", "Enable screening estimates to calculate planning-level checks."],
      assumptions: structuralAssumptions(settings),
    };
  }

  const structuralDrafts = design.drafts ?? [];
  const draftedElementCount = structuralDrafts.filter((draft) => draft.kind === "wall" || draft.kind === "slab" || draft.kind === "column" || draft.kind === "beam" || draft.kind === "roof").length;
  const gridX = design.structuralGrid?.filter((line) => line.axis === "x").length ?? 0;
  const gridZ = design.structuralGrid?.filter((line) => line.axis === "z").length ?? 0;
  // A drafted occurrence does not establish a load-bearing support or a load path.
  const columnCount = Math.max(4, (gridX + 1) * (gridZ + 1));
  const results = design.towers.map((tower) => {
    const size = towerMeters(tower);
    const areaM2 = size.w * size.d;
    const loadKN = areaM2 * Math.max(tower.floors, 1) * (settings.deadLoadKPa + settings.liveLoadKPa);
    const deadKN = areaM2 * Math.max(tower.floors, 1) * settings.deadLoadKPa;
    const liveKN = areaM2 * Math.max(tower.floors, 1) * settings.liveLoadKPa;
    const draftedColumnCount = structuralDrafts.filter((draft) => draft.kind === "column" && draft.family?.hostId === tower.id).length;
    const columnCapacityKN = settings.concreteStrengthMPa * settings.columnWidthM * settings.columnDepthM * 1000 / settings.safetyFactor;
    const columnUtilization = loadKN / columnCount / columnCapacityKN;
    const beamSpanM = Math.max(size.w / Math.max(gridX, 1), size.d / Math.max(gridZ, 1));
    const beamCapacityKNM = settings.concreteStrengthMPa * settings.beamWidthM * settings.beamDepthM * settings.beamDepthM * 1000 / settings.safetyFactor;
    const beamDemandKNM = (settings.deadLoadKPa + settings.liveLoadKPa) * Math.max(size.w, size.d) * beamSpanM * beamSpanM / 8;
    const beamUtilization = beamDemandKNM / Math.max(beamCapacityKNM, 1);
    const footingAreaM2 = settings.footingWidthM * settings.footingDepthM;
    const foundationPressureKPa = loadKN / (footingAreaM2 * columnCount);
    const windBaseShearKN = settings.windPressureKPa! * size.w * size.h;
    const seismicBaseShearKN = settings.seismicCoefficient! * deadKN;
    const combinations = settings.loadCombinations ?? [];
    const combinationLoads = combinations.map((combination) => ({
      combination,
      loadKN: combination.deadFactor * deadKN + combination.liveFactor * liveKN + combination.windFactor * windBaseShearKN + combination.seismicFactor * seismicBaseShearKN,
    }));
    const governing = combinationLoads.reduce((winner, current) => current.loadKN > winner.loadKN ? current : winner, combinationLoads[0] ?? { combination: { id: "screen", label: "Screen", deadFactor: 1, liveFactor: 1, windFactor: 0, seismicFactor: 0 }, loadKN });
    const lateralDemandKN = Math.max(windBaseShearKN, seismicBaseShearKN);
    const lateralCapacityKN = settings.concreteStrengthMPa * settings.columnWidthM * settings.columnDepthM * columnCount * 0.1 * 1000 / settings.safetyFactor;
    const lateralUtilization = lateralDemandKN / Math.max(lateralCapacityKN, 1);
    const driftRatio = lateralDemandKN * Math.max(size.h, 1) / Math.max(lateralCapacityKN * 100, 1);
    const slendernessRatio = size.h / Math.max(Math.min(settings.columnWidthM, settings.columnDepthM), 0.01);
    const loadPath = ["floor area", "slab/beam diaphragm", "columns or walls", "footings", "soil"];
    const connectionWarnings = [
      ...(design.structuralGrid?.length ? [] : ["Structural grid is not defined; collector and diaphragm connections cannot be coordinated."]),
      "Verify the assumed load path, column-to-beam and foundation connections, and lateral-force-resisting system.",
    ];
    const checks: StructuralCheck[] = [
      { status: governing.loadKN / columnCount / columnCapacityKN <= 1 ? "pass" : "warning", text: `Column screening utilization ${((governing.loadKN / columnCount / columnCapacityKN) * 100).toFixed(0)}% under ${governing.combination.label} using ${columnCount} assumed supports` },
      { status: beamUtilization <= 1 ? "pass" : "warning", text: `Beam screening utilization ${(beamUtilization * 100).toFixed(0)}%` },
      { status: foundationPressureKPa <= settings.soilBearingKPa ? "pass" : "warning", text: `Foundation pressure ${foundationPressureKPa.toFixed(0)} kPa vs ${settings.soilBearingKPa.toFixed(0)} kPa soil input` },
      { status: lateralUtilization <= 1 ? "pass" : "warning", text: `Lateral demand screen ${lateralUtilization.toFixed(2)}x (${lateralDemandKN.toFixed(0)} kN demand)` },
      { status: driftRatio <= settings.driftLimitRatio! ? "pass" : "warning", text: `Drift proxy ${(driftRatio * 100).toFixed(2)}% vs ${(settings.driftLimitRatio! * 100).toFixed(2)}% limit` },
      { status: slendernessRatio <= 40 ? "pass" : "warning", text: `Height/least-column dimension ratio ${slendernessRatio.toFixed(0)}x` },
    ];
    return { tower, areaM2, heightM: size.h, estimatedLoadKN: loadKN, columnCount, draftedColumnCount, columnUtilization, beamSpanM, beamUtilization, foundationPressureKPa, footingAreaM2, windBaseShearKN, seismicBaseShearKN, governingCombination: governing.combination.label, governingLoadKN: governing.loadKN, lateralUtilization, driftRatio, slendernessRatio, loadPath, reinforcementWarning: "Reinforcement quantities, anchorage, development, splice, confinement, and crack control are not designed by this screen.", connectionWarnings, checks };
  });
  return {
    settings,
    totalAreaM2: results.reduce((sum, result) => sum + result.areaM2 * Math.max(result.tower.floors, 1), 0),
    totalLoadKN: results.reduce((sum, result) => sum + result.estimatedLoadKN, 0),
    totalWindBaseShearKN: results.reduce((sum, result) => sum + result.windBaseShearKN, 0),
    totalSeismicBaseShearKN: results.reduce((sum, result) => sum + result.seismicBaseShearKN, 0),
    loadCombinations: settings.loadCombinations ?? [],
    results,
    warnings: [
      "Preliminary screening only: assumptions are simplified and do not represent a structural design.",
      "Wind and seismic results are demand screens, not code-level analysis; confirm hazard, exposure, ductility, irregularity, drift, torsion, and load paths with the engineer of record.",
      ...(settings.soilType === "unknown" ? ["Soil type is unknown; bearing, settlement, liquefaction, lateral resistance, and foundation depth are not established."] : []),
      ...(settings.windExposure === "unknown" ? ["Wind exposure is unknown; pressure is a user-entered planning value, not a site wind study."] : []),
      ...(design.towers.length === 0 ? ["Add at least one tower or block to produce checks."] : []),
      ...(design.structuralGrid?.length ? [] : ["No structural grid is defined; four supports per tower are assumed."]),
      ...(draftedElementCount ? [`${draftedElementCount} drafted structural element${draftedElementCount === 1 ? "" : "s"} present for coordination only. Screening uses the grid-based support assumption.`] : []),
    ],
    assumptions: structuralAssumptions(settings),
  };
}

function structuralAssumptions(settings: StructuralSettings): string[] {
  return [
    `Material: ${settings.material ?? "reinforced-concrete"}; occupancy: ${settings.occupancyCategory ?? "unknown"}.`,
    `Soil: ${settings.soilType ?? "unknown"}; allowable bearing input: ${settings.soilBearingKPa} kPa.`,
    `Wind exposure: ${settings.windExposure ?? "unknown"}; entered pressure: ${settings.windPressureKPa ?? 1} kPa.`,
    `Seismic site class: ${settings.seismicSiteClass ?? "unknown"}; entered coefficient: ${settings.seismicCoefficient ?? 0.12} g.`,
    `Drift proxy limit: ${((settings.driftLimitRatio ?? 1 / 500) * 100).toFixed(2)}%; load path assumes floor diaphragm to vertical elements to isolated footings.`,
  ];
}

export function buildStructuralReport(design: CommunityDesign): string {
  const analysis = analyzeCommunity(design);
  return [
    "PRELIMINARY STRUCTURAL SCREENING REPORT",
    "Not certified engineering, a code compliance check, or sealed design.",
    `Inputs: ${analysis.settings.material}; ${analysis.settings.occupancyCategory} occupancy; ${analysis.settings.soilType} soil; ${analysis.settings.windExposure} wind exposure; seismic class ${analysis.settings.seismicSiteClass}.`,
    `Outputs: ${analysis.results.length} tower(s); ${analysis.totalAreaM2.toFixed(2)} m² floor area; ${analysis.totalLoadKN.toFixed(1)} kN gravity; ${analysis.totalWindBaseShearKN.toFixed(1)} kN wind base shear; ${analysis.totalSeismicBaseShearKN.toFixed(1)} kN seismic base shear.`,
    `Combinations: ${analysis.loadCombinations.map((item) => `${item.label} [D${item.deadFactor}/L${item.liveFactor}/W${item.windFactor}/E${item.seismicFactor}]`).join("; ")}`,
    "Assumptions:", ...analysis.assumptions.map((item) => `- ${item}`),
    "Tower results:", ...analysis.results.map((result) => `- ${result.tower.label}: governing ${result.governingCombination} ${result.governingLoadKN.toFixed(1)} kN; drift proxy ${(result.driftRatio * 100).toFixed(2)}%; slenderness ${result.slendernessRatio.toFixed(1)}; load path ${result.loadPath.join(" > ")}.`),
    "Warnings:", ...analysis.warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

/** Stable JSON-oriented report for validation, export, and downstream tooling. */
export function buildStructuralMachineReport(design: CommunityDesign): StructuralAnalysis & { reportType: "preliminary-structural"; professionalReviewRequired: true } {
  const analysis = analyzeCommunity(design);
  return { ...analysis, reportType: "preliminary-structural", professionalReviewRequired: true };
}

/** Pure calculation entry point for callers that do not have a CommunityDesign. */
export { calculateStructuralScreen };

export function structuralProfile(design: CommunityDesign) {
  return profileFromStructuralSettings(structuralSettings(design.structural));
}

