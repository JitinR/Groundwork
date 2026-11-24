import type { BuildingLevel, Design, DraftElement, MepElement, ReviewMarker } from "../types";
import { resolveDraft, resolveRoomOpening, resolveTowerOpening, parametricIssues } from "./parametric";
import { amenityFootprint, towerMeters, undergroundParkingBayLayout } from "./community";
import { engineeringExchangeProvenance, engineeringProvenanceAscii } from "./exchangeProvenance";
import { cadFootprintArea } from "./cadModel";
import { quoteCsvCell } from "./csv";

export interface ExchangeEntity {
  id: string;
  type: string;
  name?: string;
  levelId?: string;
  geometry?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

const number = (value: number) => Math.round(value * 1000) / 1000;

function entity(id: string, type: string, data: Omit<ExchangeEntity, "id" | "type"> = {}): ExchangeEntity {
  return { id, type, ...data };
}

function mepEntity(element: MepElement): ExchangeEntity {
  return entity(element.id, `MEP_${element.kind.toUpperCase().replace("-", "_")}`, {
    name: element.name,
    levelId: element.levelId,
    geometry: { kind: "polyline", points: element.route, widthM: element.width, heightM: element.height, diameterM: element.diameter },
    properties: { visible: element.visible, system: element.system, zoneId: element.zoneId, connectedTo: element.connectedTo ?? [], approximation: "Coordination route and nominal envelope; not fabrication geometry." },
  });
}

function reviewEntity(marker: ReviewMarker): ExchangeEntity {
  return entity(marker.id, "REVIEW_MARKER", {
    name: marker.text,
    geometry: { kind: "point", xM: number(marker.x), zM: number(marker.z) },
    properties: { severity: marker.severity, status: marker.status, targetIds: marker.targetIds ?? [] },
  });
}

/** IFC-like exchange for coordination tools. This is JSON, not a standards-compliant IFC file. */
export function buildBimExchange(design: Design): string {
  const entities: ExchangeEntity[] = [];
  const room = design.room;
  entities.push(entity("room", "SPACE", {
    name: "Room shell",
    geometry: { kind: "box", xM: room.widthMm / 2000, zM: room.depthMm / 2000, widthM: room.widthMm / 1000, depthM: room.depthMm / 1000, heightM: room.wallHeightMm / 1000 },
    properties: { wallColor: room.wallColor, floorColor: room.floorColor },
  }));
  const roomWidth = room.widthMm / 1000;
  const roomDepth = room.depthMm / 1000;
  const roomHeight = room.wallHeightMm / 1000;
  entities.push(
    entity("room-slab", "SLAB", {
      name: "Room floor slab",
      geometry: { kind: "box", xM: roomWidth / 2, zM: roomDepth / 2, widthM: roomWidth, depthM: roomDepth, heightM: 0.15 },
      properties: { approximation: "Nominal room floor slab; thickness is an exchange default." },
    }),
    entity("room-roof", "ROOF", {
      name: "Room roof",
      geometry: { kind: "box", xM: roomWidth / 2, zM: roomDepth / 2, yM: roomHeight, widthM: roomWidth, depthM: roomDepth, heightM: 0.15 },
      properties: { approximation: "Nominal flat roof; roof build-up and drainage are not modeled." },
    }),
    entity("room-wall-north", "WALL", { name: "North wall", geometry: { kind: "box", xM: roomWidth / 2, zM: 0, widthM: roomWidth, depthM: 0.15, heightM: roomHeight } }),
    entity("room-wall-south", "WALL", { name: "South wall", geometry: { kind: "box", xM: roomWidth / 2, zM: roomDepth, widthM: roomWidth, depthM: 0.15, heightM: roomHeight } }),
    entity("room-wall-east", "WALL", { name: "East wall", geometry: { kind: "box", xM: roomWidth, zM: roomDepth / 2, widthM: 0.15, depthM: roomDepth, heightM: roomHeight } }),
    entity("room-wall-west", "WALL", { name: "West wall", geometry: { kind: "box", xM: 0, zM: roomDepth / 2, widthM: 0.15, depthM: roomDepth, heightM: roomHeight } }),
  );

  for (const item of design.furniture) {
    entities.push(entity(item.id, "FURNISHING", {
      name: item.name,
      geometry: { kind: "box", xM: item.x / 1000, zM: item.z / 1000, rotationDeg: item.rotationDeg, scale: item.scale },
      properties: { catalogType: item.type, color: item.color, mount: item.mount ?? "unassigned", mountWall: item.mountWall },
    }));
  }
  for (const element of design.mep?.elements ?? []) entities.push(mepEntity(element));

  const addDraft = (draft: DraftElement, levels: BuildingLevel[]) => {
    const resolved = resolveDraft(draft, levels);
    const circular = draft.kind === "column" && draft.family?.type === "circular-column";
    const openingVolume = (draft.openings ?? []).reduce((sum, opening) => sum + opening.widthM * opening.heightM * resolved.depth, 0);
    const polygon = (draft.kind === "slab" || draft.kind === "roof") && draft.points && draft.points.length >= 3;
    const grossVolume = cadFootprintArea(draft, levels) * resolved.height;
    entities.push(entity(draft.id, `DRAFT_${draft.kind.toUpperCase()}`, {
      name: draft.label, levelId: draft.family?.levelId,
      geometry: { kind: circular ? "cylinder" : polygon ? "polygon-extrusion" : "box", points: polygon ? draft.points : undefined, xM: draft.x, zM: draft.z, widthM: resolved.width, depthM: resolved.depth, heightM: resolved.height, radiusM: circular ? resolved.width / 2 : undefined, rotationDeg: draft.rotationDeg, yM: resolved.elevation },
      properties: { material: draft.material, visible: draft.visible !== false, locked: draft.locked === true, color: draft.color, civilKind: draft.civilKind, elevationM: resolved.elevation, gradePct: draft.gradePct, family: draft.family, hostId: draft.family?.hostId, slopePct: resolved.slope, overhangM: resolved.overhang, grossVolumeM3: grossVolume, netVolumeM3: Math.max(0, grossVolume - openingVolume), openings: draft.openings, approximation: "Parametric envelope with authored dimensions; sloped roofs, detailed build-ups and fabrication details require a downstream model. Explicit door/window hosts retain IFC void/fill relationships." },
    }));
    const angle = draft.rotationDeg * Math.PI / 180;
    for (const opening of draft.openings ?? []) {
      entities.push(entity(opening.id, opening.kind === "door" ? "DOOR" : opening.kind === "window" ? "WINDOW" : "OPENING_INTENT", {
        name: `${opening.kind} in ${draft.label ?? draft.id}`, levelId: draft.family?.levelId,
        geometry: { kind: "opening", xM: draft.x + opening.offsetM * Math.cos(angle), zM: draft.z - opening.offsetM * Math.sin(angle), yM: resolved.elevation + opening.sillM, widthM: opening.widthM, depthM: resolved.depth, heightM: opening.heightM, rotationDeg: draft.rotationDeg },
        properties: { hostId: draft.id, cadHostedOpening: true, openingKind: opening.kind, approximation: opening.kind === "void" ? "Authored rectangular unfilled wall void; exported with an IFC host void relationship and no fill." : "Authored rectangular wall opening; generic fill geometry without frame, hardware or fabrication details." },
      }));
    }
    for (const message of parametricIssues(draft, levels)) entities.push(entity(`${draft.id}-validation-${message}`, "VALIDATION", { properties: { sourceId: draft.id, message } }));
  };
  if (!design.community && !design.infra) {
    for (const draft of design.drafts ?? []) addDraft(draft, design.cad?.levels ?? []);
    for (const level of design.cad?.levels ?? []) entities.push(entity(level.id, "BUILDING_STOREY", { name: level.name, properties: { elevationM: level.elevation, floorHeightM: level.floorHeight } }));
  }

  for (const c of [design.community, design.infra]) {
    if (!c) continue;
    for (const draft of c.drafts ?? []) addDraft(draft, "levels" in c && c.levels?.length ? c.levels : design.cad?.levels ?? []);
    if ("amenities" in c) {
      for (const amenity of c.amenities) {
        const footprint = amenityFootprint(amenity);
        entities.push(entity(amenity.id, "SITE_AMENITY", {
          name: amenity.label ?? amenity.kind,
          geometry: { kind: amenity.shape ?? (footprint.diameter === undefined ? "box" : "circle"), xM: amenity.x, zM: amenity.z, widthM: footprint.w, depthM: footprint.d, diameterM: footprint.diameter, heightM: amenity.h, rotationDeg: amenity.rotY },
          properties: { kind: amenity.kind, approximation: "Parametric site object; verify location and construction details." },
        }));
      }
      for (const roomPlan of c.interiors) {
        entities.push(entity(roomPlan.id, "SPACE", {
          name: roomPlan.name,
          levelId: roomPlan.towerId,
          geometry: { kind: "box", xM: roomPlan.x, zM: roomPlan.z, widthM: roomPlan.w, depthM: roomPlan.d, floor: roomPlan.floor },
          properties: { roomType: roomPlan.type, approximation: "Planning room envelope; openings and finishes are not fully exchanged." },
        }));
        for (const opening of roomPlan.openings ?? []) {
          const resolved = resolveRoomOpening(opening, opening.wall === "east" || opening.wall === "west" ? roomPlan.d : roomPlan.w);
          entities.push(entity(opening.id, opening.kind === "door" ? "DOOR" : "WINDOW", {
            name: `${opening.kind} ${opening.wall}`,
            levelId: roomPlan.towerId,
            geometry: { kind: "opening", xM: roomPlan.x + resolved.offset, zM: roomPlan.z, widthM: resolved.width, depthM: 0.1, heightM: resolved.height, yM: resolved.sill },
            properties: { wall: opening.wall, roomId: roomPlan.id, hostId: opening.family?.hostId ?? `room-wall-${opening.wall}`, family: opening.family, approximation: "Opening is exported as a typed element; host wall void and hardware are not modeled." },
          }));
        }
      }
      for (const tower of c.towers) {
        const towerSize = towerMeters(tower);
        for (const opening of tower.openings ?? []) {
          const resolved = resolveTowerOpening(opening, opening.face === "east" || opening.face === "west" ? towerSize.d : towerSize.w);
          entities.push(entity(opening.id, opening.kind === "door" ? "DOOR" : "WINDOW", {
            name: `${opening.kind} ${opening.face}`,
            levelId: `${tower.id}-floor-${opening.floor}`,
            geometry: { kind: "opening", xM: tower.x + resolved.offset, zM: tower.z, widthM: resolved.width, depthM: 0.1, heightM: resolved.height, yM: opening.floor * tower.floorHeight + resolved.sill, rotationDeg: tower.rotY ?? 0 },
            properties: { towerId: tower.id, face: opening.face, hostId: opening.family?.hostId ?? `${tower.id}-facade-${opening.face}`, family: opening.family, approximation: "Parametric opening; host facade, frame and hardware are not modeled." },
          }));
        }
      }
      for (const panel of c.exteriors) {
        entities.push(entity(panel.id, "FACADE_PANEL", {
          name: panel.material,
          geometry: { kind: "panel", xM: panel.x, yM: panel.y, widthM: panel.w, heightM: panel.h },
          properties: { towerId: panel.towerId, face: panel.face, approximation: "Facade intent panel; connections and build-up are not modeled." },
        }));
      }
      if (c.parking.mode !== "none") {
        entities.push(entity("parking", "PARKING_STRUCTURE", {
          properties: { mode: c.parking.mode, surfaceBays: c.parking.surfaceBays, underground: c.parking.underground, ...(c.parking.mode === "underground" ? { modeledBays: undergroundParkingBayLayout(c).capacity } : {}) },
        }));
      }
    }
    for (const level of "levels" in c ? c.levels ?? [] : []) {
      entities.push(entity(level.id, "BUILDING_STOREY", {
        name: level.name,
        properties: { elevationM: level.elevation, floorHeightM: level.floorHeight },
      }));
    }
    for (const grid of "structuralGrid" in c ? c.structuralGrid ?? [] : []) {
      entities.push(entity(grid.id, "GRID_AXIS", {
        name: grid.label,
        geometry: { axis: grid.axis, positionM: grid.position, extentM: grid.extent },
        properties: { color: grid.color },
      }));
    }
    for (const marker of c.review?.markers ?? []) entities.push(reviewEntity(marker));
    for (const element of c.mep?.elements ?? []) entities.push(mepEntity(element));
    if (c.terrain) {
      entities.push(entity("terrain", "TERRAIN_SURFACE", {
        properties: { ...c.terrain, approximation: "Deterministic local profile; no surveyed DEM or georeferenced surface." },
      }));
    }
    if ("structural" in c && c.structural) {
      entities.push(entity("structural-settings", "STRUCTURAL_ANALYSIS_INPUT", {
        properties: { ...c.structural, approximation: "Preliminary screening inputs; not a design-code calculation." },
      }));
    }
    if ("towers" in c) {
      for (const tower of c.towers) entities.push(entity(tower.id, "BUILDING", {
        name: tower.label,
        geometry: { xM: tower.x, zM: tower.z, floors: tower.floors, widthM: tower.unitWidth, depthM: tower.unitDepth, floorHeightM: tower.floorHeight },
        properties: { unitsPerFloor: tower.unitsPerFloor, facadeMaterial: tower.facadeMaterial },
      }));
    }
    if ("facilities" in c) {
      entities.push(entity("infra-model", "INFRASTRUCTURE_MODEL", {
        name: c.kind,
        properties: { kind: c.kind, highway: c.highway, airport: c.airport, ports: c.ports, dams: c.dams, approximation: "Parametric infrastructure summary; alignment and engineering disciplines require detailed design." },
      }));
      for (const facility of c.facilities ?? []) entities.push(entity(facility.id, "INFRA_FACILITY", {
        name: facility.kind,
        geometry: { kind: "box", widthM: facility.widthM, depthM: facility.lengthM, heightM: facility.heightM },
        properties: { kind: facility.kind, count: facility.count, lengthM: facility.lengthM, widthM: facility.widthM, heightM: facility.heightM },
      }));
    }
  }

  return JSON.stringify({
    exchange: "groundwork-ifc-like",
    schemaVersion: 1,
    engineeringProvenance: engineeringExchangeProvenance(design.engineeringBasis),
    generatedAt: new Date().toISOString(),
    units: "metres",
    standards: { ifc: false, note: "IFC-like coordination JSON; map entities to IFC classes in a downstream converter." },
    approximations: [
      "Drafting and structural geometry is exported as lightweight editable intent.",
      "Terrain is a local deterministic profile unless a surveyed surface is supplied.",
      "MEP routes are nominal coordination envelopes, not fabrication or code-compliant systems.",
      "Review markers and analysis inputs are metadata, not certification.",
    ],
    entities,
  }, null, 2) + "\n";
}

function ifcText(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function ifcGuid(key: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  let value = 0n;
  for (const character of key) value = (value * 1099511628211n + BigInt(character.charCodeAt(0))) & 0xffffffffffffffffn;
  let result = "";
  for (let index = 0; index < 22; index += 1) {
    result = alphabet[Number(value % BigInt(alphabet.length))] + result;
    value /= BigInt(alphabet.length);
  }
  return result;
}

/** Stable IFC product GUID used by source-linked coordination exchanges. */
export function ifcSourceGuid(sourceId: string, grid = false): string {
  return ifcGuid(`groundwork-ifc4:${grid ? "grid" : "product"}:${sourceId}`);
}

export interface BimValidationIssue {
  id: string;
  message: string;
}

export interface IfcValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  entityId?: number;
}

export interface IfcValidationReport {
  valid: boolean;
  parsedEntities: number;
  guidCount: number;
  normalized: boolean;
  issues: IfcValidationIssue[];
  sourceRoundTrip?: { checkedEntities: number; missingIds: string[]; changedIds: string[]; scope: string };
}

interface ParsedIfcEntity {
  id: number;
  type: string;
  fields: string;
  line: string;
}

/** Split only top-level STEP arguments; quoted commas and nested selects are preserved. */
function stepFields(value: string): string[] {
  const fields: string[] = [];
  let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "'") {
      if (quoted && value[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) { fields.push(value.slice(start, i).trim()); start = i + 1; }
    }
  }
  fields.push(value.slice(start).trim());
  return fields;
}

const productTypes = new Set([
  "IFCWALL", "IFCSLAB", "IFCROOF", "IFCCOLUMN", "IFCBEAM", "IFCSPACE", "IFCDOOR", "IFCWINDOW",
  "IFCFLOWSEGMENT", "IFCUNITARYEQUIPMENT", "IFCFLOWTERMINAL", "IFCFURNISHINGELEMENT",
  "IFCBUILDINGELEMENTPROXY", "IFCOPENINGELEMENT",
]);

function parseIfcEntities(step: string): { entities: ParsedIfcEntity[]; issues: IfcValidationIssue[]; lines: string[] } {
  const issues: IfcValidationIssue[] = [];
  const lines = step.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const entities: ParsedIfcEntity[] = [];
  const ids = new Set<number>();
  for (const line of lines) {
    const match = line.match(/^#(\d+)=([A-Z][A-Z0-9_]*)\((.*)\);$/);
    if (!match) {
      if (line.startsWith("#")) issues.push({ code: "parse-error", message: "Unsupported or malformed STEP entity record.", severity: "error" });
      continue;
    }
    const id = Number(match[1]);
    if (ids.has(id)) issues.push({ code: "duplicate-entity-id", message: `Entity #${id} is declared more than once.`, severity: "error", entityId: id });
    ids.add(id);
    entities.push({ id, type: match[2], fields: match[3], line });
  }
  if (step.includes("#") && entities.length === 0) issues.push({ code: "parse-error", message: "No STEP entities could be parsed.", severity: "error" });
  return { entities, issues, lines };
}

function references(fields: string): number[] {
  const withoutStrings = fields.replace(/'(?:''|[^'])*'/g, "''");
  return [...withoutStrings.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function firstString(fields: string): string | undefined {
  return fields.match(/^'((?:''|[^'])*)'/)?.[1]?.replace(/''/g, "'");
}

/** Parser-safe structural checks for the intentionally limited IFC4 export. */
export function validateIfcStep(step: string): IfcValidationReport {
  const issues: IfcValidationIssue[] = [];
  const requiredHeaders = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(", "FILE_NAME(", "FILE_SCHEMA(('IFC4'))", "ENDSEC;", "DATA;", "END-ISO-10303-21;"];
  for (const header of requiredHeaders) if (!step.includes(header)) issues.push({ code: "missing-header", message: `Required STEP marker ${header} is missing.`, severity: "error" });
  const parsed = parseIfcEntities(step);
  issues.push(...parsed.issues);
  const byType = (type: string) => parsed.entities.filter((entity) => entity.type === type);
  const requireType = (type: string) => { if (!byType(type).length) issues.push({ code: "missing-entity", message: `Mandatory entity ${type} is missing.`, severity: "error" }); };
  ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCUNITASSIGNMENT", "IFCSIUNIT", "IFCLOCALPLACEMENT", "IFCOWNERHISTORY"].forEach(requireType);

  const knownIds = new Set(parsed.entities.map((entity) => entity.id));
  const byId = new Map(parsed.entities.map(entity => [entity.id, entity]));
  const dataIndex = parsed.lines.indexOf("DATA;"), endIndex = parsed.lines.indexOf("ENDSEC;", dataIndex + 1);
  if (dataIndex < 0 || endIndex < dataIndex || [...parsed.lines.slice(0, dataIndex), ...parsed.lines.slice(endIndex + 1)].some(line => /^#[0-9]+=/.test(line))) {
    issues.push({ code: "data-section", message: "STEP entities must stay inside the DATA section.", severity: "error" });
  }
  for (const entity of parsed.entities) {
    for (const ref of references(entity.fields)) if (!knownIds.has(ref)) issues.push({ code: "dangling-reference", message: `Entity #${entity.id} references missing entity #${ref}.`, severity: "error", entityId: entity.id });
  }
  const guids = new Set<string>();
  for (const entity of parsed.entities) {
    if (!productTypes.has(entity.type) && !/^IFC(REL|PROPERTYSET|ELEMENTQUANTITY|PROJECT|SITE|BUILDING|BUILDINGSTOREY|GRID)$/.test(entity.type) && !entity.type.startsWith("IFCREL")) continue;
    const guid = firstString(entity.fields);
    if (!guid) continue;
    if (guids.has(guid)) issues.push({ code: "duplicate-guid", message: `GUID ${guid} is not unique.`, severity: "error", entityId: entity.id });
    guids.add(guid);
  }
  for (const entity of parsed.entities.filter((item) => productTypes.has(item.type))) {
    const placementId = Number(stepFields(entity.fields)[5]?.replace("#", ""));
    if (byId.get(placementId)?.type !== "IFCLOCALPLACEMENT") issues.push({ code: "missing-placement", message: `${entity.type} #${entity.id} has no local placement.`, severity: "error", entityId: entity.id });
  }
  for (const placement of byType("IFCLOCALPLACEMENT")) {
    const parent = stepFields(placement.fields)[0];
    if (parent !== "$" && byId.get(Number(parent.replace("#", "")))?.type !== "IFCLOCALPLACEMENT") issues.push({ code: "placement-parent", message: "Local placement parent must reference another local placement.", severity: "error", entityId: placement.id });
  }
  const contained = new Set<number>();
  for (const relation of byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
    const match = relation.fields.match(/\(([^)]*)\),#(\d+)$/);
    if (match) for (const ref of references(match[1])) contained.add(ref);
  }
  const aggregatedSpaces = new Set<number>();
  for (const relation of byType("IFCRELAGGREGATES")) {
    const fields = stepFields(relation.fields), parent = byId.get(Number(fields[4]?.replace("#", "")));
    if (parent?.type === "IFCBUILDINGSTOREY") for (const ref of references(fields[5] ?? "")) aggregatedSpaces.add(ref);
  }
  for (const entity of parsed.entities.filter((item) => productTypes.has(item.type))) {
    if (entity.type === "IFCSPACE") {
      if (!aggregatedSpaces.has(entity.id) || contained.has(entity.id)) issues.push({ code: "space-decomposition", message: `IFCSPACE #${entity.id} must be aggregated beneath a building storey, not contained as an element.`, severity: "error", entityId: entity.id });
    } else if (entity.type === "IFCOPENINGELEMENT") {
      if (contained.has(entity.id)) issues.push({ code: "opening-containment", message: `Opening #${entity.id} is placed by its host void relationship, not storey containment.`, severity: "error", entityId: entity.id });
    } else if (!contained.has(entity.id)) issues.push({ code: "missing-containment", message: `${entity.type} #${entity.id} is not contained by a building storey.`, severity: "error", entityId: entity.id });
  }

  const propertyTargets = new Set<number>();
  const quantityTargets = new Set<number>();
  for (const relation of byType("IFCRELDEFINESBYPROPERTIES")) {
    const target = relation.fields.match(/,\(#(\d+)\),#(\d+)$/);
    if (!target) continue;
    const definition = byId.get(Number(target[2]));
    if (definition?.type === "IFCPROPERTYSET") propertyTargets.add(Number(target[1]));
    if (definition?.type === "IFCELEMENTQUANTITY") quantityTargets.add(Number(target[1]));
  }
  for (const entity of parsed.entities.filter((item) => productTypes.has(item.type))) {
    if (!propertyTargets.has(entity.id)) issues.push({ code: "missing-property-set", message: `${entity.type} #${entity.id} has no property set.`, severity: "error", entityId: entity.id });
    if (!quantityTargets.has(entity.id)) issues.push({ code: "missing-quantity-set", message: `${entity.type} #${entity.id} has no quantity set.`, severity: "error", entityId: entity.id });
  }
  const openingIds = new Set(byType("IFCOPENINGELEMENT").map((entity) => entity.id));
  const voidIds = new Set(byType("IFCRELVOIDSELEMENT").map(entity => Number(stepFields(entity.fields)[5]?.replace("#", ""))));
  const fillIds = new Set(byType("IFCRELFILLSELEMENT").map(entity => Number(stepFields(entity.fields)[4]?.replace("#", ""))));
  const unfilledGuids = new Set(inspectGroundworkIfcSources(step).entities.filter(item => item.type === "OPENING_INTENT" && item.properties?.cadHostedOpening).map(item => ifcSourceGuid(item.id)));
  for (const opening of openingIds) {
    if (!voidIds.has(opening)) issues.push({ code: "opening-host-missing", message: `Opening #${opening} has no IFCRELVOIDSELEMENT relationship.`, severity: "error", entityId: opening });
    if (!fillIds.has(opening) && !unfilledGuids.has(firstString(byId.get(opening)!.fields) ?? "")) issues.push({ code: "opening-fill-missing", message: `Opening #${opening} has neither an authored unfilled-void declaration nor an IFCRELFILLSELEMENT relationship.`, severity: "error", entityId: opening });
  }
  const sourceTypes = parsed.entities.map((entity) => entity.line).join("\n");
  const hasMepSource = /IFCLABEL\('MEP_(DUCT|PIPE|CABLE_TRAY|EQUIPMENT|FIXTURE)'\)/.test(sourceTypes);
  for (const type of byType("IFCFLOWSEGMENT").concat(byType("IFCUNITARYEQUIPMENT"), byType("IFCFLOWTERMINAL"))) if (!hasMepSource) issues.push({ code: "mep-mapping-unresolved", message: `${type.type} mapping is not represented by a source property.`, severity: "warning", entityId: type.id });
  const hasFacilitySource = sourceTypes.includes("IFCLABEL('INFRA_FACILITY')");
  for (const entity of parsed.entities.filter((item) => item.type === "IFCBUILDINGELEMENTPROXY")) if (!hasFacilitySource) issues.push({ code: "facility-mapping-unresolved", message: `Facility proxy #${entity.id} has no INFRA_FACILITY source mapping.`, severity: "warning", entityId: entity.id });

  const normalized = normalizeIfcStep(step);
  return { valid: issues.every((issue) => issue.severity !== "error"), parsedEntities: parsed.entities.length, guidCount: guids.size, normalized: normalized === normalizeIfcStep(normalized), issues };
}

/** Canonicalizes line endings/whitespace and re-renders parsed entity records for round-trip checks. */
export function normalizeIfcStep(step: string): string {
  const parsed = parseIfcEntities(step);
  const lines = parsed.lines;
  const data = lines.indexOf("DATA;"), end = lines.indexOf("ENDSEC;", data + 1);
  if (data < 0 || end < 0) return lines.join("\n") + "\n";
  return [...lines.slice(0, data + 1), ...parsed.entities.map(entity => entity.line), ...lines.slice(end)].join("\n") + "\n";
}

export function validateIfcRoundTrip(design: Design, step = buildIfcStep(design)): IfcValidationReport {
  const report = validateIfcStep(step);
  const recovered = inspectGroundworkIfcSources(step);
  const expected = (JSON.parse(buildBimExchange(design)) as { entities: ExchangeEntity[] }).entities.filter(e => e.type !== "GRID_AXIS");
  const bySource = new Map(recovered.entities.map(e => [e.id, e]));
  const missingIds = expected.filter(e => !bySource.has(e.id)).map(e => e.id);
  const changedIds = expected.filter(e => bySource.has(e.id) && JSON.stringify(e) !== JSON.stringify(bySource.get(e.id))).map(e => e.id);
  const issues = [...report.issues, ...recovered.issues,
    ...missingIds.map(id => ({ code: "source-roundtrip-missing", message: `Source ${id} was not recovered.`, severity: "error" as const })),
    ...changedIds.map(id => ({ code: "source-roundtrip-changed", message: `Source ${id} changed during metadata exchange.`, severity: "error" as const }))];
  return { ...report, valid: !issues.some(i => i.severity === "error"), issues,
    normalized: normalizeIfcStep(step) === normalizeIfcStep(normalizeIfcStep(step)),
    sourceRoundTrip: { checkedEntities: expected.length, missingIds, changedIds, scope: "Groundwork SourceData metadata only; not imported IFC geometry or third-party interoperability." } };
}

/** Read only Groundwork's own source metadata. This never applies imported geometry to a design. */
export function inspectGroundworkIfcSources(step: string): { entities: ExchangeEntity[]; issues: IfcValidationIssue[] } {
  const parsed = parseIfcEntities(step), byId = new Map(parsed.entities.map(e => [e.id, e]));
  const entities: ExchangeEntity[] = [], issues: IfcValidationIssue[] = [];
  const seen = new Set<string>();
  for (const pset of parsed.entities.filter(e => e.type === "IFCPROPERTYSET")) {
    if (firstString(stepFields(pset.fields)[2] ?? "") !== "Groundwork Source") continue;
    for (const ref of references(stepFields(pset.fields)[4] ?? "")) {
      const property = byId.get(ref);
      if (property?.type !== "IFCPROPERTYSINGLEVALUE") continue;
      const fields = stepFields(property.fields);
      if (firstString(fields[0]) !== "SourceData") continue;
      const match = fields[2]?.match(/^IFCTEXT\('((?:''|[^'])*)'\)$/);
      try {
        if (!match) throw new Error("SourceData is not IFC text.");
        const text = match[1].replace(/''/g, "'").replace(/\\\\/g, "\\");
        const item = JSON.parse(text) as ExchangeEntity;
        if (!item || typeof item.id !== "string" || typeof item.type !== "string") throw new Error("Invalid source identity.");
        if (seen.has(item.id)) throw new Error("Duplicate source identity.");
        seen.add(item.id); entities.push(item);
      } catch (e) {
        issues.push({ code: "source-data", message: e instanceof Error ? e.message : "Invalid source metadata.", severity: "error", entityId: property.id });
      }
    }
  }
  return { entities, issues };
}

export type IfcMvdProfile = "coordination" | "reference-view" | "design-transfer";

export interface IfcProfileValidation {
  profile: IfcMvdProfile;
  valid: boolean;
  issues: IfcValidationIssue[];
  requirements: { id: string; passed: boolean; message: string }[];
}

/**
 * Local MVD/IDS-style gate for Groundwork exports.
 * This is intentionally a deterministic pre-flight check, not a replacement
 * for buildingSMART schema/IDS validators used in interoperability certification.
 */
export function validateIfcProfile(step: string, profile: IfcMvdProfile = "coordination"): IfcProfileValidation {
  const base = validateIfcStep(step);
  const requirements: IfcProfileValidation["requirements"] = [];
  const require = (id: string, passed: boolean, message: string) => requirements.push({ id, passed, message });
  const count = (entity: string) => (step.match(new RegExp(`=${entity}\\(`, "g")) ?? []).length;

  require("spatial-structure", count("IFCPROJECT") > 0 && count("IFCSITE") > 0 && count("IFCBUILDING") > 0 && count("IFCBUILDINGSTOREY") > 0, "Project, site, building and storey spatial structure must exist.");
  require("containment", count("IFCRELCONTAINEDINSPATIALSTRUCTURE") > 0, "Products must be related to spatial containers.");
  require("properties", count("IFCPROPERTYSET") > 0 && count("IFCRELDEFINESBYPROPERTIES") > 0, "Exported products must carry property-set relationships.");
  require("quantities", count("IFCELEMENTQUANTITY") > 0, "Exported products must include base quantities.");
  require("geometry", count("IFCSHAPEREPRESENTATION") > 0, "Exported products must carry shape representations.");

  if (profile === "reference-view" || profile === "design-transfer") {
    require("materials", count("IFCMATERIAL") > 0 || /Material/i.test(step), "Reference exchange should retain material intent.");
    require("openings", !base.issues.some(issue => issue.severity === "error" && issue.code.startsWith("opening-")), "Each hosted opening must retain its void relationship and either its filling or an authored unfilled-void declaration.");
    require("georeferencing", count("IFCMAPCONVERSION") > 0 || count("IFCSITE") > 0, "Site/georeferencing context must be represented.");
  }
  if (profile === "design-transfer") {
    require("classification", count("IFCCLASSIFICATION") > 0 || /classification/i.test(step), "Design transfer should retain classification metadata.");
    require("type-data", count("IFCRELDEFINESBYTYPE") > 0 || /Family|Type/i.test(step), "Design transfer should retain reusable type/family intent.");
  }

  const issues = [
    ...base.issues,
    ...requirements.filter((item) => !item.passed).map((item) => ({
      code: `profile-${item.id}`,
      message: item.message,
      severity: (profile === "coordination" ? "warning" : "error") as "error" | "warning",
    })),
  ];
  return { profile, valid: !issues.some((issue) => issue.severity === "error"), issues, requirements };
}

/** Checks source data before it is lowered into the intentionally limited IFC representation. */
export function validateBimExchange(design: Design): BimValidationIssue[] {
  const exchange = JSON.parse(buildBimExchange(design)) as { entities: ExchangeEntity[] };
  const issues: BimValidationIssue[] = [];
  const ids = new Set<string>();
  for (const item of exchange.entities) {
    if (ids.has(item.id)) issues.push({ id: item.id, message: "Duplicate source identifier; IFC identity is ambiguous." });
    ids.add(item.id);
    const geometry = item.geometry;
    if (!geometry) continue;
    for (const [key, value] of Object.entries(geometry)) {
      if (typeof value === "number" && !Number.isFinite(value)) issues.push({ id: item.id, message: `Geometry field ${key} is not finite.` });
    }
    if (geometry.kind === "box" && ["widthM", "depthM", "heightM"].some((key) => Number(geometry[key]) <= 0)) {
      issues.push({ id: item.id, message: "Box dimensions must be positive." });
    }
    if (geometry.kind === "polyline") {
      const points = geometry.points as unknown;
      if (!Array.isArray(points) || points.length < 2) issues.push({ id: item.id, message: "MEP route requires at least two points." });
    }
  }
  return issues;
}

/**
 * IFC4 STEP coordination export. Geometry is deliberately limited to boxes
 * and swept rectangular/circular profiles because the editor stores planning intent,
 * rather than construction-ready solids.
 */
export function buildIfcStep(design: Design): string {
  const exchange = JSON.parse(buildBimExchange(design)) as { entities: ExchangeEntity[] };
  const validation = validateBimExchange(design);
  const rows: string[] = [];
  const add = (type: string, fields: string, _key = `${type}:${rows.length}`) => {
    const id = rows.length + 1;
    rows.push(`#${id}=${type}(${fields});`);
    return id;
  };
  const owner = add("IFCPERSON", "$,$,'Groundwork',$,$,$,$,$");
  const org = add("IFCORGANIZATION", "$,'Groundwork',$,$,$");
  const personOrg = add("IFCPERSONANDORGANIZATION", `#${owner},#${org},$`);
  const application = add("IFCAPPLICATION", `#${org},'1.0','Groundwork Design Studio','GROUNDWORK'`);
  const history = add("IFCOWNERHISTORY", `#${personOrg},#${application},$,.ADDED.,0,$,$,0`);
  const origin = add("IFCCARTESIANPOINT", "(0.,0.,0.)");
  const up = add("IFCDIRECTION", "(0.,0.,1.)");
  const east = add("IFCDIRECTION", "(1.,0.,0.)");
  const worldAxis = add("IFCAXIS2PLACEMENT3D", `#${origin},#${up},#${east}`);
  const context = add("IFCGEOMETRICREPRESENTATIONCONTEXT", `$, 'Model', 3, 1.E-05, #${worldAxis},$`);
  const metre = add("IFCSIUNIT", "*,.LENGTHUNIT.,$,.METRE.");
  const area = add("IFCSIUNIT", "*,.AREAUNIT.,$,.SQUARE_METRE.");
  const volume = add("IFCSIUNIT", "*,.VOLUMEUNIT.,$,.CUBIC_METRE.");
  const units = add("IFCUNITASSIGNMENT", `(#${metre},#${area},#${volume})`);
  const guid = (key: string) => ifcGuid(`groundwork-ifc4:${key}`);
  const project = add("IFCPROJECT", `'${guid("project")}',#${history},'Groundwork exchange',$,$,$,$,(#${context}),#${units}`, "project");
  const provenance = engineeringExchangeProvenance(design.engineeringBasis);
  const provenanceProperties = [
    add("IFCPROPERTYSINGLEVALUE", `'Declaration',$,IFCTEXT(${ifcText(engineeringProvenanceAscii(provenance.designBasis))}),$`),
    add("IFCPROPERTYSINGLEVALUE", `'CountryCode',$,IFCLABEL(${ifcText(provenance.designBasis?.countryCode ?? "undeclared")}),$`),
    add("IFCPROPERTYSINGLEVALUE", `'NationalCodeCompliance',$,IFCLABEL('not-assessed'),$`),
    add("IFCPROPERTYSINGLEVALUE", `'Verification',$,IFCLABEL('unverified'),$`),
  ];
  const provenanceSet = add("IFCPROPERTYSET", `'${guid("engineering-basis")}',#${history},'SecureNexus Engineering Basis',$,(${provenanceProperties.map(id => `#${id}`).join(",")})`);
  add("IFCRELDEFINESBYPROPERTIES", `'${guid("engineering-basis-rel")}',#${history},'Captured engineering declaration',$,(#${project}),#${provenanceSet}`);
  const placement = (x = 0, y = 0, z = 0, rotation = 0, parent?: number, precision = 3) => {
    const coordinate = (value: number) => precision > 3 ? value.toFixed(precision) : number(value).toFixed(3);
    const point = add("IFCCARTESIANPOINT", `(${coordinate(x)},${coordinate(y)},${coordinate(z)})`);
    const angle = rotation ? Math.PI * rotation / 180 : 0;
    const ref = rotation ? add("IFCDIRECTION", `(${precision > 3 ? Math.cos(angle).toFixed(9) : number(Math.cos(angle)).toFixed(6)},${precision > 3 ? Math.sin(angle).toFixed(9) : number(Math.sin(angle)).toFixed(6)},0.)`) : east;
    const axis = add("IFCAXIS2PLACEMENT3D", `#${point},#${up},#${ref}`);
    return add("IFCLOCALPLACEMENT", `${parent ? `#${parent}` : "$"},#${axis}`);
  };
  const sitePlacement = placement();
  const site = add("IFCSITE", `'${guid("site")}',#${history},'Design site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$`, "site");
  const buildingPlacement = placement(0, 0, 0, 0, sitePlacement);
  const building = add("IFCBUILDING", `'${guid("building")}',#${history},'Groundwork model',$,$,#${buildingPlacement},$,$,.ELEMENT.,$,$,$`, "building");
  const aggregate = (name: string, parent: number, children: number[], key: string) => children.length && add("IFCRELAGGREGATES", `'${guid(`aggregate:${key}`)}',#${history},${ifcText(name)},$,#${parent},(${children.map((id) => `#${id}`).join(",")})`, `aggregate:${key}`);
  aggregate("Project site", project, [site], "project-site");
  aggregate("Building", site, [building], "site-building");

  const storeyIds = new Map<string, number>();
  const storeyPlacements = new Map<number, number>();
  const storeyElevations = new Map<number, number>();
  const storeyProducts = new Map<number, number[]>();
  const ensureStorey = (key: string, name: string, elevation: number) => {
    const existing = storeyIds.get(key);
    if (existing) return existing;
    const storeyPlacement = placement(0, 0, elevation, 0, buildingPlacement);
    const id = add("IFCBUILDINGSTOREY", `'${guid(`storey:${key}`)}',#${history},${ifcText(name)},$,$,#${storeyPlacement},$,$,.ELEMENT.,${number(elevation).toFixed(3)}`, `storey:${key}`);
    storeyIds.set(key, id);
    storeyPlacements.set(id, storeyPlacement);
    storeyElevations.set(id, elevation);
    storeyProducts.set(id, []);
    aggregate(name, building, [id], `building-storey:${key}`);
    return id;
  };
  ensureStorey("default", "Coordination level", 0);
  for (const level of design.community?.levels?.length ? design.community.levels : design.cad?.levels ?? []) ensureStorey(level.id, level.name, level.elevation);

  const measure = (value: unknown) => Math.max(0, Number(value) || 0);
  const dimensions = (item: ExchangeEntity) => {
    const geometry = item.geometry ?? {};
    const width = measure(geometry.widthM ?? geometry.wM);
    const depth = measure(geometry.depthM ?? geometry.dM ?? geometry.heightM);
    const height = measure(geometry.heightM ?? geometry.hM ?? geometry.widthM);
    return { width, depth, height };
  };
  const boxShape = (item: ExchangeEntity, dims: { width: number; depth: number; height: number }) => {
    if (!dims.width || !dims.depth || !dims.height) return undefined;
    const profilePoint = add("IFCCARTESIANPOINT", "(0.,0.)");
    const profileAxis = add("IFCAXIS2PLACEMENT2D", `#${profilePoint},$`);
    const precise = item.type.startsWith("DRAFT_") || item.properties?.cadHostedOpening;
    const dimension = (value: number) => precise ? value.toFixed(6) : number(value).toFixed(3);
    let profile: number;
    if (item.geometry?.kind === "polygon-extrusion" && Array.isArray(item.geometry.points) && item.geometry.points.length >= 3) {
      const points = item.geometry.points as { x: number; z: number }[];
      const boundary = points.length > 1 && points[0].x === points[points.length - 1].x && points[0].z === points[points.length - 1].z ? points.slice(0, -1) : points;
      // IFC plan X/Y corresponds to model X/Z; product placement applies -Y rotation.
      const pointIds = boundary.map(point => add("IFCCARTESIANPOINT", `(${dimension(point.x)},${dimension(point.z)})`));
      const curve = add("IFCPOLYLINE", `(${[...pointIds, pointIds[0]].map(id => `#${id}`).join(",")})`);
      profile = add("IFCARBITRARYCLOSEDPROFILEDEF", `.AREA.,$,#${curve}`);
    } else profile = item.geometry?.kind === "cylinder"
      ? add("IFCCIRCLEPROFILEDEF", `.AREA.,$,#${profileAxis},${dimension(Number(item.geometry.radiusM) || dims.width / 2)}`)
      : add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${profileAxis},${dimension(dims.width)},${dimension(dims.depth)}`);
    const solidPlacement = add("IFCAXIS2PLACEMENT3D", `#${origin},#${up},#${east}`);
    const solid = add("IFCEXTRUDEDAREASOLID", `#${profile},#${solidPlacement},#${up},${dimension(dims.height)}`);
    const representations = [add("IFCSHAPEREPRESENTATION", `#${context},'Body','SweptSolid',(#${solid})`)];
    const points = item.geometry?.points;
    if (item.geometry?.kind === "polyline" && Array.isArray(points) && points.length > 1) {
      const pointIds = points.map((point) => {
        const value = point as { x?: number; y?: number; z?: number };
        return add("IFCCARTESIANPOINT", `(${number(Number(value.x) || 0).toFixed(3)},${number(Number(value.y) || 0).toFixed(3)},${number(Number(value.z) || 0).toFixed(3)})`);
      });
      const polyline = add("IFCPOLYLINE", `(${pointIds.map((id) => `#${id}`).join(",")})`);
      representations.push(add("IFCSHAPEREPRESENTATION", `#${context},'Axis','Curve3D',(#${polyline})`));
    }
    return add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(${representations.map((id) => `#${id}`).join(",")})`);
  };
  const pset = (product: number, item: ExchangeEntity, dims: { width: number; depth: number; height: number }) => {
    const values = [
      `IFCPROPERTYSINGLEVALUE('SourceId',$,IFCLABEL(${ifcText(item.id)}),$)`,
      `IFCPROPERTYSINGLEVALUE('SourceType',$,IFCLABEL(${ifcText(item.type)}),$)`,
      `IFCPROPERTYSINGLEVALUE('SourceData',$,IFCTEXT(${ifcText(JSON.stringify(item))}),$)`,
      `IFCPROPERTYSINGLEVALUE('Approximation',$,IFCBOOLEAN(.T.),$)`,
      `IFCPROPERTYSINGLEVALUE('InteroperabilityNote',$,IFCTEXT(${ifcText(String(item.properties?.approximation ?? "Source geometry is planning intent."))}),$)`,
    ];
    const propertyIds = values.map((value) => add("IFCPROPERTYSINGLEVALUE", value.slice(value.indexOf("(") + 1, -1)));
    const definition = add("IFCPROPERTYSET", `'${guid(`pset:${item.id}`)}',#${history},'Groundwork Source',$,(${propertyIds.map((id) => `#${id}`).join(",")})`, `pset:${item.id}`);
    add("IFCRELDEFINESBYPROPERTIES", `'${guid(`pset-rel:${item.id}`)}',#${history},'Source properties',$,(#${product}),#${definition}`, `pset-rel:${item.id}`);
    const quantityNumber = (value: number) => item.type.startsWith("DRAFT_") ? value.toFixed(6) : number(value).toFixed(3);
    const grossVolume = typeof item.properties?.grossVolumeM3 === "number" ? item.properties.grossVolumeM3 : item.geometry?.kind === "cylinder" ? Math.PI * dims.width ** 2 / 4 * dims.height : dims.width * dims.depth * dims.height;
    const quantities = [
      add("IFCQUANTITYLENGTH", `'Width',$,$,${quantityNumber(dims.width)},$`),
      add("IFCQUANTITYLENGTH", `'Depth',$,$,${quantityNumber(dims.depth)},$`),
      add("IFCQUANTITYLENGTH", `'Height',$,$,${quantityNumber(dims.height)},$`),
      add("IFCQUANTITYVOLUME", `'GrossVolume',$,$,${quantityNumber(grossVolume)},$`),
    ];
    if (typeof item.properties?.netVolumeM3 === "number") quantities.push(add("IFCQUANTITYVOLUME", `'NetVolume',$,$,${quantityNumber(item.properties.netVolumeM3)},$`));
    const quantitySet = add("IFCELEMENTQUANTITY", `'${guid(`quantity:${item.id}`)}',#${history},'Base quantities',$,$,(${quantities.map((id) => `#${id}`).join(",")})`, `quantity:${item.id}`);
    add("IFCRELDEFINESBYPROPERTIES", `'${guid(`quantity-rel:${item.id}`)}',#${history},'Base quantities',$,(#${product}),#${quantitySet}`, `quantity-rel:${item.id}`);
  };
  const typedClass = (item: ExchangeEntity) => {
    if (item.type === "OPENING_INTENT" && item.properties?.cadHostedOpening) return "IFCOPENINGELEMENT";
    if (item.type === "WALL" || item.type === "FACADE_PANEL" || item.type === "DRAFT_WALL") return "IFCWALL";
    if (item.type === "DRAFT_SLAB") return "IFCSLAB";
    if (item.type === "DRAFT_COLUMN") return "IFCCOLUMN";
    if (item.type === "DRAFT_BEAM") return "IFCBEAM";
    if (item.type === "DRAFT_ROOF") return "IFCROOF";
    if (item.type === "SLAB") return "IFCSLAB";
    if (item.type === "SPACE") return "IFCSPACE";
    if (item.type === "ROOF") return "IFCROOF";
    if (item.type === "COLUMN") return "IFCCOLUMN";
    if (item.type === "DOOR") return "IFCDOOR";
    if (item.type === "WINDOW") return "IFCWINDOW";
    if (item.type.startsWith("MEP_DUCT") || item.type.startsWith("MEP_PIPE") || item.type.startsWith("MEP_CABLE_TRAY")) return "IFCFLOWSEGMENT";
    if (item.type === "MEP_EQUIPMENT") return "IFCUNITARYEQUIPMENT";
    if (item.type === "MEP_FIXTURE") return "IFCFLOWTERMINAL";
    if (item.type === "INFRA_FACILITY" || item.type.startsWith("DRAFT_")) return "IFCBUILDINGELEMENTPROXY";
    return "IFCFURNISHINGELEMENT";
  };
  const productBySource = new Map<string, number>();
  const hostBySource = new Map<string, number>();
  const materialIds = new Map<string, number>();
  const material = (name: string) => {
    const existing = materialIds.get(name);
    if (existing) return existing;
    const id = add("IFCMATERIAL", `${ifcText(name)},$,$`, `material:${name}`);
    materialIds.set(name, id);
    return id;
  };
  for (const item of exchange.entities.filter((candidate) => candidate.type === "GRID_AXIS")) {
    const geometry = item.geometry ?? {};
    const position = Number(geometry.positionM) || 0;
    const extent = Math.max(Number(geometry.extentM) || 0, 0.001);
    const first = add("IFCCARTESIANPOINT", geometry.axis === "z" ? `(${position.toFixed(3)},${(-extent).toFixed(3)},0.)` : `(${(-extent).toFixed(3)},${position.toFixed(3)},0.)`);
    const second = add("IFCCARTESIANPOINT", geometry.axis === "z" ? `(${position.toFixed(3)},${extent.toFixed(3)},0.)` : `(${extent.toFixed(3)},${position.toFixed(3)},0.)`);
    const curve = add("IFCPOLYLINE", `(#${first},#${second})`);
    const axis = add("IFCGRIDAXIS", `${ifcText(item.name ?? item.id)},#${curve},.T.`, `grid-axis:${item.id}`);
    // IFC grids need both U and V axes; retain a perpendicular reference axis.
    const perpendicularStart = add("IFCCARTESIANPOINT", geometry.axis === "z" ? `(${(-extent).toFixed(3)},0.,0.)` : `(0.,${(-extent).toFixed(3)},0.)`);
    const perpendicularEnd = add("IFCCARTESIANPOINT", geometry.axis === "z" ? `(${extent.toFixed(3)},0.,0.)` : `(0.,${extent.toFixed(3)},0.)`);
    const perpendicular = add("IFCPOLYLINE", `(#${perpendicularStart},#${perpendicularEnd})`);
    const reference = add("IFCGRIDAXIS", `'Reference',#${perpendicular},.T.`);
    add("IFCGRID", `'${guid(`grid:${item.id}`)}',#${history},${ifcText(item.name ?? item.id)},$,$,#${buildingPlacement},$,$,(#${axis}),(#${reference}),$,.RECTANGULAR.`, `grid:${item.id}`);
  }
  const products = exchange.entities.filter((item) => item.type !== "GRID_AXIS").map((item) => {
    const geometry = item.geometry ?? {};
    const floor = Number(geometry.floor ?? item.properties?.floor ?? 0);
    const key = item.levelId || (floor ? `tower-floor-${floor}` : "default");
    const storey = storeyIds.get(key) ?? ensureStorey(key, key === "default" ? "Coordination level" : `Level ${floor}`, floor * measure(design.community?.towers[0]?.floorHeight));
    const x = Number(geometry.xM ?? 0);
    const y = Number(geometry.zM ?? 0);
    const z = Number(geometry.yM ?? 0);
    const rotation = Number(geometry.rotationDeg ?? 0) * (item.type.startsWith("DRAFT_") || item.properties?.cadHostedOpening ? -1 : 1);
    const local = placement(x, y, z - (storeyElevations.get(storey) ?? 0), rotation, storeyPlacements.get(storey), item.type.startsWith("DRAFT_") || item.properties?.cadHostedOpening ? 6 : 3);
    const dims = dimensions(item);
    const shape = boxShape(item, dims);
    const description = `${item.type} intent; geometry is an approximate exchange envelope, not fabrication geometry.`;
    const type = typedClass(item);
    const base = `'${guid(`product:${item.id}`)}',#${history},${ifcText(item.name || item.type)},${ifcText(description)},$,#${local},${shape ? `#${shape}` : "$"},$`;
    const suffix = type === "IFCSPACE" ? ",.ELEMENT.,.NOTDEFINED.,$"
      : ["IFCWALL", "IFCSLAB", "IFCROOF", "IFCCOLUMN", "IFCBEAM", "IFCUNITARYEQUIPMENT"].includes(type) ? ",.NOTDEFINED."
      : type === "IFCDOOR" || type === "IFCWINDOW" ? ",$,$,.NOTDEFINED.,.NOTDEFINED.,$"
      : type === "IFCOPENINGELEMENT" ? ",.OPENING."
      : type === "IFCBUILDINGELEMENTPROXY" ? ",.NOTDEFINED."
      : "";
    const id = add(type, `${base}${suffix}`);
    productBySource.set(item.id, id);
    if (item.type === "WALL" || item.type === "FACADE_PANEL" || item.type === "DRAFT_WALL") hostBySource.set(item.id, id);
    if (type === "IFCSPACE") aggregate("Storey space", storey, [id], `storey-space:${item.id}`);
    else if (type !== "IFCOPENINGELEMENT") storeyProducts.get(storey)?.push(id);
    pset(id, item, dims);
    const materialName = String(item.properties?.material ?? item.properties?.color ?? "Unspecified");
    if (type !== "IFCSPACE" && type !== "IFCOPENINGELEMENT") add("IFCRELASSOCIATESMATERIAL", `'${guid(`material-rel:${item.id}`)}',#${history},$,$,(#${id}),#${material(materialName)}`, `material-rel:${item.id}`);
    return id;
  });
  void products;
  for (const item of exchange.entities) {
    const unfilled = item.type === "OPENING_INTENT" && item.properties?.cadHostedOpening;
    if (item.type !== "DOOR" && item.type !== "WINDOW" && !unfilled) continue;
    const fill = productBySource.get(item.id);
    const wallKey = item.properties?.wall ? `room-wall-${String(item.properties.wall)}` : undefined;
    const host = hostBySource.get(String(item.properties?.hostId ?? wallKey ?? ""));
    if (!fill || !host) continue;
    if (unfilled) {
      add("IFCRELVOIDSELEMENT", `'${guid(`void:${item.id}`)}',#${history},'Unfilled opening host',$,#${host},#${fill}`, `void:${item.id}`);
      continue;
    }
    const openingShape = boxShape(item, dimensions(item));
    const geometry = item.geometry ?? {};
    const openingPlacement = placement(Number(geometry.xM) || 0, Number(geometry.zM) || 0, Number(geometry.yM) || 0, (Number(geometry.rotationDeg) || 0) * (item.properties?.cadHostedOpening ? -1 : 1), undefined, item.properties?.cadHostedOpening ? 6 : 3);
    const opening = add("IFCOPENINGELEMENT", `'${guid(`opening:${item.id}`)}',#${history},${ifcText(`${item.name ?? item.type} void`)},'Host void is approximate',$,#${openingPlacement},${openingShape ? `#${openingShape}` : "$"},$,.OPENING.`, `opening:${item.id}`);
    pset(opening, { ...item, id: `opening:${item.id}`, type: "OPENING" }, dimensions(item));
    add("IFCRELVOIDSELEMENT", `'${guid(`void:${item.id}`)}',#${history},'Opening host',$,#${host},#${opening}`, `void:${item.id}`);
    add("IFCRELFILLSELEMENT", `'${guid(`fill:${item.id}`)}',#${history},'Opening fill',$,#${opening},#${fill}`, `fill:${item.id}`);
  }

  for (const [storey, children] of storeyProducts) if (children.length) add("IFCRELCONTAINEDINSPATIALSTRUCTURE", `'${guid(`contains:${storey}`)}',#${history},'Storey contents',$,(${children.map((id) => `#${id}`).join(",")}),#${storey}`, `contains:${storey}`);

  // Keep invalid source geometry visible to downstream coordination tools without emitting malformed solids.
  if (validation.length) {
    const values = validation.map((issue) => add("IFCPROPERTYSINGLEVALUE", `'Validation:${issue.id}',$,IFCTEXT(${ifcText(issue.message)}),$`, `validation:${issue.id}:${issue.message}`));
    const definition = add("IFCPROPERTYSET", `'${guid("validation")}',#${history},'Groundwork Validation',$,(${values.map((id) => `#${id}`).join(",")})`, "validation");
    add("IFCRELDEFINESBYPROPERTIES", `'${guid("validation-rel")}',#${history},'Validation results',$,(#${project}),#${definition}`, "validation-rel");
  }

  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Groundwork coordination export'),'2;1');",
    "FILE_NAME('groundwork.ifc','1970-01-01T00:00:00',('Groundwork'),('Groundwork'),'Groundwork Design Studio','Groundwork','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...rows,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

export function buildBimScheduleCsv(design: Design): string {
  const exchange = JSON.parse(buildBimExchange(design)) as { entities: ExchangeEntity[] };
  const rows = ["id,type,name,levelId,geometry,properties"];
  for (const item of exchange.entities) {
    rows.push([item.id, item.type, item.name, item.levelId, JSON.stringify(item.geometry ?? {}), JSON.stringify(item.properties ?? {})].map(quoteCsvCell).join(","));
  }
  return rows.join("\n") + "\n";
}

