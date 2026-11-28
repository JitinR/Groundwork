import type { CommunityDesign, StructuralLoadCombination } from "../types";
import { structuralSettings } from "./structural";
import { engineeringExchangeProvenance } from "./exchangeProvenance";
import type { EngineeringDesignBasis } from "./engineeringBasis";
import { resolveDraft } from "./parametric";

export type StructuralNodeKind = "grid-intersection" | "column-base" | "column-top";
export type StructuralMemberKind = "column" | "beam" | "brace" | "wall" | "slab";

export interface StructuralNode {
  id: string;
  x: number;
  y: number;
  z: number;
  kind: StructuralNodeKind;
}

export interface StructuralMember {
  id: string;
  kind: StructuralMemberKind;
  startNodeId: string;
  endNodeId?: string;
  levelId?: string;
  widthM: number;
  depthM: number;
  lengthM: number;
  sourceId?: string;
  tributaryWidthM?: number;
}

export interface StructuralFrameModel {
  nodes: StructuralNode[];
  members: StructuralMember[];
  levels: { id: string; elevationM: number; heightM: number }[];
  warnings: string[];
}

export interface MemberDesignScreen {
  memberId: string;
  kind: StructuralMemberKind;
  demandKN: number;
  capacityKN: number;
  utilization: number;
  status: "pass" | "review";
  reinforcementRatio?: number;
  demandKNm?: number;
  capacityKNm?: number;
}

export interface FoundationDesignScreen {
  columnId: string;
  demandKN: number;
  requiredAreaM2: number;
  providedAreaM2: number;
  bearingUtilization: number;
  suggestedWidthM: number;
  status: "pass" | "review";
}

export interface StructuralDesignPackage {
  frame: StructuralFrameModel;
  combinations: StructuralLoadCombination[];
  members: MemberDesignScreen[];
  foundations: FoundationDesignScreen[];
  governingUtilization: number;
  warnings: string[];
  verification: {
    externalSolverRequired: true;
    supportedTargets: string[];
    status: "not-verified";
  };
}

export function buildStructuralFrameModel(design: CommunityDesign): StructuralFrameModel {
  const buildingLevels = design.levels?.length ? design.levels : [{ id: "ground", name: "Ground", elevation: 0, floorHeight: 3.2 }];
  const levels = buildingLevels.map((level) => ({ id: level.id, elevationM: level.elevation, heightM: level.floorHeight }));
  const nodes: StructuralNode[] = [];
  const members: StructuralMember[] = [];
  const warnings: string[] = [];
  const authoredBeamSpans = new Set<string>();
  const spanKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
  const nodeIndex = new Map<string, StructuralNode>();
  const addNode = (node: StructuralNode) => {
    const key = [node.x, node.y, node.z].map(value => Math.round(value * 10000)).join("|");
    const existing = nodeIndex.get(key);
    if (existing) return existing;
    nodeIndex.set(key, node);
    nodes.push(node);
    return node;
  };

  const gridsX = design.structuralGrid?.filter((line) => line.axis === "x") ?? [];
  const gridsZ = design.structuralGrid?.filter((line) => line.axis === "z") ?? [];
  for (const level of levels) for (const gx of gridsX) for (const gz of gridsZ) {
    addNode({ id: `grid_${level.id}_${gx.id}_${gz.id}`, x: gx.position, y: level.elevationM, z: gz.position, kind: "grid-intersection" });
  }

  const settings = structuralSettings(design.structural);
  for (const draft of design.drafts ?? []) {
    if (draft.kind !== "column" && draft.kind !== "beam" && draft.kind !== "wall" && draft.kind !== "slab") continue;
    const level = levels.find((item) => item.id === draft.family?.levelId) ?? levels[0];
    const { elevation, height, width, depth } = resolveDraft(draft, buildingLevels);
    if (draft.kind === "column") {
      const base = addNode({ id: `${draft.id}_base`, x: draft.x, y: elevation, z: draft.z, kind: "column-base" });
      const top = addNode({ id: `${draft.id}_top`, x: draft.x, y: base.y + height, z: draft.z, kind: "column-top" });
      members.push({ id: draft.id, kind: "column", startNodeId: base.id, endNodeId: top.id, levelId: level.id, widthM: width, depthM: depth, lengthM: height, sourceId: draft.id });
    } else {
      const angle = draft.rotationDeg * Math.PI / 180;
      const dx = Math.cos(angle) * width / 2, dz = -Math.sin(angle) * width / 2;
      const start = addNode({ id: `${draft.id}_start`, x: draft.x - dx, y: elevation, z: draft.z - dz, kind: "grid-intersection" });
      const end = addNode({ id: `${draft.id}_end`, x: draft.x + dx, y: start.y, z: draft.z + dz, kind: "grid-intersection" });
      if (draft.kind === "beam") authoredBeamSpans.add(spanKey(start.id, end.id));
      const sectionWidth = draft.kind === "wall" ? width : depth;
      const sectionDepth = draft.kind === "wall" ? depth : height;
      members.push({ id: draft.id, kind: draft.kind, startNodeId: start.id, endNodeId: end.id, levelId: level.id, widthM: sectionWidth, depthM: sectionDepth, lengthM: width, sourceId: draft.id, tributaryWidthM: depth });
    }
  }

  if (!members.some((item) => item.kind === "column") && gridsX.length && gridsZ.length) {
    for (const level of levels) {
      for (const gx of gridsX) for (const gz of gridsZ) {
        const base = addNode({ id: `auto_${level.id}_${gx.id}_${gz.id}_base`, x: gx.position, y: level.elevationM, z: gz.position, kind: "column-base" });
        const top = addNode({ id: `auto_${level.id}_${gx.id}_${gz.id}_top`, x: gx.position, y: level.elevationM + level.heightM, z: gz.position, kind: "column-top" });
        members.push({ id: `auto-col-${level.id}-${gx.id}-${gz.id}`, kind: "column", startNodeId: base.id, endNodeId: top.id, levelId: level.id, widthM: settings.columnWidthM, depthM: settings.columnDepthM, lengthM: level.heightM });
      }
    }
    warnings.push("Columns were inferred from structural-grid intersections because no explicit drafted columns were found.");
  }
  if (gridsX.length && gridsZ.length) {
    const memberCount = members.length;
    const xs = [...gridsX].sort((a, b) => a.position - b.position), zs = [...gridsZ].sort((a, b) => a.position - b.position);
    const tributary = (lines: { position: number }[], index: number) => {
      const left = index > 0 ? lines[index].position - lines[index - 1].position : 0;
      const right = index + 1 < lines.length ? lines[index + 1].position - lines[index].position : 0;
      return Math.max((left + right) / 2, 0.5);
    };
    for (const level of levels) {
      const y = level.elevationM + level.heightM;
      const addBeam = (id: string, x1: number, z1: number, x2: number, z2: number, tributaryWidthM: number) => {
        const lengthM = Math.hypot(x2 - x1, z2 - z1);
        if (lengthM < 1e-6) return;
        const a = addNode({ id: `${id}_a`, x: x1, y, z: z1, kind: "grid-intersection" });
        const b = addNode({ id: `${id}_b`, x: x2, y, z: z2, kind: "grid-intersection" });
        if (authoredBeamSpans.has(spanKey(a.id, b.id))) return;
        members.push({ id, kind: "beam", startNodeId: a.id, endNodeId: b.id, levelId: level.id, widthM: settings.beamWidthM, depthM: settings.beamDepthM, lengthM, tributaryWidthM });
      };
      for (const [index, z] of zs.entries()) for (let i = 1; i < xs.length; i++) addBeam(`beam-x-${level.id}-${xs[i - 1].id}-${xs[i].id}-${z.id}`, xs[i - 1].position, z.position, xs[i].position, z.position, tributary(zs, index));
      for (const [index, x] of xs.entries()) for (let i = 1; i < zs.length; i++) addBeam(`beam-z-${level.id}-${zs[i - 1].id}-${zs[i].id}-${x.id}`, x.position, zs[i - 1].position, x.position, zs[i].position, tributary(xs, index));
    }
    if (members.length > memberCount) warnings.push("Grid beams are inferred; joint connectivity, releases and tributary loading require engineer verification.");
  }
  if (!members.length) warnings.push("No structural framing geometry is available. Add grid lines or drafted structural elements.");
  return { nodes, members, levels, warnings };
}

export function screenStructuralDesign(design: CommunityDesign): StructuralDesignPackage {
  const settings = structuralSettings(design.structural);
  const frame = buildStructuralFrameModel(design);
  const combinations = settings.loadCombinations ?? [];
  const towerFloorArea = design.towers.reduce((sum, tower) => sum + tower.unitWidth * tower.unitDepth * Math.max(tower.unitsPerFloor, 1) * Math.max(tower.floors, 1), 0);
  const dead = towerFloorArea * settings.deadLoadKPa;
  const live = towerFloorArea * settings.liveLoadKPa;
  const governing = Math.max(dead + live, ...combinations.map((combo) => combo.deadFactor * dead + combo.liveFactor * live));
  const columns = frame.members.filter((member) => member.kind === "column");
  const nodeById = new Map(frame.nodes.map(node => [node.id, node]));
  const lowestBase = columns.reduce((low, column) => Math.min(low, nodeById.get(column.startNodeId)?.y ?? Infinity), Infinity);
  const baseColumns = columns.filter(column => Math.abs((nodeById.get(column.startNodeId)?.y ?? Infinity) - lowestBase) < 1e-4);
  const columnDemand = governing / Math.max(baseColumns.length, 1);
  const orderedLevels = [...frame.levels].sort((a, b) => a.elevationM - b.elevationM);
  const storyCounts = new Map<string | undefined, number>();
  for (const column of columns) storyCounts.set(column.levelId, (storyCounts.get(column.levelId) ?? 0) + 1);
  const demandFor = (column: StructuralMember) => {
    const levelIndex = Math.max(0, orderedLevels.findIndex(level => level.id === column.levelId));
    const storyColumns = storyCounts.get(column.levelId) ?? 1;
    return governing * (orderedLevels.length - levelIndex) / Math.max(orderedLevels.length, 1) / Math.max(storyColumns, 1);
  };

  const members = frame.members.map((member): MemberDesignScreen => {
    const area = Math.max(member.widthM * member.depthM, 0.001);
    const lengthFactor = Math.max(member.lengthM / 3, 1);
    const demandKN = member.kind === "column" ? demandFor(member) : (settings.deadLoadKPa + settings.liveLoadKPa) * Math.max(member.lengthM, 0.5) * Math.max(member.tributaryWidthM ?? member.widthM, 0.5);
    const materialStrength = settings.material === "steel" ? 250 : settings.material === "masonry" ? 8 : settings.concreteStrengthMPa;
    const flexural = member.kind === "beam" || member.kind === "slab";
    const demandKNm = flexural ? demandKN * member.lengthM / 8 : undefined;
    const capacityKNm = flexural ? materialStrength * member.widthM * member.depthM ** 2 * 1000 / Math.max(6 * settings.safetyFactor, 1) : undefined;
    const capacityKN = !flexural
      ? materialStrength * area * 1000 / settings.safetyFactor / lengthFactor
      : (capacityKNm ?? 0) * 8 / Math.max(member.lengthM, 0.01);
    const utilization = demandKN / Math.max(capacityKN, 0.001);
    const reinforcementRatio = settings.material === "reinforced-concrete" ? Math.min(Math.max(0.008 + Math.max(utilization - 0.5, 0) * 0.012, 0.008), 0.04) : undefined;
    return { memberId: member.id, kind: member.kind, demandKN, capacityKN, demandKNm, capacityKNm, utilization, reinforcementRatio, status: utilization <= 1 ? "pass" : "review" };
  });

  const foundations = baseColumns.map((column): FoundationDesignScreen => {
    const requiredAreaM2 = columnDemand / Math.max(settings.soilBearingKPa, 1);
    const providedAreaM2 = settings.footingWidthM * settings.footingDepthM;
    const bearingUtilization = requiredAreaM2 / Math.max(providedAreaM2, 0.001);
    return {
      columnId: column.id,
      demandKN: columnDemand,
      requiredAreaM2,
      providedAreaM2,
      bearingUtilization,
      suggestedWidthM: Math.sqrt(requiredAreaM2),
      status: bearingUtilization <= 1 ? "pass" : "review",
    };
  });

  const governingUtilization = Math.max(0, ...members.map((item) => item.utilization), ...foundations.map((item) => item.bearingUtilization));
  return {
    frame,
    combinations,
    members,
    foundations,
    governingUtilization,
    warnings: [
      ...frame.warnings,
      "Member and foundation results are deterministic screening calculations, not code design.",
      "Gravity load is distributed equally across stories and columns. Tributary areas and load paths are not solved.",
      "P-delta, response-spectrum, nonlinear behavior, reinforcement detailing and connections require verification in a qualified structural solver.",
    ],
    verification: { externalSolverRequired: true, supportedTargets: ["OpenSees", "ETABS", "STAAD", "Robot"], status: "not-verified" },
  };
}

function canonicalStructuralValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStructuralValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStructuralValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null) ?? "null";
}

/** Deterministic model/load identity for accidental stale-result detection; not an authenticity signature. */
export function structuralModelFingerprint(design: CommunityDesign, pkg = screenStructuralDesign(design)): string {
  const sort = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const settings = structuralSettings(design.structural);
  const source = canonicalStructuralValue({
    fingerprintVersion: 1,
    units: "SI",
    supportPolicy: "lowest-column-bases-assumed-fixed",
    nodes: sort(pkg.frame.nodes), members: sort(pkg.frame.members), levels: sort(pkg.frame.levels),
    combinations: sort(pkg.combinations),
    assumptions: { ...settings, loadCombinations: sort(settings.loadCombinations ?? []) },
    towerLoadSource: sort(design.towers.map(tower => ({ id: tower.id, width: tower.unitWidth, depth: tower.unitDepth, floors: tower.floors, unitsPerFloor: tower.unitsPerFloor, floorHeight: tower.floorHeight }))),
  });
  const mask = 0xffffffffffffffffn;
  let a = 0xcbf29ce484222325n, b = 0x84222325cbf29ce4n;
  for (let i = 0; i < source.length; i += 1) {
    const code = BigInt(source.charCodeAt(i));
    a = ((a ^ code) * 0x100000001b3n) & mask;
    b = ((b ^ code) * 0x9e3779b185ebca87n) & mask;
  }
  return `gw-structural-v1-${a.toString(16).padStart(16, "0")}${b.toString(16).padStart(16, "0")}`;
}

export function buildStructuralSolverExchange(design: CommunityDesign, designBasis?: EngineeringDesignBasis): string {
  const pkg = screenStructuralDesign(design);
  const columns = pkg.frame.members.filter(member => member.kind === "column");
  const byId = new Map(pkg.frame.nodes.map(node => [node.id, node]));
  const low = columns.reduce((min, column) => Math.min(min, byId.get(column.startNodeId)?.y ?? Infinity), Infinity);
  const supportNodes = [...new Set(columns.filter(column => Math.abs((byId.get(column.startNodeId)?.y ?? Infinity) - low) < 1e-4).map(column => column.startNodeId))];
  return JSON.stringify({
    format: "groundwork-structural-analysis-model",
    engineeringProvenance: engineeringExchangeProvenance(designBasis),
    version: 1,
    modelFingerprint: structuralModelFingerprint(design, pkg),
    resultsSchema: { format: "groundwork-structural-results", version: 1, units: { length: "m", force: "kN", moment: "kN*m", rotation: "rad" }, axes: "global-y-up", forceConvention: "compression-positive" },
    units: "SI",
    nodes: pkg.frame.nodes,
    members: pkg.frame.members,
    supportNodes: supportNodes.map(nodeId => ({ nodeId, assumedRestraint: "fixed", requiresVerification: true })),
    memberScreens: pkg.members,
    foundationScreens: pkg.foundations,
    warnings: pkg.warnings,
    formatScope: "Generic SI JSON. Native solver input adapters are not included.",
    loadCombinations: pkg.combinations,
    assumptions: structuralSettings(design.structural),
    verification: pkg.verification,
  }, null, 2);
}

