import * as THREE from "three";
import type {
  AirportDesign,
  DamDesign,
  Design,
  HighwayDesign,
  InfraDesign,
  InfraKind,
  PortDesign,
  DraftElement,
  VisualizationSettings,
} from "../types";
import { addTechnicalEdges, material, prismAt } from "./modelcore";
import { infraReviewFindings } from "./review";
import { buildTerrainVisualization, defaultTerrain } from "./terrain";
import { buildMepScene } from "./mep";
import { setScenePhase } from "./phaseVisibility";

/**
 * Guided infrastructure models.
 *
 * Each kind (highway, airport, port, dam+spillway) is described by a small
 * parametric config, rendered deterministically into a three.js group, and
 * priced by a conventional quantity takeoff. All math is local — the map
 * only supplies the site location, route/area and orientation.
 */

export const INFRA_KINDS: InfraKind[] = ["highway", "airport", "ports", "dams"];

export const INFRA_LABELS: Record<InfraKind, string> = {
  highway: "Highway & Roadways",
  airport: "Airport",
  ports: "Ports & Harbours",
  dams: "Dams & Spillways",
};

const round = (n: number, d = 2) => Math.round((Number.isFinite(n) ? n : 0) * 10 ** d) / 10 ** d;

/* --------------------------------- Defaults -------------------------------- */

export function defaultHighway(): HighwayDesign {
  return {
    lanes: 4,
    laneWidthM: 3.5,
    medianM: 3,
    shoulderM: 1.5,
    designSpeedKph: 100,
    surface: "bituminous",
    pavementThicknessMm: 550,
    crossSlopePct: 2,
    embankmentHeightM: 2,
    culverts: 6,
    interchanges: 2,
    terrainRoughnessM: 1.5,
  };
}

export function defaultAirport(): AirportDesign {
  return {
    runways: 1,
    runwayLengthM: 3000,
    runwayWidthM: 45,
    runwayHeadingDeg: 90,
    taxiways: 2,
    apronDepthM: 220,
    terminalAreaM2: 18000,
    stands: 14,
    aerodromeCode: "4E",
    elevationM: 30,
    fuelFarm: true,
  };
}

export function defaultPort(): PortDesign {
  return {
    berths: 4,
    berthLengthM: 250,
    draftM: 14,
    quayWidthM: 40,
    breakwaterLengthM: 900,
    containerYardM2: 140000,
    cranes: 6,
    warehouses: 4,
    channelDepthM: 16,
    quayType: "open-piled",
  };
}

export function defaultDam(): DamDesign {
  return {
    damType: "gravity",
    heightM: 60,
    crestLengthM: 280,
    crestWidthM: 8,
    upstreamSlope: 0.1,
    downstreamSlope: 0.8,
    freeboardM: 2,
    reservoirAreaM2: 1_200_000,
    spillwayType: "ogee",
    spillwayCapacityCumec: 3200,
    spillwayGates: 4,
    gateWidthM: 12,
    gateHeightM: 9,
    stillingBasin: true,
    groutCurtainDepthM: 25,
  };
}

export function defaultInfra(kind: InfraKind): InfraDesign {
  const base: InfraDesign = { version: 1, kind, modelReady: false, facilities: [], terrain: { ...defaultTerrain } };
  if (kind === "highway") base.highway = defaultHighway();
  if (kind === "airport") base.airport = defaultAirport();
  if (kind === "ports") base.ports = defaultPort();
  if (kind === "dams") base.dams = defaultDam();
  return base;
}

/** Merge stored infra with defaults so newly added fields never come back undefined. */
export function normalizeInfra(infra: InfraDesign | undefined, kind: InfraKind): InfraDesign {
  const base = defaultInfra(kind);
  if (!infra) return base;
  return {
    ...base,
    ...infra,
    kind,
    modelReady: infra.modelReady ?? true,
    facilities: infra.facilities ?? [],
    terrain: { ...defaultTerrain, ...infra.terrain },
    drafts: infra.drafts ?? [],
    highway: kind === "highway" ? { ...base.highway!, ...infra.highway } : undefined,
    airport: kind === "airport" ? { ...base.airport!, ...infra.airport } : undefined,
    ports: kind === "ports" ? { ...base.ports!, ...infra.ports } : undefined,
    dams: kind === "dams" ? { ...base.dams!, ...infra.dams } : undefined,
  };
}

function addFacilities(g: THREE.Group, infra: InfraDesign, ext: InfraExtent, visualization?: VisualizationSettings): void {
  const facilities = infra.facilities ?? [];
  const colors: Record<string, string> = {
    lounge: "#8e9cc4",
    terminal: "#b0bec5",
    runway: "#263238",
    berth: "#607d8b",
    warehouse: "#8d6e63",
    yard: "#78909c",
    highway: "#9e9d24",
    dam: "#78909c",
  };
  let serial = 0;
  for (const facility of facilities) {
    const count = Math.min(Math.max(Math.round(facility.count), 0), 100);
    for (let i = 0; i < count; i++) {
      const length = Math.max(facility.lengthM, 0.5);
      const width = Math.max(facility.widthM, 0.5);
      const height = Math.max(facility.heightM, 0.2);
      const across = Math.max(1, Math.floor(ext.w / (length + 8)));
      const col = serial % across;
      const row = Math.floor(serial / across);
      const x = -ext.w / 2 + 20 + col * (length + 8);
      const z = -ext.d / 2 + 20 + row * (width + 8);
      const mesh = prismAt(x, height / 2 + 0.05, z, length, height, width, material(colors[facility.kind] ?? "#78909c", { rough: 0.75 }));
      mesh.userData.noSelect = true;
      const phaseRoot = new THREE.Group();
      setScenePhase(phaseRoot, facility.phaseId, visualization);
      phaseRoot.add(mesh);
      g.add(phaseRoot);
      serial++;
    }
  }
}

function buildEmptyInfraScene(ext: InfraExtent): THREE.Group {
  const g = new THREE.Group();
  const site = prismAt(0, -0.08, 0, ext.w, 0.12, ext.d, material("#343b42", { rough: 0.95 }));
  site.userData.noSelect = true;
  g.add(site);
  const boundary = material("#d6a84a", { rough: 0.7 });
  g.add(
    prismAt(0, 0.02, -ext.d / 2, ext.w, 0.04, 0.08, boundary),
    prismAt(0, 0.02, ext.d / 2, ext.w, 0.04, 0.08, boundary),
    prismAt(-ext.w / 2, 0.02, 0, 0.08, 0.04, ext.d, boundary),
    prismAt(ext.w / 2, 0.02, 0, 0.08, 0.04, ext.d, boundary),
  );
  return g;
}

/* ------------------------------- Site extents ------------------------------- */

export interface InfraExtent {
  w: number;
  d: number;
  h: number;
}

function airportLocalExtent(a: AirportDesign): InfraExtent {
  const spacing = a.runwayWidthM + 400;
  return {
    w: a.runwayLengthM + 600,
    d: a.runways > 1 ? a.runwayWidthM + a.apronDepthM * 2 + spacing + 600 : a.runwayWidthM + a.apronDepthM * 2 + 700,
    h: 120,
  };
}

/** Generated runways start along +X (east). Site/CAD north is -Z, so a
 * clockwise compass bearing becomes (90 - bearing) about Three's +Y axis. */
function airportRotation(heading: number): number {
  const bearing = Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 90;
  return (90 - bearing) * Math.PI / 180;
}

export function infraExtent(infra: InfraDesign): InfraExtent {
  switch (infra.kind) {
    case "highway": {
      const h = infra.highway!;
      const len = infra.location?.routeLengthM && infra.location.routeLengthM > 40 ? infra.location.routeLengthM : 800;
      const carriage = h.lanes * h.laneWidthM + h.medianM + 2 * h.shoulderM;
      return { w: Math.max(carriage + 60, 80), d: len + 120, h: 70 };
    }
    case "airport": {
      const a = infra.airport!;
      const local = airportLocalExtent(a), angle = airportRotation(a.runwayHeadingDeg);
      const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
      return {
        w: local.w * cos + local.d * sin,
        d: local.w * sin + local.d * cos,
        h: local.h,
      };
    }
    case "ports": {
      const p = infra.ports!;
      const quayLen = p.berthLengthM * Math.max(1, p.berths);
      return { w: quayLen + 300, d: p.breakwaterLengthM + 700, h: 90 };
    }
    case "dams": {
      const d = infra.dams!;
      return { w: d.crestLengthM + 260, d: Math.max(d.reservoirAreaM2 / Math.max(d.crestLengthM, 1), d.heightM * 8) + 400, h: d.heightM + 120 };
    }
  }
}

/* --------------------------------- Terrain ---------------------------------- */

function waterMesh(w: number, d: number, x: number, y: number, z: number, opacity = 0.72): THREE.Mesh {
  const mesh = prismAt(x, y, z, w, 0.15, d, material("#2f6fb0", { rough: 0.15, metal: 0.3, trans: opacity }));
  mesh.userData.noSelect = true;
  return mesh;
}

function buildCivilDraft(draft: DraftElement): THREE.Group {
  const g = new THREE.Group();
  const color = draft.color || (draft.civilKind === "contour" ? "#a3c77b" : "#f2c14e");
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  if (draft.kind === "circle") {
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(Math.min(draft.w, draft.d) / 2 - 0.15, 0.1), Math.min(draft.w, draft.d) / 2, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.18;
    g.add(ring);
  } else if (draft.kind === "rectangle") {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(draft.w, draft.d), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.18;
    g.add(plane);
  } else {
    const line = new THREE.Mesh(new THREE.BoxGeometry(Math.max(draft.w, 0.2), 0.08, Math.max(draft.d, 0.08)), mat);
    line.position.y = 0.2;
    g.add(line);
  }
  g.position.set(draft.x, 0, draft.z);
  g.rotation.y = (draft.rotationDeg * Math.PI) / 180;
  g.userData.selectId = draft.id;
  g.userData.selectKind = "draft";
  return g;
}

function dashedLine(count: number, x0: number, z0: number, dx: number, dz: number, len: number, width: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const dash = prismAt(x0 + dx * i, 0.03, z0 + dz * i, len, 0.04, width, mat);
    g.add(dash);
  }
  return g;
}

/* --------------------------------- Highways --------------------------------- */

function buildHighway(h: HighwayDesign, ext: InfraExtent, loc: InfraDesign["location"]): THREE.Group {
  const g = new THREE.Group();

  const carriage = h.lanes * h.laneWidthM;
  const asphalt = material(h.surface === "bituminous" ? "#2b2f36" : "#b9bcc0", { rough: 0.85 });
  const shoulderMat = material("#8a8f96", { rough: 0.9 });
  const bankMat = material("#877a5f", { rough: 0.95 });
  const markMat = material("#f2f4f6", { rough: 0.5 });
  const medianMat = material("#6f7a55", { rough: 0.95 });
  const rampMat = material("#3a3f47", { rough: 0.85 });
  const culvertMat = material("#6b6f75", { rough: 0.8 });

  const spanZ = ext.d - 120;

  // Embankment pad under the road
  g.add(prismAt(0, h.embankmentHeightM / 2 - 0.2, 0, carriage + 2 * h.shoulderM + 6, h.embankmentHeightM, spanZ, bankMat));
  // Shoulders
  g.add(prismAt(0, h.embankmentHeightM + 0.01, 0, carriage + 2 * h.shoulderM, 0.12, spanZ, shoulderMat));
  // Carriageways (split by median when present)
  const halfLane = h.lanes / 2;
  if (h.medianM > 0.4) {
    const cw = halfLane * h.laneWidthM;
    g.add(prismAt(-(h.medianM / 2 + cw / 2), h.embankmentHeightM + 0.05, 0, cw, 0.14, spanZ, asphalt));
    g.add(prismAt(h.medianM / 2 + cw / 2, h.embankmentHeightM + 0.05, 0, cw, 0.14, spanZ, asphalt));
    g.add(prismAt(0, h.embankmentHeightM + 0.06, 0, h.medianM, 0.16, spanZ, medianMat));
  } else {
    g.add(prismAt(0, h.embankmentHeightM + 0.05, 0, carriage, 0.14, spanZ, asphalt));
  }
  // Lane markings
  const dashCount = Math.max(8, Math.floor(spanZ / 18));
  const laneEdge = carriage / 2;
  g.add(dashedLine(dashCount, -laneEdge, -spanZ / 2, 0, spanZ / dashCount, 3, 0.18, markMat));
  g.add(dashedLine(dashCount, laneEdge, -spanZ / 2, 0, spanZ / dashCount, 3, 0.18, markMat));
  if (h.medianM <= 0.4 && halfLane > 1) {
    g.add(dashedLine(dashCount, 0, -spanZ / 2, 0, spanZ / dashCount, 3, 0.2, markMat));
  }

  // Interchanges (diamond ramps)
  for (let i = 0; i < Math.max(0, Math.min(h.interchanges, 6)); i++) {
    const z = -spanZ / 2 + ((i + 1) / (h.interchanges + 1)) * spanZ;
    const rampLen = 120;
    const ramp = prismAt(0, h.embankmentHeightM + 0.04, z, 9, 0.12, rampLen, rampMat);
    ramp.rotation.y = Math.PI / 4;
    g.add(ramp);
    const ramp2 = prismAt(0, h.embankmentHeightM + 0.04, z, 9, 0.12, rampLen, rampMat);
    ramp2.rotation.y = -Math.PI / 4;
    g.add(ramp2);
    g.add(prismAt(0, h.embankmentHeightM + 0.09, z, carriage + 24, 0.14, 26, asphalt));
  }

  // Culverts (cross-drainage)
  for (let i = 0; i < Math.max(0, Math.min(h.culverts, 20)); i++) {
    const z = -spanZ / 2 + ((i + 0.5) / Math.max(h.culverts, 1)) * spanZ;
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, carriage + 8, 12),
      culvertMat,
    );
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, h.embankmentHeightM * 0.4, z);
    g.add(pipe);
  }

  // Route direction marker referencing the traced bearing
  if (loc?.routeBearingDeg !== undefined) {
    g.userData.bearingDeg = loc.routeBearingDeg;
  }
  return g;
}

/* ---------------------------------- Airport --------------------------------- */

function buildAirport(a: AirportDesign, ext: InfraExtent): THREE.Group {
  const g = new THREE.Group();
  g.name = "airport-layout";
  g.rotation.y = airportRotation(a.runwayHeadingDeg);

  const concrete = material("#b9bcc0", { rough: 0.85 });
  const runwayMat = material("#4a4f56", { rough: 0.8 });
  const markMat = material("#f2f4f6", { rough: 0.5 });
  const grass = material("#6f7a55", { rough: 0.95 });
  const buildingMat = material("#cfd6dc", { rough: 0.6 });
  const glassMat = material("#9ccfe4", { rough: 0.15, metal: 0.4, trans: 0.7 });
  const apronMat = material("#9ea3a8", { rough: 0.85 });
  const standMat = material("#e0c04a", { rough: 0.6 });

  const rl = a.runwayLengthM;
  const rw = a.runwayWidthM;
  const spacing = rw + 400;

  for (let i = 0; i < a.runways; i++) {
    const z = (i - (a.runways - 1) / 2) * spacing;
    // Runway + shoulders
    g.add(prismAt(0, 0.06, z, rl + 120, 0.12, rw + 2 * 7.5, concrete));
    const runway = prismAt(0, 0.1, z, rl, 0.14, rw, runwayMat);
    runway.name = `airport-runway-${i + 1}`;
    g.add(runway);
    // Centreline dashes
    const n = Math.max(10, Math.floor(rl / 30));
    g.add(dashedLine(n, -rl / 2, z, rl / n, 0, 4, 0.5, markMat));
    // Threshold bars
    for (let t = 0; t < 8; t++) {
      g.add(prismAt(-rl / 2 + 10, 0.12, z + (t - 3.5) * (rw / 9), 12, 0.05, 0.6, markMat));
      g.add(prismAt(rl / 2 - 10, 0.12, z + (t - 3.5) * (rw / 9), 12, 0.05, 0.6, markMat));
    }
    // Taxiways (parallel connectors to apron)
    for (let k = 0; k < a.taxiways; k++) {
      const x = ((k + 1) / (a.taxiways + 1) - 0.5) * rl;
      const apronZ = ext.d / 2 - a.apronDepthM / 2 - 40;
      const length = Math.abs(apronZ - z);
      const tw = prismAt(x, 0.09, (z + apronZ) / 2, 22, 0.12, length, concrete);
      g.add(tw);
    }
  }

  // Apron
  const apronZ = ext.d / 2 - a.apronDepthM / 2 - 40;
  g.add(prismAt(0, 0.07, apronZ, Math.min(rl, ext.w - 200), 0.12, a.apronDepthM, apronMat));

  // Stands (nose-in parking)
  const stands = Math.min(a.stands, 40);
  for (let i = 0; i < stands; i++) {
    const x = (i - (stands - 1) / 2) * 62;
    g.add(prismAt(x, 0.13, apronZ + a.apronDepthM / 2 - 26, 3, 0.05, 40, standMat));
  }

  // Terminal
  const termW = Math.min(Math.sqrt(a.terminalAreaM2) * 2.4, rl * 0.8);
  const termD = a.terminalAreaM2 / Math.max(termW, 1);
  const termZ = apronZ + a.apronDepthM / 2 + termD / 2 + 20;
  g.add(prismAt(0, 1.6, termZ, termW, 3.2, termD, buildingMat));
  g.add(prismAt(0, 2.2, termZ - termD / 2 - 0.3, termW * 0.96, 2.2, 0.4, glassMat));

  // Control tower
  g.add(prismAt(-termW / 2 - 30, 12, termZ, 8, 24, 8, buildingMat));
  g.add(prismAt(-termW / 2 - 30, 25, termZ, 12, 4, 12, glassMat));

  // Fuel farm
  if (a.fuelFarm) {
    for (let i = 0; i < 4; i++) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 12, 20), material("#c8cccf", { rough: 0.5, metal: 0.3 }));
      tank.position.set(termW / 2 + 40 + i * 22, 6, termZ);
      tank.castShadow = true;
      g.add(tank);
    }
  }

  const pad = prismAt(0, -0.05, 0, ext.w, 0.1, ext.d, grass);
  pad.name = "airport-layout-pad";
  g.add(pad);
  return g;
}

/* ----------------------------------- Ports ---------------------------------- */

function buildPort(p: PortDesign, ext: InfraExtent): THREE.Group {
  const g = new THREE.Group();
  const quayLen = p.berthLengthM * Math.max(1, p.berths);
  // Land (south half) + water (north half)
  g.add(prismAt(0, -0.05, ext.d / 4, ext.w, 0.5, ext.d / 2, material("#7d8a63", { rough: 0.95 })));
  g.add(waterMesh(ext.w, ext.d / 2, 0, 0.05, -ext.d / 4, 0.75));

  const quayMat = material("#9a9ea3", { rough: 0.85 });
  const deckMat = material("#b6babf", { rough: 0.85 });
  const craneMat = material("#e0a13a", { rough: 0.5, metal: 0.4 });
  const containerMats = ["#c0392b", "#2980b9", "#27ae60", "#f39c12", "#8e44ad"].map((c) => material(c, { rough: 0.7 }));
  const warehouseMat = material("#cfd6dc", { rough: 0.6 });
  const rockMat = material("#6b6257", { rough: 1 });
  const y = 0.25;

  // Quay wall / deck along the waterline (z = 0)
  if (p.quayType === "solid") {
    g.add(prismAt(0, y, -p.quayWidthM / 2 + 0.5, quayLen + 60, 8, 3, quayMat));
  } else {
    for (let x = -quayLen / 2; x <= quayLen / 2; x += 12) {
      g.add(prismAt(x, -3, -1.5, 1.4, 12, 1.4, quayMat));
    }
  }
  g.add(prismAt(0, y + 3, p.quayWidthM / 2 - 1, quayLen + 60, 1, p.quayWidthM + 2, deckMat));

  // Berths (bollards + fenders)
  for (let i = 0; i < p.berths; i++) {
    const x = (i - (p.berths - 1) / 2) * p.berthLengthM;
    for (let b = -1; b <= 1; b += 2) {
      const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.4, 10), material("#f2f4f6", { rough: 0.5 }));
      bollard.position.set(x + b * p.berthLengthM * 0.35, y + 3.7, -p.quayWidthM / 2 + 1.2);
      g.add(bollard);
    }
  }

  // Container yard (stacked boxes)
  const yardW = Math.min(quayLen, ext.w - 200);
  const yardD = p.containerYardM2 / Math.max(yardW, 1);
  const yardZ = p.quayWidthM + yardD / 2 + 20;
  g.add(prismAt(0, y + 2.6, yardZ, yardW, 0.3, yardD, deckMat));
  const cols = Math.max(3, Math.min(Math.floor(yardW / 30), 40));
  const rows = Math.max(3, Math.min(Math.floor(yardD / 30), 40));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if ((i + j) % 3 === 0) continue;
      const stack = 1 + ((i * 7 + j * 3) % 4);
      const cx = -yardW / 2 + 15 + i * ((yardW - 30) / Math.max(cols - 1, 1));
      const cz = yardZ - yardD / 2 + 15 + j * ((yardD - 30) / Math.max(rows - 1, 1));
      for (let k = 0; k < stack; k++) {
        g.add(prismAt(cx, y + 2.75 + 1.3 + k * 2.6, cz, 12, 2.6, 5, containerMats[(i + j + k) % containerMats.length]));
      }
    }
  }

  // Ship-to-shore gantry cranes
  for (let i = 0; i < Math.min(p.cranes, 12); i++) {
    const x = -quayLen / 2 + ((i + 0.5) / Math.max(p.cranes, 1)) * quayLen;
    const legH = 22;
    for (const lx of [-3, 3]) {
      for (const lz of [-4, 4]) {
        g.add(prismAt(x + lx, y + 3 + legH / 2, p.quayWidthM / 2 - 4 + lz, 1.2, legH, 1.2, craneMat));
      }
    }
    g.add(prismAt(x, y + 3 + legH + 1, p.quayWidthM / 2 - 4, 12, 2, 10, craneMat));
    g.add(prismAt(x, y + 3 + legH + 3, p.quayWidthM / 2 - 4, 2, 6, 2, craneMat));
  }

  // Warehouses
  for (let i = 0; i < Math.min(p.warehouses, 8); i++) {
    const x = -yardW / 2 + ((i + 0.5) / Math.max(p.warehouses, 1)) * yardW;
    g.add(prismAt(x, y + 5, yardZ + yardD / 2 + 45, 60, 10, 40, warehouseMat));
  }

  // Breakwater with round head, sheltering the water side
  const bw = p.breakwaterLengthM;
  for (let i = 0; i < Math.max(4, Math.floor(bw / 8)); i++) {
    const t = i / Math.max(bw / 8 - 1, 1);
    const x = -ext.w / 2 + 40 + t * (ext.w - 120);
    const z = -ext.d / 4 - (ext.d / 4) * Math.sin(t * Math.PI * 0.5);
    g.add(prismAt(x, 0, z, 8, 4, 8, rockMat));
  }
  const head = new THREE.Mesh(new THREE.CylinderGeometry(16, 18, 5, 16), rockMat);
  head.position.set(ext.w / 2 - 80, 0, -ext.d / 2 + 40);
  g.add(head);

  return g;
}

/* ----------------------------------- Dams ----------------------------------- */

function buildDam(d: DamDesign, ext: InfraExtent): THREE.Group {
  const g = new THREE.Group();

  const concrete = material("#a9adb2", { rough: 0.85 });
  const earth = material("#8a7d5f", { rough: 1 });
  const riprap = material("#6b6257", { rough: 1 });
  const crestMat = material("#3a3f47", { rough: 0.85 });
  const gateMat = material("#c0392b", { rough: 0.5, metal: 0.3 });
  const crestY = d.heightM;

  // Reservoir upstream (negative Z)
  g.add(waterMesh(ext.w - 80, ext.d * 0.55, 0, crestY - d.freeboardM, -ext.d * 0.3));

  // Dam body across the valley (axis along X)
  if (d.damType === "earthen" || d.damType === "rockfill") {
    const baseW = d.heightM * (d.upstreamSlope + d.downstreamSlope) + d.crestWidthM;
    const body = prismAt(0, d.heightM / 2, 0, d.crestLengthM, d.heightM, baseW, d.damType === "rockfill" ? riprap : earth);
    g.add(body);
    g.add(prismAt(0, crestY + 0.25, 0, d.crestLengthM + 6, 0.5, d.crestWidthM + 2, earth));
    const crestRoad = prismAt(0, crestY + 0.55, 0, d.crestLengthM + 6, 0.12, d.crestWidthM, crestMat);
    g.add(crestRoad);
  } else if (d.damType === "arch") {
    const radius = d.crestLengthM / (2 * Math.sin(Math.PI / 6));
    const segs = 18;
    for (let i = 0; i <= segs; i++) {
      const a = -Math.PI / 6 + (i / segs) * (Math.PI / 3);
      const x = Math.sin(a) * radius;
      const z = -Math.cos(a) * radius + radius * 0.85;
      const seg = prismAt(x, d.heightM / 2, z, radius * 0.42, d.heightM, d.crestWidthM * 1.6, concrete);
      seg.rotation.y = -a;
      g.add(seg);
    }
    const crestRoad = prismAt(0, crestY + 0.55, -radius + radius * 0.85, radius * 0.9, 0.12, d.crestWidthM + 2, crestMat);
    g.add(crestRoad);
  } else {
    // gravity: trapezoid via a box body plus sloped faces approximated by two prisms
    const baseW = d.crestWidthM + d.heightM * (d.downstreamSlope + 0.15);
    g.add(prismAt(0, d.heightM / 2, 0, d.crestLengthM, d.heightM, d.crestWidthM, concrete));
    const downstream = prismAt(0, d.heightM / 4, (d.crestWidthM + baseW) / 4, d.crestLengthM, d.heightM / 2, baseW / 2, concrete);
    g.add(downstream);
    g.add(prismAt(0, crestY + 0.3, 0, d.crestLengthM + 6, 0.6, d.crestWidthM + 2, concrete));
    const crestRoad = prismAt(0, crestY + 0.66, 0, d.crestLengthM + 6, 0.12, d.crestWidthM, crestMat);
    g.add(crestRoad);
  }

  // Spillway to one flank + gates + stilling basin (merged spillways feature)
  const spillX = d.crestLengthM / 2 + 24;
  if (d.spillwayType === "ogee") {
    g.add(prismAt(spillX, crestY * 0.5, 0, 30, d.heightM, 12, concrete));
    const chute = prismAt(spillX, crestY * 0.3, 26, 30, 1.2, Math.max(30, d.heightM * 1.4), concrete);
    chute.rotation.x = Math.PI / 9;
    g.add(chute);
  } else if (d.spillwayType === "chute") {
    g.add(prismAt(spillX, crestY * 0.5, 0, 26, d.heightM, 10, concrete));
    const chute = prismAt(spillX, 0, 40, 26, 1.0, 60, concrete);
    chute.rotation.x = Math.PI / 7;
    g.add(chute);
  } else if (d.spillwayType === "siphon") {
    for (let i = 0; i < 3; i++) {
      const pipe = new THREE.Mesh(new THREE.TorusGeometry(6, 1, 10, 24, Math.PI), concrete);
      pipe.position.set(spillX + i * 10, crestY - 4, 0);
      pipe.rotation.y = Math.PI / 2;
      g.add(pipe);
    }
  } else {
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 8, 20), concrete);
    funnel.position.set(spillX, crestY - 2, 0);
    g.add(funnel);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, d.heightM, 20), concrete);
    shaft.position.set(spillX, crestY - 8 - d.heightM / 2, 0);
    g.add(shaft);
  }
  // Radial gates on the spillway crest
  for (let i = 0; i < Math.max(1, Math.min(d.spillwayGates, 10)); i++) {
    const x = spillX + (i - (d.spillwayGates - 1) / 2) * (d.gateWidthM + 1.5);
    g.add(prismAt(x, crestY - d.gateHeightM / 2 + 0.4, -3, d.gateWidthM, d.gateHeightM, 1.2, gateMat));
  }
  if (d.stillingBasin) {
    g.add(prismAt(spillX, 0.2, 52, 34, 1.5, 40, concrete));
  }

  return g;
}

/* --------------------------------- Assembly --------------------------------- */

export function buildInfraScene(infra: InfraDesign, visualization?: VisualizationSettings): THREE.Group {
  const ext = infraExtent(infra);
  const layerVisible = (id: string) => infra.layers?.find((layer) => layer.id === id)?.visible !== false;
  if (infra.modelReady === false) {
    const empty = buildEmptyInfraScene(ext);
    empty.add(buildTerrainVisualization(ext.w, ext.d, infra.terrain));
    addTechnicalEdges(empty, "#8b6b31", 0.5);
    return empty;
  }
  const scene = infra.kind === "highway"
    ? buildHighway(infra.highway!, ext, infra.location)
    : infra.kind === "airport"
      ? new THREE.Group().add(buildAirport(infra.airport!, airportLocalExtent(infra.airport!)))
      : infra.kind === "ports"
        ? buildPort(infra.ports!, ext)
        : buildDam(infra.dams!, ext);
  const terrain = buildTerrainVisualization(ext.w, ext.d, infra.terrain);
  terrain.name = "infrastructure-terrain";
  scene.add(terrain);
  // Authored/world-coordinate layers do not inherit the airport's rotation.
  // Scheduled facilities retain their existing local-envelope placement.
  if (layerVisible("facilities")) addFacilities(scene, infra, infra.kind === "airport" ? airportLocalExtent(infra.airport!) : ext, visualization);
  if (layerVisible("drafting")) for (const draft of infra.drafts ?? []) {
    const node = buildCivilDraft(draft);
    setScenePhase(node, draft.phaseId, visualization);
    scene.add(node);
  }
  if (layerVisible("mep")) scene.add(buildMepScene(infra.mep, visualization));
  addTechnicalEdges(scene, "#253746", 0.5);
  return scene;
}

export function infraSummary(infra: InfraDesign): string {
  switch (infra.kind) {
    case "highway": {
      const h = infra.highway!;
      const len = infra.location?.routeLengthM ? `${round(infra.location.routeLengthM, 0)} m route · ` : "";
      return `${len}${h.lanes}-lane ${h.surface} carriageway · ${h.designSpeedKph} km/h design speed`;
    }
    case "airport": {
      const a = infra.airport!;
      return `${a.runways} runway(s) ${a.runwayLengthM} × ${a.runwayWidthM} m · ARC ${a.aerodromeCode} · ${a.stands} stands`;
    }
    case "ports": {
      const p = infra.ports!;
      return `${p.berths} berths × ${p.berthLengthM} m · draft ${p.draftM} m · ${p.cranes} STS cranes`;
    }
    case "dams": {
      const d = infra.dams!;
      return `${d.damType} dam ${d.heightM} m × ${d.crestLengthM} m · ${d.spillwayType} spillway (${d.spillwayCapacityCumec} cumec)`;
    }
  }
}

/* --------------------------------- Takeoff --------------------------------- */

export interface InfraTakeoffItem {
  key: string;
  group: string;
  label: string;
  qty: number;
  unit: string;
  basis: string;
}

export interface InfraTakeoff {
  items: InfraTakeoffItem[];
  groups: { group: string; items: InfraTakeoffItem[] }[];
  summary: { label: string; value: string }[];
}

export function computeInfraTakeoff(infra: InfraDesign): InfraTakeoff {
  const items: InfraTakeoffItem[] = [];
  const summary: { label: string; value: string }[] = [];
  const add = (key: string, group: string, label: string, qty: number, unit: string, basis: string) =>
    items.push({ key, group, label, qty: round(qty), unit, basis });

  if (infra.kind === "highway") {
    const h = infra.highway!;
    const len = infra.location?.routeLengthM && infra.location.routeLengthM > 40 ? infra.location.routeLengthM : 800;
    const carriage = h.lanes * h.laneWidthM;
    const roadArea = (carriage + 2 * h.shoulderM) * len;
    const embank = carriage + 2 * h.shoulderM + 6;
    const earthwork = embank * len * h.embankmentHeightM;
    const asphaltVol = roadArea * (h.pavementThicknessMm / 1000);
    add("clearance", "Earthwork", "Site clearance & stripping", roadArea * 0.15, "m²", "Roadway width × length × 0.15 strip");
    add("earthwork", "Earthwork", "Embankment fill", earthwork, "m³", "Formation width × length × height");
    add("subgrade", "Pavement", "Subgrade preparation", roadArea, "m²", "Formation area");
    add("gsb", "Pavement", "Granular sub-base (GSB)", asphaltVol * 0.6, "m³", "Pavement volume base");
    add("wmm", "Pavement", "Wet mix macadam (base)", asphaltVol * 0.45, "m³", "Pavement volume binder");
    add("bitumen", "Pavement", h.surface === "bituminous" ? "Bituminous courses (DBM + BC)" : "Concrete pavement (PQC)", asphaltVol, "m³", "Area × pavement thickness");
    add("shoulder", "Pavement", "Shoulders & kerbs", 2 * h.shoulderM * len, "m²", "Shoulder width × length × 2");
    add("marking", "Finishes", "Road markings & signage", len, "m", "Route length");
    add("median", "Finishes", "Median / divider", h.medianM * len, "m²", "Median width × length");
    add("culverts", "Structures", `Culverts (${h.culverts} nos)`, h.culverts, "nos", "Cross-drainage count");
    add("interchange", "Structures", `Interchanges (${h.interchanges})`, h.interchanges * carriage * 260, "m²", "Interchange paving allowance");
    summary.push(
      { label: "Route length", value: `${round(len, 0)} m` },
      { label: "Carriageway", value: `${carriage} m (${h.lanes} lanes)` },
      { label: "Formation width", value: `${round(embank, 1)} m` },
      { label: "Pavement area", value: `${round(roadArea, 0)} m²` },
    );
  } else if (infra.kind === "airport") {
    const a = infra.airport!;
    const rArea = a.runways * a.runwayLengthM * a.runwayWidthM;
    const shoulders = a.runways * a.runwayLengthM * 15 * 2;
    const taxi = a.taxiways * a.runwayLengthM * 0.4 * 22;
    const apron = Math.min(a.runwayLengthM, 2400) * a.apronDepthM;
    add("clearing", "Earthwork", "Runway strip clearing & levelling", (rArea + shoulders) * 1.4, "m²", "Strip area × 1.4");
    add("subgrade", "Pavement", "Runway subgrade (CBR 8+)", rArea, "m²", "Runway area");
    add("pqc", "Pavement", "Runway PQC slab (flexible/rigid)", rArea, "m²", "Runway area");
    add("shoulder", "Pavement", "Runway shoulders", shoulders, "m²", "1.5 m each side × 2");
    add("taxiway", "Pavement", `Taxiways (${a.taxiways})`, taxi, "m²", "Taxiway length × 22 m");
    add("apron", "Pavement", "Apron (PQC)", apron, "m²", "Apron width × depth");
    add("markings", "Finishes", "Runway markings & lighting", a.runwayLengthM * (a.runways * 4), "m", "Centreline + edge + approach");
    add("terminal", "Buildings", "Terminal building", a.terminalAreaM2, "m²", "Terminal gross area");
    add("tower", "Buildings", "Control tower", 1, "nos", "ATC facility");
    if (a.fuelFarm) add("fuel", "Buildings", "Fuel farm (tanks & bund)", 4, "nos", "Aviation fuel storage");
    summary.push(
      { label: "Runway", value: `${a.runways} × ${a.runwayLengthM} × ${a.runwayWidthM} m` },
      { label: "ARC", value: a.aerodromeCode },
      { label: "Runway pavement", value: `${round(rArea, 0)} m²` },
      { label: "Apron", value: `${round(apron, 0)} m²` },
    );
  } else if (infra.kind === "ports") {
    const p = infra.ports!;
    const quayLen = p.berthLengthM * p.berths;
    add("dredging", "Marine", "Capital dredging", quayLen * p.quayWidthM * p.channelDepthM, "m³", "Quay footprint × channel depth");
    add("breakwater", "Marine", "Breakwater (rock armour)", p.breakwaterLengthM * 8 * 5, "m³", "Length × crown × armour");
    add("quay", "Marine", p.quayType === "solid" ? "Quay wall (solid)" : "Quay deck (open-piled)", quayLen, "m", "Berth length");
    add("reclamation", "Marine", "Land reclamation / filling", p.quayWidthM * quayLen * 4, "m³", "Quay strip × reclamation depth");
    add("yard", "Yard", "Container yard paving", p.containerYardM2, "m²", "Yard area");
    add("containers", "Yard", "Container stacks (TEU)", Math.round(p.containerYardM2 / 15), "TEU", "Yard area / 15 m² per TEU");
    add("cranes", "Equipment", `Ship-to-shore cranes (${p.cranes})`, p.cranes, "nos", "Quay crane count");
    add("warehouses", "Buildings", `Warehouses (${p.warehouses})`, p.warehouses, "nos", "Transit storage");
    add("utilities", "Buildings", "RTG, reefer points & utilities", 1, "lot", "Yard services");
    summary.push(
      { label: "Berths", value: `${p.berths} × ${p.berthLengthM} m` },
      { label: "Quay length", value: `${quayLen} m` },
      { label: "Draft", value: `${p.draftM} m` },
      { label: "Yard", value: `${p.containerYardM2.toLocaleString()} m²` },
    );
  } else {
    const d = infra.dams!;
    const baseW = d.damType === "gravity" ? d.crestWidthM + d.heightM * (d.downstreamSlope + 0.15) : d.heightM * (d.upstreamSlope + d.downstreamSlope) + d.crestWidthM;
    const damVol = ((d.crestWidthM + baseW) / 2) * d.heightM * d.crestLengthM;
    add("excavation", "Earthwork", "Foundation excavation", d.crestLengthM * baseW * d.groutCurtainDepthM * 0.15, "m³", "Dam base × curtain depth × 0.15");
    add("dam", "Dam body", d.damType === "earthen" || d.damType === "rockfill" ? "Embankment fill / rockfill" : "Concrete / masonry in dam", damVol, "m³", "Mean section area × crest length");
    add("grout", "Dam body", "Grout curtain & consolidation", d.crestLengthM * d.groutCurtainDepthM, "m²", "Crest length × curtain depth");
    add("spillway", "Spillway", `${d.spillwayType} spillway concrete`, d.spillwayCapacityCumec * 0.35, "m³", "Capacity-based allowance");
    add("gates", "Spillway", `Radial gates (${d.spillwayGates} nos)`, d.spillwayGates, "nos", "Gate count");
    if (d.stillingBasin) add("basin", "Spillway", "Stilling basin", d.spillwayCapacityCumec * 0.18, "m³", "Energy dissipation allowance");
    add("reservoir", "Reservoir", "Reservoir clearing", d.reservoirAreaM2 * 0.12, "m²", "Submergence area × 0.12");
    add("instrumentation", "Reservoir", "Instrumentation & gates control", 1, "lot", "Monitoring systems");
    summary.push(
      { label: "Dam", value: `${d.damType} · ${d.heightM} m high` },
      { label: "Crest", value: `${d.crestLengthM} m` },
      { label: "Spillway", value: `${d.spillwayType} · ${d.spillwayCapacityCumec} cumec` },
      { label: "Reservoir", value: `${d.reservoirAreaM2.toLocaleString()} m²` },
    );
  }

  for (const facility of infra.facilities ?? []) {
    add(`facility-${facility.id}`, "Facilities", `${facility.kind} (${facility.count} nos)`, facility.count, "nos", `${facility.lengthM} × ${facility.widthM} × ${facility.heightM} m stored facility schedule`);
  }
  if ((infra.drafts ?? []).length > 0) {
    add("civil-drafts", "Schedules", "Civil drafting annotations", infra.drafts!.length, "nos", "Stored contour, alignment and grade geometry");
  }

  const order = ["Earthwork", "Pavement", "Dam body", "Spillway", "Reservoir", "Marine", "Yard", "Structures", "Finishes", "Buildings", "Equipment", "Facilities", "Schedules"];
  const groups = order
    .map((group) => ({ group, items: items.filter((i) => i.group === group) }))
    .filter((g) => g.items.length > 0);

  return { items, groups, summary };
}

/* ----------------------------------- Notes ---------------------------------- */

export function buildInfraNotesText({ projectName, infra }: { projectName: string; infra: InfraDesign }): string {
  const t = computeInfraTakeoff(infra);
  const now = new Date();
  const lines: string[] = [];
  lines.push(`# ${projectName}`);
  lines.push(`${INFRA_LABELS[infra.kind]} · generated ${now.toLocaleString()}`);
  lines.push("");

  if (infra.location) {
    lines.push("## Location");
    lines.push(`Coordinates .............. ${infra.location.lat.toFixed(6)}, ${infra.location.lng.toFixed(6)}`);
    if (infra.location.address) lines.push(`Address .................. ${infra.location.address}`);
    if (infra.location.routeLengthM) lines.push(`Route length ............. ${round(infra.location.routeLengthM, 0)} m`);
    if (infra.location.routeBearingDeg !== undefined) lines.push(`Route bearing ............ ${infra.location.routeBearingDeg}°`);
    if (infra.location.boundary) lines.push(`Boundary ................. ${infra.location.boundary.length} vertices`);
    lines.push("https://earth.google.com/web/@" + `${infra.location.lat.toFixed(6)},${infra.location.lng.toFixed(6)},0a,800d,35y,0h,0t,0r`);
    lines.push("");
  }

  lines.push(`## ${INFRA_LABELS[infra.kind]}`);
  lines.push(infraSummary(infra));
  lines.push("");
  const cfgLines: string[] = [];
  const push = (k: string, v: string | number) => cfgLines.push(`${k}: ${v}`);
  if (infra.highway) {
    const h = infra.highway;
    push("Lanes", h.lanes);
    push("Lane width", `${h.laneWidthM} m`);
    push("Median", `${h.medianM} m`);
    push("Shoulder", `${h.shoulderM} m`);
    push("Design speed", `${h.designSpeedKph} km/h`);
    push("Surface", h.surface);
    push("Pavement thickness", `${h.pavementThicknessMm} mm`);
    push("Cross slope", `${h.crossSlopePct}%`);
    push("Culverts", h.culverts);
    push("Interchanges", h.interchanges);
  }
  if (infra.airport) {
    const a = infra.airport;
    push("Runways", a.runways);
    push("Runway size", `${a.runwayLengthM} × ${a.runwayWidthM} m`);
    push("Heading", `${a.runwayHeadingDeg}°`);
    push("Taxiways", a.taxiways);
    push("Apron depth", `${a.apronDepthM} m`);
    push("Terminal", `${a.terminalAreaM2.toLocaleString()} m²`);
    push("Stands", a.stands);
    push("Aerodrome code", a.aerodromeCode);
  }
  if (infra.ports) {
    const p = infra.ports;
    push("Berths", p.berths);
    push("Berth length", `${p.berthLengthM} m`);
    push("Draft", `${p.draftM} m`);
    push("Quay width", `${p.quayWidthM} m`);
    push("Quay type", p.quayType);
    push("Breakwater", `${p.breakwaterLengthM} m`);
    push("Container yard", `${p.containerYardM2.toLocaleString()} m²`);
    push("Cranes", p.cranes);
  }
  if (infra.dams) {
    const d = infra.dams;
    push("Dam type", d.damType);
    push("Height", `${d.heightM} m`);
    push("Crest length", `${d.crestLengthM} m`);
    push("Crest width", `${d.crestWidthM} m`);
    push("Spillway", d.spillwayType);
    push("Spillway capacity", `${d.spillwayCapacityCumec} cumec`);
    push("Gates", `${d.spillwayGates} × ${d.gateWidthM} m`);
    push("Stilling basin", d.stillingBasin ? "Yes" : "No");
  }
  lines.push(`- Model status: ${infra.modelReady === false ? "not generated" : "generated"}`);
  lines.push(...cfgLines.map((l) => `- ${l}`));
  lines.push("");

  if ((infra.facilities ?? []).length > 0 || (infra.drafts ?? []).length > 0) {
    lines.push("## Facility & civil annotation schedule");
    for (const facility of infra.facilities ?? []) {
      lines.push(`- ${facility.kind} · ${facility.count} nos · ${facility.lengthM} × ${facility.widthM} × ${facility.heightM} m`);
    }
    for (const draft of infra.drafts ?? []) {
      lines.push(`- ${draft.kind} · ${draft.civilKind ?? "annotation"} · ${draft.w} m at (${draft.x}, ${draft.z}) · elevation ${draft.elevationM ?? 0} m · grade ${draft.gradePct ?? 0}%`);
    }
    lines.push("");
  }

  const findings = infraReviewFindings(infra);
  const markups = infra.review?.markers ?? [];
  lines.push("## Coordination review");
  lines.push(`Automatic findings · ${findings.length}`);
  findings.forEach((finding) => lines.push(`- ${finding.severity} (${finding.score}/100, ${finding.category}): ${finding.text} [${finding.approximation}]`));
  lines.push(`Saved markups · ${markups.length}`);
  markups.forEach((marker) => lines.push(`- ${marker.severity} / ${marker.status}: ${marker.text}`));
  lines.push("");

  lines.push("## Material takeoff");
  for (const g of t.groups) {
    lines.push(`### ${g.group}`);
    for (const item of g.items) {
      lines.push(`${item.label} ............ ${item.qty.toLocaleString()} ${item.unit} (${item.basis})`);
    }
    lines.push("");
  }
  lines.push("Estimates follow conventional practice and standard work-item norms.");
  lines.push("Verify against detailed design drawings and a certified BOQ before procurement.");
  lines.push("");
  return lines.join("\n");
}

/* -------------------------------- Design glue ------------------------------- */

export function ensureInfraDesign(design: Design, kind: InfraKind): Design {
  return { ...design, infra: normalizeInfra(design.infra, kind) };
}

