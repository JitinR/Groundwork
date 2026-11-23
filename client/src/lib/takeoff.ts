import type { CommunityDesign } from "../types";
import {
  BASEMENT_RAMP_DECK_M, BASEMENT_RAMP_EDGE_HEIGHT_M, BASEMENT_RAMP_EDGE_WIDTH_M,
  amenityFootprint, landMeters, pitFootprint, towerMeters, undergroundDepth,
  undergroundParkingBayLayout, undergroundRamp,
} from "./community";

export { pitFootprint } from "./community";

/**
 * Material quantity takeoff.
 *
 * Quantities are derived parametrically from the guided design using
 * conventional reinforced-concrete practice (IS 456 / NBC-style assumptions)
 * and standard work-item norms. They are planning estimates, not a substitute
 * for a structural design or a certified BOQ.
 */

export interface TakeoffItem {
  key: string;
  group: string;
  label: string;
  qty: number;
  unit: string;
  basis: string;
}

export interface TakeoffGroup {
  group: string;
  items: TakeoffItem[];
}

export interface TakeoffResult {
  items: TakeoffItem[];
  groups: TakeoffGroup[];
  summary: {
    siteAreaM2: number;
    siteAreaSqYd: number;
    footprintM2: number;
    builtUpM2: number;
    floors: number;
    far: number;
    parkingBays: number;
    openAreaM2: number;
    excavationM3: number;
    concreteM3: number;
    steelT: number;
  };
}

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
};

export function computeTakeoff(design: CommunityDesign): TakeoffResult {
  const land = landMeters(design.land);
  const siteArea = land.w * land.d;

  const tps = design.towers.map((t) => towerMeters(t));
  const footprint = tps.reduce((s, t) => s + t.w * t.d, 0);
  const totalFloors = design.towers.reduce((s, t) => s + t.floors, 0);
  const builtUp = tps.reduce((s, t) => s + t.w * t.d * 1.08, 0);
  const totalBuiltUp = design.towers.reduce((s, t, i) => s + tps[i].w * tps[i].d * 1.08 * t.floors, 0);

  const ug = design.parking.mode === "underground" ? design.parking.underground : undefined;
  const pit = pitFootprint(design);
  const pitArea = pit.w * pit.d;
  const depth = ug ? undergroundDepth(ug) : 0;
  const parking = undergroundParkingBayLayout(design);
  const ramp = ug ? undergroundRamp(ug) : undefined;

  const excavation = ug ? pitArea * depth : 0;
  const disposal = excavation * 1.25; // bulking factor

  /* ------------------------------- Concrete ------------------------------- */
  const flatSlab = 0.3;
  const raftThickness = 0.6;
  const basementSlabs = ug ? pitArea * flatSlab * ug.levels : 0;
  const raft = ug ? pitArea * raftThickness : 0;
  const retainingPerimeter = ug ? 2 * (pit.w + pit.d) : 0;
  const rampOpeningArea = ramp ? Math.min(pit.d, ramp.width + BASEMENT_RAMP_EDGE_WIDTH_M * 2) * ramp.rise : 0;
  const retainingFaceArea = retainingPerimeter * depth - rampOpeningArea;
  const retainingWalls = retainingFaceArea * 0.3;
  const pillarsPerLevel = ug
    ? Math.max(0, Math.floor(pit.w / Math.max(ug.pillarSpacingX, 1))) *
      Math.max(0, Math.floor(pit.d / Math.max(ug.pillarSpacingZ, 1)))
    : 0;
  const pillarCount = pillarsPerLevel * parking.levels;
  const totalColumnHeight = ug && ramp && parking.levels > 0
    ? ramp.rise + (parking.levels - 1) * Math.max(ug.floorHeight - flatSlab, 0)
    : 0;
  const pillars = pillarsPerLevel * 0.5 * 0.5 * totalColumnHeight;
  const liftCores = ug ? 2 * 4 * depth * 0.25 : 0; // lift + stair core walls
  // Superstructure: slab + beams + columns ≈ 0.18 m equivalent per floor area.
  const superstructure = totalBuiltUp * 0.18;
  const rampConcrete = ramp ? ramp.length * (
    ramp.width * BASEMENT_RAMP_DECK_M + 2 * BASEMENT_RAMP_EDGE_WIDTH_M * BASEMENT_RAMP_EDGE_HEIGHT_M
  ) : 0;
  const draftedStructural = (design.drafts ?? [])
    .filter((draft) => draft.kind === "wall" || draft.kind === "slab" || draft.kind === "column" || draft.kind === "roof")
    .reduce((sum, draft) => sum + draft.w * draft.d * Math.max(draft.h ?? 0.2, 0.05), 0);
  const concreteItems: TakeoffItem[] = [
    { key: "raft", group: "Concrete", label: "Foundation raft / mat", qty: round(raft), unit: "m³", basis: "Pit area × 0.6 m" },
    { key: "basement-slabs", group: "Concrete", label: "Basement floor slabs", qty: round(basementSlabs), unit: "m³", basis: "Pit area × 0.3 m × levels" },
    { key: "retaining", group: "Concrete", label: "Basement retaining walls", qty: round(retainingWalls), unit: "m³", basis: "(Perimeter × depth − ramp opening area) × 0.3 m" },
    { key: "pillars", group: "Concrete", label: `Basement columns (${pillarCount} nos)`, qty: round(pillars), unit: "m³", basis: "Count × 0.5×0.5 × clear height" },
    { key: "cores", group: "Concrete", label: "Lift & stair core walls", qty: round(liftCores), unit: "m³", basis: "Core walls allowance" },
    { key: "superstructure", group: "Concrete", label: "Superstructure — slabs, beams, columns", qty: round(superstructure), unit: "m³", basis: "Built-up area × 0.18 m equivalent" },
    { key: "drafted-structural", group: "Concrete", label: "Drafted structural elements", qty: round(draftedStructural), unit: "m³", basis: "Stored wall, slab, column and roof geometry, counted separately" },
    { key: "ramp", group: "Concrete", label: "Vehicle ramp (deck + walls)", qty: round(rampConcrete), unit: "m³", basis: "Horizontal run × deck and edge cross sections" },
  ];
  const concrete = round(concreteItems.reduce((total, item) => total + item.qty, 0));

  const steel = concrete * 0.1; // 100 kg/m³ → tonnes
  const formwork = concrete * 8; // m² of formwork per m³

  /* ------------------------------- Masonry -------------------------------- */
  const externalWallArea = tps.reduce((area, tower) => area + 2 * (tower.w + tower.d) * tower.h, 0);
  const internalWallArea = totalBuiltUp * 0.9;
  const wallArea = externalWallArea + internalWallArea;
  const blockwork = wallArea * 0.23; // 230 mm block walls

  const plasterArea = wallArea * 2; // both faces
  const flooring = totalBuiltUp + (ug ? pitArea * ug.levels : 0);
  const waterproofing = (ug ? pitArea + retainingFaceArea * 1.2 : 0) + footprint;
  const glazing = externalWallArea * 0.28;
  const paintArea = plasterArea + externalWallArea;
  const paintLitres = paintArea * 0.2; // ~2 coats @ 0.1 L/m²

  /* --------------------------------- Doors -------------------------------- */
  const mainDoors = design.towers.reduce((s, t) => s + t.floors, 0);
  const internalDoors = Math.round(totalBuiltUp / 28); // ~1 door / 28 m² of built-up
  const doors = mainDoors + internalDoors;

  /* ----------------------------- Civil / site ----------------------------- */
  const parkingBays = design.parking.mode === "surface" ? design.parking.surfaceBays : parking.capacity;
  const amenityArea = design.amenities.reduce((area, amenity) => area + amenityFootprint(amenity).area, 0);
  const openArea = Math.max(siteArea - footprint - (ug ? 0 : 0) - amenityArea * 0.5, 0);
  const paving = parkingBays * 12.5 + amenityArea * 0.35 + siteArea * 0.08;
  const softscape = Math.max(amenityArea * 0.6 + openArea * 0.45, 0);

  /* ------------------------- Cement / sand / aggregate -------------------- */
  const cementBags = concrete * 6.5;
  const sandM3 = concrete * 0.45 + plasterArea * 0.015;
  const aggregateM3 = concrete * 0.88 + blockwork * 0.1;

  const items: TakeoffItem[] = [
    { key: "excavation", group: "Earthwork", label: "Excavation in ordinary soil", qty: round(excavation), unit: "m³", basis: "Pit area × dig depth" },
    { key: "disposal", group: "Earthwork", label: "Excavated earth disposal (with bulking)", qty: round(disposal), unit: "m³", basis: "Excavation × 1.25" },
    { key: "boulders", group: "Earthwork", label: "Boulder / hard strata allowance", qty: round(excavation * 0.05), unit: "m³", basis: "5% of excavation" },

    ...concreteItems,

    { key: "steel", group: "Steel", label: "Reinforcement steel (Fe500)", qty: round(steel, 2), unit: "t", basis: "100 kg per m³ of concrete" },
    { key: "formwork", group: "Steel", label: "Formwork / shuttering", qty: round(formwork), unit: "m²", basis: "8 m² per m³ of concrete" },

    { key: "blockwork", group: "Masonry", label: "Block / brick masonry", qty: round(blockwork), unit: "m³", basis: "Wall area × 230 mm" },
    { key: "plaster", group: "Masonry", label: "Internal & external plaster", qty: round(plasterArea), unit: "m²", basis: "Wall area × 2 faces" },

    { key: "flooring", group: "Finishes", label: "Flooring", qty: round(flooring), unit: "m²", basis: "Built-up + basement slabs" },
    { key: "waterproofing", group: "Finishes", label: "Waterproofing", qty: round(waterproofing), unit: "m²", basis: "Raft plan + retaining wall face area × 1.2 + terrace footprint" },
    { key: "paint", group: "Finishes", label: "Paint (2 coats)", qty: round(paintLitres), unit: "L", basis: "Paintable area × 0.2 L/m²" },
    { key: "glazing", group: "Facade", label: "Windows & glazing", qty: round(glazing), unit: "m²", basis: "28% of facade area" },
    { key: "doors", group: "Facade", label: `Doors (${mainDoors} main + ${internalDoors} internal)`, qty: round(doors, 0), unit: "nos", basis: "1 / floor + 1 / 28 m² built-up" },

    { key: "paving", group: "Site & external", label: "Paving / hardscape", qty: round(paving), unit: "m²", basis: "Parking bays + amenity aprons + circulation" },
    { key: "softscape", group: "Site & external", label: "Softscape / landscaping", qty: round(softscape), unit: "m²", basis: "Amenity greens + open area" },
    { key: "bays", group: "Site & external", label: "Parking bays", qty: parkingBays, unit: "nos", basis: "Surface + basement bay grid" },

    { key: "levels", group: "Schedules", label: "Building levels", qty: Math.max(design.levels?.length ?? 0, 1), unit: "levels", basis: "Persisted level schedule" },
    { key: "grid-lines", group: "Schedules", label: "Structural grid lines", qty: design.structuralGrid?.length ?? 0, unit: "nos", basis: "Persisted X/Z grid" },
    { key: "room-plans", group: "Schedules", label: "Room plans", qty: design.interiors.length, unit: "nos", basis: "Persisted interior room plans" },
    { key: "draft-elements", group: "Schedules", label: "Drafting elements", qty: design.drafts?.length ?? 0, unit: "nos", basis: "Persisted CAD geometry and annotations" },

    { key: "cement", group: "Binders", label: "Cement (OPC 53 grade)", qty: round(cementBags, 0), unit: "bags", basis: "6.5 bags per m³ of concrete" },
    { key: "sand", group: "Binders", label: "Fine aggregate (sand)", qty: round(sandM3), unit: "m³", basis: "Concrete + plaster mortar" },
    { key: "aggregate", group: "Binders", label: "Coarse aggregate", qty: round(aggregateM3), unit: "m³", basis: "Concrete + block infill" },
  ];

  const groupOrder = ["Earthwork", "Concrete", "Steel", "Masonry", "Finishes", "Facade", "Site & external", "Schedules", "Binders"];
  const groups = groupOrder
    .map((g) => ({ group: g, items: items.filter((i) => i.group === g) }))
    .filter((g) => g.items.length > 0);

  return {
    items,
    groups,
    summary: {
      siteAreaM2: round(siteArea),
      siteAreaSqYd: round(siteArea / 0.836127),
      footprintM2: round(footprint),
      builtUpM2: round(totalBuiltUp),
      floors: totalFloors,
      far: builtUp > 0 ? round(totalBuiltUp / Math.max(siteArea, 1), 2) : 0,
      parkingBays,
      openAreaM2: round(openArea),
      excavationM3: round(excavation),
      concreteM3: round(concrete),
      steelT: round(steel, 2),
    },
  };
}
