import type {
  AmenityData,
  BuildingLevel,
  BuildingBranch,
  CommercialStyle,
  CommunityDesign,
  InteriorRoom,
  LandSite,
  TowerData,
  UndergroundParking,
  UnitSystem,
} from "../types";
import { defaultTerrain } from "./terrain";
import { DEFAULT_STRUCTURAL_SETTINGS } from "./structural";
import { uid } from "./modelcore";

/* ------------------------------ Unit conversions ------------------------------ */

const UNIT_METERS: Record<UnitSystem, number> = { m: 1, yd: 0.9144, ft: 0.3048 };

export function toMeters(value: number, unit: UnitSystem): number {
  return value * UNIT_METERS[unit];
}

export function metersTo(value: number, unit: UnitSystem): number {
  return value / UNIT_METERS[unit];
}

export function landMeters(land: LandSite): { w: number; d: number } {
  return { w: toMeters(Math.max(land.width, 1), land.unit), d: toMeters(Math.max(land.depth, 1), land.unit) };
}

export function landAreaSqYards(land: LandSite): number {
  const { w, d } = landMeters(land);
  return (w * d) / (0.9144 * 0.9144);
}

export const UNIT_LABELS: Record<UnitSystem, string> = { m: "meters", yd: "yards", ft: "feet" };

/* ------------------------------- Amenity catalog ------------------------------- */

export type AmenityShape = "court" | "pool" | "green" | "track" | "steps" | "box" | "sand" | "kids" | "circle";

export interface AmenityKind {
  kind: string;
  label: string;
  defW: number;
  defD: number;
  defH: number;
  color: string;
  shape: AmenityShape;
  /** Optional audience filter. Absent = available in every project branch. */
  branch?: BuildingBranch;
}

export const AMENITIES: AmenityKind[] = [
  /* Shared */
  { kind: "gate", label: "Gate", defW: 5, defD: 1, defH: 3.2, color: "#455a64", shape: "box" },
  { kind: "pillar", label: "Pillar", defW: 0.6, defD: 0.6, defH: 3, color: "#78909c", shape: "box" },
  { kind: "boundary-wall", label: "Boundary wall", defW: 12, defD: 0.3, defH: 2.4, color: "#90a4ae", shape: "box" },
  { kind: "rectangle-platform", label: "Rectangle platform", defW: 12, defD: 8, defH: 0.2, color: "#78909c", shape: "box" },
  { kind: "circle-platform", label: "Circle platform", defW: 8, defD: 8, defH: 0.2, color: "#78909c", shape: "circle" },
  { kind: "spa", label: "Spa", defW: 18, defD: 12, defH: 3.5, color: "#8d6e63", shape: "box", branch: "residential" },
  { kind: "massage-parlor", label: "Massage parlor", defW: 12, defD: 8, defH: 3.2, color: "#a1887f", shape: "box", branch: "residential" },
  { kind: "open-air-theatre", label: "Open-air theatre", defW: 22, defD: 18, defH: 4, color: "#8b7d6b", shape: "steps" },
  { kind: "amphitheatre", label: "Amphitheatre", defW: 26, defD: 20, defH: 5, color: "#a3907a", shape: "steps" },
  /* Residential communities */
  { kind: "cycling-track", label: "Cycling track", defW: 80, defD: 40, defH: 0.15, color: "#455a64", shape: "track", branch: "residential" },
  { kind: "running-track", label: "Running track", defW: 120, defD: 60, defH: 0.15, color: "#b45309", shape: "track", branch: "residential" },
  { kind: "swimming-pool", label: "Swimming pool", defW: 25, defD: 12.5, defH: 1.6, color: "#2196f3", shape: "pool", branch: "residential" },
  { kind: "basketball", label: "Basketball court", defW: 28, defD: 15, defH: 0.1, color: "#ff8a65", shape: "court", branch: "residential" },
  { kind: "tennis", label: "Tennis court", defW: 23.77, defD: 10.97, defH: 0.1, color: "#4caf50", shape: "court", branch: "residential" },
  { kind: "pickleball", label: "Pickleball court", defW: 13.41, defD: 6.1, defH: 0.1, color: "#00bcd4", shape: "court", branch: "residential" },
  { kind: "volleyball", label: "Volleyball court", defW: 18, defD: 9, defH: 0.1, color: "#9e9d24", shape: "court", branch: "residential" },
  { kind: "sand-volleyball", label: "Sand volleyball", defW: 16, defD: 8, defH: 0.4, color: "#d7b98a", shape: "sand", branch: "residential" },
  { kind: "cricket-nets", label: "Cricket nets", defW: 20, defD: 4, defH: 4, color: "#5d4037", shape: "court", branch: "residential" },
  { kind: "practice-zones", label: "Cricket practice zones", defW: 30, defD: 20, defH: 0.1, color: "#8d6e63", shape: "green", branch: "residential" },
  { kind: "squash", label: "Squash courts", defW: 9.75, defD: 6.4, defH: 5.6, color: "#7986cb", shape: "box", branch: "residential" },
  { kind: "badminton-indoor", label: "Indoor badminton", defW: 13.4, defD: 6.1, defH: 3, color: "#7e57c2", shape: "box", branch: "residential" },
  { kind: "badminton-outdoor", label: "Outdoor badminton", defW: 13.4, defD: 6.1, defH: 0.1, color: "#26a69a", shape: "court", branch: "residential" },
  { kind: "kids-play", label: "Kids play area", defW: 16, defD: 16, defH: 1.2, color: "#f06292", shape: "kids", branch: "residential" },
  { kind: "sand-park", label: "Sand park", defW: 12, defD: 12, defH: 0.5, color: "#c5b28b", shape: "sand", branch: "residential" },
  { kind: "lawn", label: "Lawn", defW: 30, defD: 20, defH: 0.1, color: "#66bb6a", shape: "green", branch: "residential" },
  { kind: "garden", label: "Community garden", defW: 24, defD: 16, defH: 0.2, color: "#2e7d32", shape: "green", branch: "residential" },
  { kind: "clubhouse", label: "Clubhouse", defW: 20, defD: 15, defH: 4.5, color: "#546e7a", shape: "box", branch: "residential" },
  { kind: "gym", label: "Gym", defW: 20, defD: 12, defH: 3.5, color: "#37474f", shape: "box", branch: "residential" },
  { kind: "yoga", label: "Yoga deck", defW: 12, defD: 12, defH: 0.2, color: "#aed581", shape: "green", branch: "residential" },
  { kind: "jogging-path", label: "Jogging path", defW: 60, defD: 30, defH: 0.1, color: "#78909c", shape: "track", branch: "residential" },
  { kind: "walking-path", label: "Walking path", defW: 50, defD: 4, defH: 0.1, color: "#90a4ae", shape: "track", branch: "residential" },
  /* Commercial / workplace campuses */
  { kind: "urban-plaza", label: "Urban plaza", defW: 30, defD: 22, defH: 0.15, color: "#78909c", shape: "court", branch: "commercial" },
  { kind: "fountain", label: "Fountain", defW: 6, defD: 6, defH: 2, color: "#29b6f6", shape: "pool", branch: "commercial" },
  { kind: "food-court", label: "Food court", defW: 26, defD: 18, defH: 4.2, color: "#a1887f", shape: "box", branch: "commercial" },
  { kind: "alfresco-dining", label: "Alfresco dining", defW: 16, defD: 10, defH: 0.2, color: "#bcaaa4", shape: "court", branch: "commercial" },
  { kind: "retail-kiosks", label: "Retail kiosks", defW: 16, defD: 8, defH: 3.2, color: "#607d8b", shape: "box", branch: "commercial" },
];

/** Amenity presets available for a project branch (residential or commercial). */
export function amenitiesFor(branch: BuildingBranch, style?: CommercialStyle): AmenityKind[] {
  if (branch === "commercial" && (style === "hotel" || style === "resort")) return [...AMENITIES];
  return AMENITIES.filter((a) => !a.branch || a.branch === branch);
}

export function amenityAllowed(kind: string, branch: BuildingBranch, style?: CommercialStyle): boolean {
  return amenitiesFor(branch, style).some((amenity) => amenity.kind === kind);
}

export function amenityKind(kind: string): AmenityKind | undefined {
  return AMENITIES.find((a) => a.kind === kind);
}

export function amenityFootprint(amenity: AmenityData): { w: number; d: number; area: number; diameter?: number } {
  if (!amenity.shape && amenityKind(amenity.kind)?.shape === "circle") {
    // Preserve the visible diameter of older models whose two stored dimensions differed.
    const diameter = Math.min(amenity.w, amenity.d);
    return { w: diameter, d: diameter, diameter, area: Math.PI * (diameter / 2) ** 2 };
  }
  return { w: amenity.w, d: amenity.d, area: amenity.w * amenity.d };
}

export function updateAmenity(amenity: AmenityData, patch: Partial<AmenityData>): AmenityData {
  const next = { ...amenity, ...patch };
  if (amenityFootprint(next).diameter === undefined || (patch.w === undefined && patch.d === undefined)) return next;
  const diameter = patch.w ?? patch.d!;
  return { ...next, w: diameter, d: diameter };
}

export function makeAmenity(kind: string, x: number, z: number): AmenityData {
  const k = amenityKind(kind) ?? AMENITIES[0];
  return { id: uid("am"), kind: k.kind, x, z, rotY: 0, w: k.defW, d: k.defD, h: k.defH };
}

/* --------------------------------- Facades ---------------------------------- */

export interface FacadeOption {
  key: string;
  label: string;
  color: string;
  rough: number;
  metal: number;
  trans?: boolean;
}

export const FACADES: FacadeOption[] = [
  { key: "glass", label: "Glass", color: "#9ccfe4", rough: 0.15, metal: 0.4, trans: true },
  { key: "concrete", label: "Concrete", color: "#b0b4b8", rough: 0.9, metal: 0 },
  { key: "brick", label: "Brick", color: "#a0522d", rough: 0.85, metal: 0 },
  { key: "stone", label: "Stone cladding", color: "#b8aa94", rough: 0.8, metal: 0 },
  { key: "wood", label: "Wood", color: "#9b6b43", rough: 0.7, metal: 0 },
  { key: "aluminium", label: "Aluminium", color: "#c9ced2", rough: 0.3, metal: 0.8 },
  { key: "white", label: "White panels", color: "#f2f2f2", rough: 0.5, metal: 0 },
  { key: "dark", label: "Dark tint", color: "#263238", rough: 0.4, metal: 0.2 },
];

export function facadeOption(key: string): FacadeOption {
  return FACADES.find((f) => f.key === key) ?? FACADES[0];
}

/* -------------------------------- Interior types ----------------------------- */

export const INTERIOR_TYPES: { key: string; label: string }[] = [
  { key: "living", label: "Living room" },
  { key: "bedroom", label: "Bedroom" },
  { key: "kitchen", label: "Kitchen" },
  { key: "dining", label: "Dining room" },
  { key: "bathroom", label: "Bathroom" },
  { key: "balcony", label: "Balcony" },
  { key: "study", label: "Study" },
  { key: "utility", label: "Utility" },
  { key: "office", label: "Office space" },
  { key: "cubicle", label: "Cubicle" },
  { key: "meeting", label: "Meeting room" },
  { key: "pantry", label: "Food court / pantry" },
  { key: "reception", label: "Reception" },
  { key: "restroom", label: "Restroom" },
];

export function interiorLabel(type: string): string {
  return INTERIOR_TYPES.find((t) => t.key === type)?.label ?? type;
}

/* --------------------------------- Defaults --------------------------------- */

export function defaultUnderground(): UndergroundParking {
  return {
    levels: 1,
    floorHeight: 3,
    foundationDepth: 1.5,
    rampWidth: 3,
    rampLength: 30,
    rampSlope: 12,
    pillarSpacingX: 6,
    pillarSpacingZ: 6,
    bayWidth: 2.5,
    bayLength: 5,
    bayCols: 4,
    bayRows: 4,
    liftLobby: true,
    stairLobby: true,
    parkingWidthM: 36,
    parkingLengthM: 28,
  };
}

export function defaultTower(branch: BuildingBranch, label: string, x: number, z: number): TowerData {
  return {
    id: uid("tw"),
    label,
    x,
    z,
    floors: branch === "residential" ? 12 : 8,
    unitsPerFloor: branch === "residential" ? 4 : 8,
    unitWidth: branch === "residential" ? 7 : 6,
    unitDepth: branch === "residential" ? 9 : 8,
    floorHeight: 3.2,
    commonAreaPerFloor: 60,
    openAreaPerFloor: 30,
    doorFacing: "south",
    facadeMaterial: "glass",
    facadeColor: "#9ccfe4",
  };
}

export function defaultCommunity(branch: BuildingBranch): CommunityDesign {
  /* New projects begin as a measured, empty plot. Users add every structure. */
  return {
    version: 1,
    branch,
    residentialStyle: branch === "residential" ? "high-rise" : undefined,
    commercialStyle: branch === "commercial" ? "office" : undefined,
    land: { unit: "m", width: 1, depth: 1 },
    parking: { mode: "none", surfaceBays: 0 },
    amenities: [],
    terrain: { ...defaultTerrain },
    drafting: {
      gridVisible: true,
      gridSize: 0.5,
      snapEnabled: true,
      orthogonal: true,
      angleIncrement: 15,
      alignment: true,
    },
    towers: [],
    exteriors: [],
    interiors: [],
    levels: defaultLevels(),
    structuralGrid: [],
    structural: { ...DEFAULT_STRUCTURAL_SETTINGS },
  };
}

export function defaultLevels(): BuildingLevel[] {
  return [{ id: "level-0", name: "Ground Floor", elevation: 0, floorHeight: 3.2 }];
}

export function levelsForDesign(design: CommunityDesign): BuildingLevel[] {
  if (design.levels?.length) return design.levels;
  const count = Math.max(1, ...design.towers.map((tower) => tower.floors));
  return Array.from({ length: count }, (_, index) => ({
    id: `level-${index}`,
    name: index === 0 ? "Ground Floor" : `Level ${index + 1}`,
    elevation: index * 3.2,
    floorHeight: 3.2,
  }));
}

/* -------------------------------- Helpers ----------------------------------- */

export function towerMeters(t: TowerData): { w: number; d: number; h: number } {
  const unitsPerSide = Math.ceil(Math.sqrt(t.unitsPerFloor));
  const w = unitsPerSide * t.unitWidth + Math.sqrt(t.commonAreaPerFloor) * 0.4;
  const d = Math.ceil(t.unitsPerFloor / unitsPerSide) * t.unitDepth + Math.sqrt(t.commonAreaPerFloor) * 0.4;
  return { w, d, h: Math.max(t.floors, 1) * t.floorHeight };
}

/** Excavated footprint from user dimensions, or the tower envelopes of older models. */
export function pitFootprint(design: CommunityDesign): { x: number; z: number; w: number; d: number } {
  const { w: siteWidth, d: siteDepth } = landMeters(design.land);
  const underground = design.parking.underground;
  if (underground?.parkingWidthM && underground?.parkingLengthM && underground.parkingWidthM > 0 && underground.parkingLengthM > 0) {
    return { x: 0, z: 0, w: Math.min(underground.parkingWidthM, siteWidth), d: Math.min(underground.parkingLengthM, siteDepth) };
  }
  if (design.towers.length === 0) {
    return { x: 0, z: 0, w: Math.min(siteWidth * 0.62, 70), d: Math.min(siteDepth * 0.62, 46) };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const tower of design.towers) {
    const { w, d } = towerMeters(tower);
    minX = Math.min(minX, tower.x - w / 2 - 6);
    maxX = Math.max(maxX, tower.x + w / 2 + 6);
    minZ = Math.min(minZ, tower.z - d / 2 - 8);
    maxZ = Math.max(maxZ, tower.z + d / 2 + 8);
  }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ };
}

export function undergroundParkingBayLayout(design: CommunityDesign) {
  const pit = pitFootprint(design);
  const underground = design.parking.mode === "underground" ? design.parking.underground : undefined;
  if (!underground) return { cols: 0, rows: 0, levels: 0, pitchX: 0, pitchZ: 0, capacity: 0 };
  const pitchX = underground.bayWidth + 0.6;
  const pitchZ = underground.bayLength + 1;
  const count = (requested: number, extent: number, pitch: number) =>
    Number.isFinite(pitch) && pitch > 0 ? Math.max(0, Math.floor(Math.min(requested, extent / pitch))) : 0;
  const cols = count(underground.bayCols, pit.w, pitchX);
  const rows = count(underground.bayRows, pit.d, pitchZ);
  const levels = Math.max(0, Math.floor(underground.levels));
  return { cols, rows, levels, pitchX, pitchZ, capacity: cols * rows * levels };
}

export const BASEMENT_RAMP_DECK_M = 0.35;
export const BASEMENT_RAMP_EDGE_WIDTH_M = 0.25;
export const BASEMENT_RAMP_EDGE_HEIGHT_M = 0.35;

export function undergroundRamp(underground: UndergroundParking) {
  const width = underground.rampWidth > 0 ? underground.rampWidth : 3;
  const length = underground.rampLength > 0 ? underground.rampLength : 30;
  const slope = underground.rampSlope > 0 ? underground.rampSlope : underground.floorHeight / length * 100;
  return { width, length, slope, rise: length * slope / 100 };
}

export function undergroundDepth(underground: UndergroundParking): number {
  return undergroundRamp(underground).rise + Math.max(0, underground.levels - 1) * underground.floorHeight + underground.foundationDepth;
}

export function makeRoom(towerId: string, floor: number, name: string, type: string): InteriorRoom {
  return {
    id: uid("rm"),
    towerId,
    floor,
    name,
    type,
    x: 0,
    z: 0,
    w: 4,
    d: 3.5,
    doorFacing: "south",
  };
}

export const DOOR_FACING_LABELS: Record<string, string> = {
  north: "North",
  east: "East",
  south: "South",
  west: "West",
};
