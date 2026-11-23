import type { BuildingLevel, Design, DraftElement, FurnitureItem, MepElement } from "../types";
import { catalogEntry } from "./catalog";
import { amenityFootprint, landMeters, towerMeters } from "./community";
import { engineeringProvenanceAscii } from "./exchangeProvenance";
import { defaultHighway, highwayPlanDimensions } from "./infra";
import { dxfLineweightHundredthsMm, formatDimensionMetres, technicalGraphicsSettings } from "./technicalGraphics";
import { resolveDraft } from "./parametric";

type Point = [number, number];

function rotatedBox(x: number, y: number, width: number, depth: number, angleDeg = 0): Point[] {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]].map(([px, py]) => [
    x + px * cos - py * sin,
    y + px * sin + py * cos,
  ]);
}

function furnitureBox(item: FurnitureItem): Point[] {
  const entry = catalogEntry(item.type);
  return rotatedBox(item.x, item.z, (entry?.w ?? 1000) * item.scale, (entry?.d ?? 1000) * item.scale, item.rotationDeg);
}

function safeLayer(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 31) || "0";
}

function dxfNumber(value: number, precision = 3): string {
  // Avoid both invalid coordinates and toFixed's exponential form for large numbers.
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new Error("DXF export requires finite coordinates within the supported drafting range.");
  const rounded = value.toFixed(precision);
  return Number(rounded) === 0 ? (0).toFixed(precision) : rounded;
}

function dxfText(value: string): string {
  let encoded = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 32;
    if (code < 32 || code === 127) encoded += " ";
    // R2000 uses UCS-2 escapes; upper-plane characters have no portable representation.
    else if (code > 0xffff) encoded += "?";
    else if (code > 126 || character === "\\" || character === "%") encoded += `\\U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else encoded += character;
  }
  return encoded;
}

/** R2000 ASCII DXF in millimetres. This is a 2D projection, with approximated fabrication details and spline control polygons. */
export function buildDxf(design: Design): string {
  const entities: string[] = [];
  const graphics = technicalGraphicsSettings(design.technicalGraphics);
  const layerNames = ["0", "WALLS", "COLUMNS", "BEAMS", "SLABS", "ROOFS", "OPENINGS", "DIMENSIONS", "TEXT", "FURNITURE", "CURTAINS", "MEP_DUCT", "MEP_PIPE", "MEP_CABLE", "MEP_EQUIPMENT", "DRAFTING", "FACILITIES", "SITE", "STRUCTURAL_GRID", "HIGHWAY_CARRIAGEWAY", "HIGHWAY_MEDIAN", "HIGHWAY_SHOULDER"];
  // Fixed table/block handles and ordered entity handles make repeated exports deterministic.
  let nextHandle = 0x20 + layerNames.length;
  const handle = () => (nextHandle++).toString(16).toUpperCase();
  const ent = (...parts: string[]) => entities.push(...parts);
  const entity = (kind: string, layer: string, subclass: string) => {
    const name = safeLayer(layer);
    if (!layerNames.includes(name)) throw new Error(`Unknown DXF layer: ${name}`);
    ent("0", kind, "5", handle(), "330", "7", "100", "AcDbEntity", "8", name, "100", subclass);
  };
  const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const point = (x: number, y: number): [string, string] => {
    const pair: [string, string] = [dxfNumber(x), dxfNumber(y)];
    bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
    return pair;
  };
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => {
    const a = point(x1, y1); const b = point(x2, y2);
    entity("LINE", layer, "AcDbLine");
    ent("10", a[0], "20", a[1], "30", "0.000", "11", b[0], "21", b[1], "31", "0.000");
  };
  const text = (layer: string, x: number, y: number, value: string, height = 150) => {
    if (!Number.isFinite(height) || height <= 0) throw new Error("DXF text requires a positive height.");
    const position = point(x, y);
    const content = dxfText(value);
    point(x + value.length * height, y + height); // Conservative annotation bounds, independent of viewer font.
    entity("TEXT", layer, "AcDbText");
    ent("10", position[0], "20", position[1], "30", "0.000", "40", dxfNumber(height), "1", content, "7", "STANDARD", "100", "AcDbText", "73", "0");
  };
  const polyline = (layer: string, points: Point[], closed = false) => {
    if (points.length < 2) return;
    const coordinates = points.map(([x, y]) => point(x, y));
    const first = coordinates[0]; const last = coordinates[coordinates.length - 1];
    // A repeated terminal vertex already expresses closure in older saved paths.
    if (coordinates.length > 2 && first[0] === last[0] && first[1] === last[1]) { coordinates.pop(); closed = true; }
    entity("LWPOLYLINE", layer, "AcDbPolyline");
    ent("90", String(coordinates.length), "70", closed ? "1" : "0", "38", "0.000");
    for (const coordinate of coordinates) ent("10", coordinate[0], "20", coordinate[1]);
  };
  const box = (layer: string, points: Point[]) => polyline(layer, points, true);
  const circle = (layer: string, x: number, y: number, radius: number) => {
    if (!Number.isFinite(radius) || radius <= 0 || Number(dxfNumber(radius)) <= 0) throw new Error("DXF circles require a positive radius at the 0.001 mm export precision.");
    const center = point(x, y); point(x - radius, y - radius); point(x + radius, y + radius);
    entity("CIRCLE", layer, "AcDbCircle");
    ent("10", center[0], "20", center[1], "30", "0.000", "40", dxfNumber(radius));
  };
  const arc = (layer: string, x: number, y: number, radius: number, startDeg: number, endDeg: number) => {
    if (!Number.isFinite(radius) || radius <= 0 || Number(dxfNumber(radius)) <= 0 || !Number.isFinite(startDeg) || !Number.isFinite(endDeg)) throw new Error("DXF arcs require a positive radius at the 0.001 mm export precision and finite angles.");
    if (Math.abs(endDeg - startDeg) >= 360) { circle(layer, x, y, radius); return; }
    const center = point(x, y); point(x - radius, y - radius); point(x + radius, y + radius);
    const angle = (degrees: number) => dxfNumber(((degrees % 360) + 360) % 360, 6);
    entity("ARC", layer, "AcDbCircle");
    ent("10", center[0], "20", center[1], "30", "0.000", "40", dxfNumber(radius), "100", "AcDbArc", "50", angle(startDeg), "51", angle(endDeg));
  };
  const dimension = (x1: number, y1: number, x2: number, y2: number, label: string) => {
    line("DIMENSIONS", x1, y1, x2, y2);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length * 80;
    const ny = dx / length * 80;
    line("DIMENSIONS", x1, y1, x1 + nx, y1 + ny);
    line("DIMENSIONS", x2, y2, x2 + nx, y2 + ny);
    text("DIMENSIONS", (x1 + x2) / 2 + nx, (y1 + y2) / 2 + ny, label, 100);
  };

  const layerWeight = (name: string) => {
    if (name === "WALLS") return graphics.lineweights.walls;
    if (name === "COLUMNS" || name === "BEAMS" || name === "SLABS" || name === "ROOFS" || name === "STRUCTURAL_GRID") return graphics.lineweights.structure;
    if (name.startsWith("MEP_")) return graphics.lineweights.mep;
    if (name === "FURNITURE" || name === "CURTAINS") return graphics.lineweights.furniture;
    if (name === "DIMENSIONS") return graphics.lineweights.dimensions;
    if (name === "TEXT") return graphics.lineweights.annotations;
    return graphics.lineweights.site;
  };
  if (!design.community && !design.infra) {
    const { widthMm: roomWidth, depthMm: roomDepth } = design.room;
    if (!Number.isFinite(roomWidth) || !Number.isFinite(roomDepth) || roomWidth <= 0 || roomDepth <= 0) throw new Error("DXF export requires positive, finite room dimensions.");
    box("WALLS", rotatedBox(0, 0, roomWidth, roomDepth));
    dimension(-roomWidth / 2, -roomDepth / 2 - 300, roomWidth / 2, -roomDepth / 2 - 300, formatDimensionMetres(roomWidth / 1000, graphics.dimensionStyle));
    dimension(roomWidth / 2 + 300, -roomDepth / 2, roomWidth / 2 + 300, roomDepth / 2, formatDimensionMetres(roomDepth / 1000, graphics.dimensionStyle));
    design.furniture.forEach((item) => { box("FURNITURE", furnitureBox(item)); text("TEXT", item.x, item.z, item.name, 90); });
    if (design.curtains?.enabled) {
      const cur = design.curtains;
      const span = (cur.wall === "north" || cur.wall === "south" ? roomWidth : roomDepth) * cur.widthPercentPerPanel;
      for (let i = 0; i < 2; i++) {
        const offset = (i - 0.5) * span;
        if (cur.wall === "north") line("CURTAINS", offset - 30, roomDepth / 2, offset + 30, roomDepth / 2);
        if (cur.wall === "south") line("CURTAINS", offset - 30, -roomDepth / 2, offset + 30, -roomDepth / 2);
        if (cur.wall === "east") line("CURTAINS", roomWidth / 2, offset - 30, roomWidth / 2, offset + 30);
        if (cur.wall === "west") line("CURTAINS", -roomWidth / 2, offset - 30, -roomWidth / 2, offset + 30);
      }
      text("TEXT", 0, 0, `CURTAINS (${cur.style})`, 90);
    }
  }

  const addDraft = (draft: DraftElement, levels: BuildingLevel[]) => {
    const resolved = resolveDraft(draft, levels);
    const layer = draft.kind === "wall" ? "WALLS" : draft.kind === "column" ? "COLUMNS" : draft.kind === "beam" ? "BEAMS" : draft.kind === "slab" ? "SLABS" : draft.kind === "roof" ? "ROOFS" : "DRAFTING";
    const x = draft.x * 1000;
    const y = draft.z * 1000;
    const angle = (draft.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const localToWorld = (point: { x: number; z: number }): Point => [
      x + (point.x * cos + point.z * sin) * 1000,
      y + (-point.x * sin + point.z * cos) * 1000,
    ];
    if (draft.kind === "circle" || draft.kind === "column" && draft.family?.type === "circular-column") {
      circle(layer, x, y, resolved.width * 500);
    } else if (draft.kind === "arc") {
      arc(layer, x, y, Math.max(draft.radiusM ?? resolved.width / 2, 0.05) * 1000, (draft.startAngleDeg ?? 0) - draft.rotationDeg, (draft.endAngleDeg ?? 180) - draft.rotationDeg);
    } else if ((draft.kind === "slab" || draft.kind === "roof") && draft.points && draft.points.length >= 3) {
      polyline(layer, draft.points.map(localToWorld), true);
    } else if (draft.kind === "polyline" || draft.kind === "spline") {
      const points = (draft.points?.length ? draft.points : [{ x: -resolved.width / 2, z: 0 }, { x: resolved.width / 2, z: 0 }]).map(localToWorld);
      polyline(layer, points, false);
    } else if (draft.kind === "dimension") {
      const half = resolved.width * 500;
      const a = localToWorld({ x: -resolved.width / 2, z: 0 });
      const b = localToWorld({ x: resolved.width / 2, z: 0 });
      dimension(a[0], a[1], b[0], b[1], draft.label || formatDimensionMetres(half * 2 / 1000, graphics.dimensionStyle));
    } else if (draft.kind === "line") {
      const a = localToWorld({ x: -resolved.width / 2, z: 0 });
      const b = localToWorld({ x: resolved.width / 2, z: 0 });
      line(layer, a[0], a[1], b[0], b[1]);
    } else {
      box(layer, rotatedBox(x, y, resolved.width * 1000, resolved.depth * 1000, -draft.rotationDeg));
    }
    // Registered XDATA retains stable object identity without conflating DXF handles with model IDs.
    ent("1001", "GROUNDWORK", "1000", dxfText(draft.id), "1000", dxfText(draft.kind), "1040", String(design.cad?.revision ?? 0));
    for (const opening of draft.openings ?? []) {
      const middle = localToWorld({ x: opening.offsetM, z: 0 });
      box("OPENINGS", rotatedBox(middle[0], middle[1], opening.widthM * 1000, resolved.depth * 1000, -draft.rotationDeg));
      ent("1001", "GROUNDWORK", "1000", dxfText(opening.id), "1000", dxfText(`host:${draft.id}`));
      text("TEXT", middle[0], middle[1], `${opening.kind} H=${opening.heightM}m sill=${opening.sillM}m [plan opening]`, 70);
    }
    if (draft.label) text("TEXT", x, y, draft.label, 90);
  };
  for (const draft of design.community?.drafts ?? []) addDraft(draft, design.community?.levels?.length ? design.community.levels : design.cad?.levels ?? []);
  for (const draft of design.infra?.drafts ?? []) addDraft(draft, design.cad?.levels ?? []);
  if (!design.community && !design.infra) for (const draft of design.drafts ?? []) addDraft(draft, design.cad?.levels ?? []);

  const addMep = (element: MepElement) => {
    const layer = element.kind === "duct" ? "MEP_DUCT" : element.kind === "pipe" ? "MEP_PIPE" : element.kind === "cable-tray" ? "MEP_CABLE" : "MEP_EQUIPMENT";
    for (let i = 1; i < element.route.length; i++) line(layer, element.route[i - 1].x * 1000, element.route[i - 1].z * 1000, element.route[i].x * 1000, element.route[i].z * 1000);
    if (element.route[0]) text("TEXT", element.route[0].x * 1000, element.route[0].z * 1000, `${element.name} [approx.]`, 80);
  };
  for (const element of [...(design.mep?.elements ?? []), ...(design.community?.mep?.elements ?? []), ...(design.infra?.mep?.elements ?? [])]) addMep(element);

  if (design.community) {
    const land = landMeters(design.community.land);
    box("SITE", rotatedBox(0, 0, land.w * 1000, land.d * 1000));
    for (const tower of design.community.towers) {
      const { w, d } = towerMeters(tower);
      box("WALLS", rotatedBox(tower.x * 1000, tower.z * 1000, w * 1000, d * 1000, -(tower.rotY ?? 0)));
      text("TEXT", tower.x * 1000, tower.z * 1000, `${tower.label} (${tower.floors}F)`, 100);
    }
    for (const amenity of design.community.amenities) {
      const { w, d, diameter } = amenityFootprint(amenity);
      if (diameter !== undefined) circle("SITE", amenity.x * 1000, amenity.z * 1000, diameter * 500);
      else box("SITE", rotatedBox(amenity.x * 1000, amenity.z * 1000, w * 1000, d * 1000, -amenity.rotY));
    }
  }
  if (design.infra?.kind === "highway") {
    const highway = { ...defaultHighway(), ...design.infra.highway };
    const { length, carriageway, median } = highwayPlanDimensions(highway, design.infra.location);
    const strip = (layer: string, x: number, width: number) => {
      box(layer, rotatedBox(x * 1000, 0, width * 1000, length * 1000));
    };
    if (median > 0) {
      const separation = median / 2 + carriageway / 4;
      strip("HIGHWAY_CARRIAGEWAY", -separation, carriageway / 2);
      strip("HIGHWAY_CARRIAGEWAY", separation, carriageway / 2);
      strip("HIGHWAY_MEDIAN", 0, median);
    } else strip("HIGHWAY_CARRIAGEWAY", 0, carriageway);
    if (highway.shoulderM > 0) {
      const shoulderCenter = (carriageway + median + highway.shoulderM) / 2;
      strip("HIGHWAY_SHOULDER", -shoulderCenter, highway.shoulderM);
      strip("HIGHWAY_SHOULDER", shoulderCenter, highway.shoulderM);
    }
    text("TEXT", 0, -length * 500, "CONCEPT HIGHWAY - LOCAL PLAN", 250);
  }
  if (design.infra) for (const facility of design.infra.facilities ?? []) {
    box("FACILITIES", rotatedBox(0, 0, facility.widthM * 1000, facility.lengthM * 1000));
    text("TEXT", 0, 0, `${facility.kind} x${facility.count} [approx.]`, 100);
  }
  const lines: string[] = [];
  const out = (...parts: string[]) => lines.push(...parts);
  if (design.infra?.kind === "highway") {
    out("999", "Straight local highway concept plan. Survey alignment, terrain, interchanges and culverts are outside this projection.");
  }
  // Group 999 comments are optional exchange metadata and may be discarded by CAD tools.
  const provenance = engineeringProvenanceAscii(design.engineeringBasis), chunkCount = Math.ceil(provenance.length / 180);
  for (let chunk = 0; chunk < chunkCount; chunk++) out("999", `SECURE_NEXUS_BASIS ${chunk + 1}/${chunkCount} ${provenance.slice(chunk * 180, (chunk + 1) * 180)}`);
  out("0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1015", "9", "$DWGCODEPAGE", "3", "ANSI_1252", "9", "$HANDSEED", "5", nextHandle.toString(16).toUpperCase(), "9", "$INSUNITS", "70", "4", "9", "$MEASUREMENT", "70", "1", "9", "$EXTMIN", "10", dxfNumber(bounds.minX), "20", dxfNumber(bounds.minY), "30", "0.000", "9", "$EXTMAX", "10", dxfNumber(bounds.maxX), "20", dxfNumber(bounds.maxY), "30", "0.000", "0", "ENDSEC");
  out("0", "SECTION", "2", "TABLES");
  const table = (name: string, tableHandle: string, entries: number) => out("0", "TABLE", "2", name, "5", tableHandle, "330", "0", "100", "AcDbSymbolTable", "70", String(entries));
  const record = (name: string, recordHandle: string, owner: string, subclass: string) => out("0", name, "5", recordHandle, "330", owner, "100", "AcDbSymbolTableRecord", "100", subclass);
  table("LTYPE", "1", 1);
  record("LTYPE", "2", "1", "AcDbLinetypeTableRecord");
  out("2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.000", "0", "ENDTAB");
  table("LAYER", "3", layerNames.length);
  layerNames.forEach((name, index) => {
    record("LAYER", (0x20 + index).toString(16).toUpperCase(), "3", "AcDbLayerTableRecord");
    // Keep the pre-existing layer colours while adding the mandatory default layer.
    out("2", name, "70", "0", "62", name === "0" ? "7" : String(((index - 1) % 7) + 1), "6", "CONTINUOUS", "370", String(dxfLineweightHundredthsMm(layerWeight(name))));
  });
  out("0", "ENDTAB");
  table("APPID", "D", 1);
  record("APPID", "E", "D", "AcDbRegAppTableRecord"); out("2", "GROUNDWORK", "70", "0", "0", "ENDTAB");
  table("STYLE", "4", 1);
  record("STYLE", "5", "4", "AcDbTextStyleTableRecord");
  out("2", "STANDARD", "70", "0", "40", "0.000", "41", "1.000", "50", "0.000", "71", "0", "42", "2.500", "3", "txt", "4", "", "0", "ENDTAB");
  table("BLOCK_RECORD", "6", 2);
  record("BLOCK_RECORD", "7", "6", "AcDbBlockTableRecord"); out("2", "*Model_Space");
  record("BLOCK_RECORD", "8", "6", "AcDbBlockTableRecord"); out("2", "*Paper_Space");
  out("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "BLOCKS");
  const block = (name: string, owner: string, beginHandle: string, endHandle: string, paper = false) => {
    out("0", "BLOCK", "5", beginHandle, "330", owner, "100", "AcDbEntity");
    if (paper) out("67", "1");
    out("8", "0", "100", "AcDbBlockBegin", "2", name, "70", "0", "10", "0.000", "20", "0.000", "30", "0.000", "3", name, "1", "", "0", "ENDBLK", "5", endHandle, "330", owner, "100", "AcDbEntity");
    if (paper) out("67", "1");
    out("8", "0", "100", "AcDbBlockEnd");
  };
  block("*Model_Space", "7", "9", "A"); block("*Paper_Space", "8", "B", "C", true);
  out("0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  for (const part of entities) lines.push(part);
  out("0", "ENDSEC", "0", "EOF");
  return lines.join("\r\n") + "\r\n";
}

