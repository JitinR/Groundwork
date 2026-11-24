import type { AssistantAction, BuildingBranch, CommunityDesign, DraftElement, DraftElementKind, FurnitureItem, InfraDesign, InfraFacility, UnitSystem } from "../types";
import { AMENITIES, amenityAllowed, amenityFootprint, amenityKind, defaultTower, makeAmenity, updateAmenity } from "./community";
import { catalogEntry, furnitureMount } from "./catalog";
import { uid } from "./modelcore";

export interface AssistantResult {
  design: CommunityDesign;
  reply: string;
  step?: "land" | "drafting" | "amenities" | "towers";
}

export interface AssistantActionPreview {
  action: AssistantAction;
  label: string;
  applicable: boolean;
  reason?: string;
}

const MAX_SITE_SIZE = 1_000_000;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validUnit = (value: unknown): value is UnitSystem => value === "m" || value === "yd" || value === "ft";
const validColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const validDraftKind = (value: unknown): value is DraftElementKind => ["line", "rectangle", "circle", "dimension", "wall", "slab", "column", "roof"].includes(value as string);

function validDimension(value: unknown, max = MAX_SITE_SIZE): value is number {
  return isFiniteNumber(value) && value > 0 && value <= max;
}

function validTowerPatch(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["label", "x", "z", "rotY", "floors", "unitsPerFloor", "unitWidth", "unitDepth", "floorHeight"].includes(key))) return false;
  if (patch.label !== undefined && (typeof patch.label !== "string" || !patch.label.trim())) return false;
  if (["x", "z", "rotY"].some((key) => patch[key] !== undefined && !isFiniteNumber(patch[key]))) return false;
  if (["floors", "unitsPerFloor"].some((key) => patch[key] !== undefined && (!isFiniteNumber(patch[key]) || !Number.isInteger(patch[key]) || (patch[key] as number) < 1 || (key === "floors" ? (patch[key] as number) > 300 : (patch[key] as number) > 1000)))) return false;
  return ["unitWidth", "unitDepth", "floorHeight"].every((key) => patch[key] === undefined || validDimension(patch[key], 1000));
}

function validAmenityPatch(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["x", "z", "rotY", "w", "d", "h"].includes(key))) return false;
  return Object.values(patch).every((item, index) => {
    const key = Object.keys(patch)[index];
    return isFiniteNumber(item) && (key === "x" || key === "z" || key === "rotY" || item > 0);
  });
}

function validCircleDimensions(dimensions: { w?: number; d?: number }): boolean {
  return dimensions.w === undefined || dimensions.d === undefined || dimensions.w === dimensions.d;
}

function actionLabel(action: AssistantAction): string {
  switch (action.type) {
    case "set_plot_dimensions": return `Set plot to ${action.width} x ${action.depth} ${action.unit}`;
    case "add_tower": return `Add tower “${action.label}” at (${action.x}, ${action.z})`;
    case "remove_tower": return `Remove tower ${action.towerId}`;
    case "update_tower": return `Update tower ${action.towerId}`;
    case "add_amenity": return `Add ${action.kind} at (${action.x}, ${action.z})`;
    case "remove_amenity": return `Remove amenity ${action.amenityId}`;
    case "update_amenity": return `Update amenity ${action.amenityId}`;
    case "add_drafting_element": return `Add ${action.kind} drafting element`;
    case "update_room_opening": return `Interior update for room ${action.roomId}`;
    case "add_room_opening": return `Add ${action.kind} opening to room ${action.roomId}`;
    case "add_room_furniture": return `Add ${action.name ?? action.catalogId} to room ${action.roomId}`;
    case "update_room_furniture": return `Update furniture ${action.furnitureId}`;
    case "add_mep_element": return `Add MEP ${action.kind}: ${action.name}`;
    case "update_infrastructure": return "Update infrastructure parameters";
    case "generate_infrastructure_model": return "Generate infrastructure model";
    case "request_analysis": return `Request ${action.scope} analysis`;
  }
}

function unsupportedAction(action: AssistantAction): string | undefined {
  if (action.type === "add_mep_element") return "MEP actions are preview-only until coordination application is wired.";
  if (action.type === "update_infrastructure" || action.type === "generate_infrastructure_model") return "Infrastructure actions apply only in the infrastructure editor.";
  if (action.type === "request_analysis") return "Analysis requests do not mutate the design.";
  return undefined;
}

export function isAssistantActionPreviewOnly(action: AssistantAction): boolean {
  return Boolean(unsupportedAction(action));
}

function invalidAction(action: AssistantAction, design: CommunityDesign, branch: BuildingBranch): string | undefined {
  const unsupported = unsupportedAction(action);
  if (unsupported) return unsupported;
  switch (action.type) {
    case "set_plot_dimensions":
      return validDimension(action.width) && validDimension(action.depth) && validUnit(action.unit) ? undefined : "Plot dimensions are invalid.";
    case "add_tower":
      return typeof action.label === "string" && action.label.trim() && isFiniteNumber(action.x) && isFiniteNumber(action.z) &&
        (action.floors === undefined || (Number.isInteger(action.floors) && action.floors >= 1 && action.floors <= 300)) &&
        (action.unitsPerFloor === undefined || (Number.isInteger(action.unitsPerFloor) && action.unitsPerFloor >= 1 && action.unitsPerFloor <= 1000)) ? undefined : "Tower values are invalid.";
    case "remove_tower": return design.towers.some((tower) => tower.id === action.towerId) ? undefined : "Tower was not found.";
    case "update_tower": return design.towers.some((tower) => tower.id === action.towerId) && validTowerPatch(action.patch) ? undefined : "Tower was not found or its patch is invalid.";
    case "add_amenity": return amenityAllowed(action.kind, branch, design.commercialStyle) && (amenityKind(action.kind)?.shape !== "circle" || validCircleDimensions(action)) && isFiniteNumber(action.x) && isFiniteNumber(action.z) && (action.w === undefined || validDimension(action.w, 10000)) && (action.d === undefined || validDimension(action.d, 10000)) && (action.h === undefined || validDimension(action.h, 10000)) ? undefined : "Amenity is unavailable for this branch or has invalid dimensions.";
    case "remove_amenity": return design.amenities.some((amenity) => amenity.id === action.amenityId) ? undefined : "Amenity was not found.";
    case "update_amenity": {
      const amenity = design.amenities.find((item) => item.id === action.amenityId);
      return amenity && validAmenityPatch(action.patch) && (amenityFootprint(amenity).diameter === undefined || validCircleDimensions(action.patch))
        ? undefined : "Amenity was not found or its patch is invalid. Circular amenities require one diameter.";
    }
    case "add_drafting_element": return validDraftKind(action.kind) && validDimension(action.w, 10000) && validDimension(action.d, 10000) && isFiniteNumber(action.x) && isFiniteNumber(action.z) && isFiniteNumber(action.rotationDeg) && validColor(action.color) && (action.h === undefined || validDimension(action.h, 10000)) && (action.label === undefined || typeof action.label === "string") ? undefined : "Drafting geometry is invalid.";
    case "update_room_opening": {
      const room = design.interiors.find((item) => item.id === action.roomId);
      const opening = action.openingId ? room?.openings?.find((item) => item.id === action.openingId) : undefined;
      const roomPatch = action.roomPatch;
      const openingPatch = action.openingPatch;
      return room && (roomPatch || openingPatch) && (!openingPatch || Boolean(opening)) && (!roomPatch || (roomPatch.w === undefined || validDimension(roomPatch.w, 1000)) && (roomPatch.d === undefined || validDimension(roomPatch.d, 1000)) && (roomPatch.x === undefined || isFiniteNumber(roomPatch.x)) && (roomPatch.z === undefined || isFiniteNumber(roomPatch.z)) && (roomPatch.floor === undefined || Number.isInteger(roomPatch.floor) && roomPatch.floor >= 0 && roomPatch.floor <= 300) && (roomPatch.name === undefined || Boolean(roomPatch.name.trim())) && (roomPatch.type === undefined || Boolean(roomPatch.type.trim()))) && (!openingPatch || (openingPatch.offsetM === undefined || isFiniteNumber(openingPatch.offsetM)) && (openingPatch.widthM === undefined || validDimension(openingPatch.widthM, 100)) && (openingPatch.heightM === undefined || validDimension(openingPatch.heightM, 100)) && (openingPatch.sillM === undefined || isFiniteNumber(openingPatch.sillM))) ? undefined : "Room or opening patch is invalid.";
    }
    case "add_room_opening": return design.interiors.some((room) => room.id === action.roomId) && validDimension(action.widthM, 100) && validDimension(action.heightM, 100) && isFiniteNumber(action.offsetM) && isFiniteNumber(action.sillM) ? undefined : "Room opening is invalid.";
    case "add_room_furniture": return Boolean(design.interiors.some((room) => room.id === action.roomId) && catalogEntry(action.catalogId)) && isFiniteNumber(action.x) && isFiniteNumber(action.z) && (action.rotationDeg === undefined || isFiniteNumber(action.rotationDeg)) && (action.scale === undefined || action.scale >= 0.1 && action.scale <= 10) && (action.color === undefined || validColor(action.color)) ? undefined : "Furniture or fixture is not available for this room.";
    case "update_room_furniture": {
      const item = design.interiors.find((room) => room.id === action.roomId)?.furniture?.find((furniture) => furniture.id === action.furnitureId);
      const patch = action.patch;
      return item && Object.keys(patch).length > 0 && (patch.name === undefined || Boolean(patch.name.trim())) && (patch.scale === undefined || patch.scale >= 0.1 && patch.scale <= 10) && (patch.color === undefined || validColor(patch.color)) && Object.entries(patch).every(([key, value]) => ["name", "x", "z", "rotationDeg", "scale", "color", "mount", "mountWall", "mountHeightM"].includes(key) && (key === "name" || key === "color" || typeof value === "number" ? (key === "color" ? validColor(value) : key === "name" ? Boolean(value) : isFiniteNumber(value)) : true)) ? undefined : "Furniture patch is invalid.";
    }
    case "update_infrastructure": return "Infrastructure actions apply in the infrastructure editor.";
    case "generate_infrastructure_model": return "Infrastructure actions apply in the infrastructure editor.";
    default: return "Action is not supported by this editor.";
  }
}

export function previewAssistantActions(actions: AssistantAction[], design: CommunityDesign, branch: BuildingBranch): AssistantActionPreview[] {
  return actions.map((action) => {
    const reason = invalidAction(action, design, branch);
    return { action, label: actionLabel(action), applicable: !reason, reason };
  });
}

export function applyCommunityAssistantActions(actions: AssistantAction[], design: CommunityDesign, branch: BuildingBranch): { design: CommunityDesign; applied: AssistantAction[]; skipped: AssistantActionPreview[]; step?: AssistantResult["step"]; selectedId?: string } {
  const previews = previewAssistantActions(actions, design, branch);
  if (previews.some((item) => !item.applicable && !unsupportedAction(item.action))) {
    return { design, applied: [], skipped: previews };
  }
  let next = design;
  let step: AssistantResult["step"];
  let selectedId: string | undefined;
  const applied: AssistantAction[] = [];
  for (const item of previews) {
    const action = item.action;
    if (!item.applicable || unsupportedAction(action)) continue;
    switch (action.type) {
      case "set_plot_dimensions": next = { ...next, land: { unit: action.unit, width: action.width, depth: action.depth } }; step = "land"; break;
      case "add_tower": {
        const tower = { ...defaultTower(branch, action.label.trim(), action.x, action.z), ...(action.floors === undefined ? {} : { floors: action.floors }), ...(action.unitsPerFloor === undefined ? {} : { unitsPerFloor: action.unitsPerFloor }) };
        next = { ...next, towers: [...next.towers, tower] }; selectedId = tower.id; step = "towers"; break;
      }
      case "remove_tower": next = { ...next, towers: next.towers.filter((tower) => tower.id !== action.towerId), interiors: next.interiors.filter((room) => room.towerId !== action.towerId), exteriors: next.exteriors.filter((panel) => panel.towerId !== action.towerId) }; if (selectedId === action.towerId) selectedId = undefined; step = "towers"; break;
      case "update_tower": next = { ...next, towers: next.towers.map((tower) => tower.id === action.towerId ? { ...tower, ...action.patch } : tower) }; selectedId = action.towerId; step = "towers"; break;
      case "add_amenity": { const amenity = updateAmenity(makeAmenity(action.kind, action.x, action.z), {
        ...(action.w === undefined ? {} : { w: action.w }),
        ...(action.d === undefined ? {} : { d: action.d }),
        ...(action.h === undefined ? {} : { h: action.h }),
      }); next = { ...next, amenities: [...next.amenities, amenity] }; selectedId = amenity.id; step = "amenities"; break; }
      case "remove_amenity": next = { ...next, amenities: next.amenities.filter((amenity) => amenity.id !== action.amenityId) }; if (selectedId === action.amenityId) selectedId = undefined; step = "amenities"; break;
      case "update_amenity": next = { ...next, amenities: next.amenities.map((amenity) => amenity.id === action.amenityId ? updateAmenity(amenity, action.patch) : amenity) }; selectedId = action.amenityId; step = "amenities"; break;
      case "add_drafting_element": { const draft: DraftElement = { id: uid("ai"), kind: action.kind, x: action.x, z: action.z, w: action.w, d: action.d, h: action.h, rotationDeg: action.rotationDeg, color: action.color, label: action.label }; next = { ...next, drafts: [...(next.drafts ?? []), draft] }; selectedId = draft.id; step = "drafting"; break; }
      case "update_room_opening": {
        next = { ...next, interiors: next.interiors.map((room) => room.id !== action.roomId ? room : {
          ...room,
          ...(action.roomPatch ?? {}),
          ...(action.openingPatch && action.openingId ? { openings: (room.openings ?? []).map((opening) => opening.id === action.openingId ? { ...opening, ...action.openingPatch } : opening) } : {}),
        }) };
        selectedId = action.roomId; step = "towers"; break;
      }
      case "add_room_opening": next = { ...next, interiors: next.interiors.map((room) => room.id === action.roomId ? { ...room, openings: [...(room.openings ?? []), { id: uid("op"), kind: action.kind, wall: action.wall, offsetM: action.offsetM, widthM: action.widthM, heightM: action.heightM, sillM: action.sillM }] } : room) }; selectedId = action.roomId; step = "towers"; break;
      case "add_room_furniture": {
        const entry = catalogEntry(action.catalogId);
        if (!entry) break;
        const furniture: FurnitureItem = { id: uid("fu"), type: action.catalogId, name: action.name?.trim() || entry.name, x: action.x, z: action.z, rotationDeg: action.rotationDeg ?? 0, scale: action.scale ?? 1, color: action.color ?? entry.defaultColor, mount: action.mount ?? furnitureMount(action.catalogId), mountWall: action.mountWall };
        next = { ...next, interiors: next.interiors.map((room) => room.id === action.roomId ? { ...room, furniture: [...(room.furniture ?? []), furniture] } : room) };
        selectedId = action.roomId; step = "towers"; break;
      }
      case "update_room_furniture": next = { ...next, interiors: next.interiors.map((room) => room.id === action.roomId ? { ...room, furniture: (room.furniture ?? []).map((item) => item.id === action.furnitureId ? { ...item, ...action.patch } : item) } : room) }; selectedId = action.roomId; step = "towers"; break;
    }
    applied.push(action);
  }
  return { design: next, applied, skipped: previews.filter((item) => !applied.includes(item.action)) , step, selectedId };
}

function validFacility(value: unknown): value is InfraFacility {
  if (!value || typeof value !== "object") return false;
  const facility = value as Record<string, unknown>;
  return typeof facility.kind === "string" && Boolean(facility.kind.trim()) && typeof facility.count === "number" && Number.isInteger(facility.count) && facility.count >= 0 && facility.count <= 100000 && ["lengthM", "widthM", "heightM"].every((key) => validDimension(facility[key], 1_000_000));
}

function validInfraParameters(parameters: Extract<AssistantAction, { type: "update_infrastructure" }>["parameters"], infra: InfraDesign): string | undefined {
  const numeric = [parameters.lanes, parameters.laneWidthM, parameters.designSpeedKph, parameters.runways, parameters.runwayLengthM, parameters.berths, parameters.heightM];
  if (numeric.some((value) => value !== undefined && (!isFiniteNumber(value) || value < 0))) return "Infrastructure parameters are invalid.";
  if (parameters.lanes !== undefined && infra.kind !== "highway") return "Lanes apply only to highways.";
  if ((parameters.runways !== undefined || parameters.runwayLengthM !== undefined) && infra.kind !== "airport") return "Runways apply only to airports.";
  if (parameters.berths !== undefined && infra.kind !== "ports") return "Berths apply only to ports.";
  if (parameters.heightM !== undefined && infra.kind !== "dams") return "Dam height applies only to dams.";
  if (parameters.facilities?.some((facility) => !validFacility(facility))) return "A facility has invalid dimensions.";
  if (parameters.facilityPatches?.some(({ facilityId, patch }) => {
    if (!infra.facilities?.some((facility) => facility.id === facilityId)) return true;
    return Object.entries(patch).some(([key, value]) => {
      if (key === "kind") return typeof value !== "string" || !value.trim();
      if (!isFiniteNumber(value)) return true;
      return key === "count" ? !Number.isInteger(value) || value < 0 : !validDimension(value, 1_000_000);
    });
  })) return "A facility patch is invalid or refers to a missing facility.";
  return undefined;
}

export function previewInfrastructureAssistantActions(actions: AssistantAction[], infra: InfraDesign): AssistantActionPreview[] {
  return actions.map((action) => {
    let reason: string | undefined;
    if (action.type === "update_infrastructure") reason = validInfraParameters(action.parameters, infra);
    else if (action.type === "generate_infrastructure_model") reason = undefined;
    else reason = "This action is not an infrastructure editor update.";
    return { action, label: actionLabel(action), applicable: !reason, reason };
  });
}

export function isInfrastructureActionPreviewOnly(action: AssistantAction): boolean {
  return action.type !== "update_infrastructure" && action.type !== "generate_infrastructure_model";
}

export function applyInfrastructureAssistantActions(actions: AssistantAction[], infra: InfraDesign): { infra: InfraDesign; applied: AssistantAction[]; skipped: AssistantActionPreview[] } {
  const previews = previewInfrastructureAssistantActions(actions, infra);
  if (previews.some((item) => !item.applicable && !isInfrastructureActionPreviewOnly(item.action))) return { infra, applied: [], skipped: previews };
  let next = infra;
  const applied: AssistantAction[] = [];
  for (const action of actions) {
    if (isInfrastructureActionPreviewOnly(action)) continue;
    if (action.type === "generate_infrastructure_model") next = { ...next, modelReady: true };
    if (action.type === "update_infrastructure") {
      const p = action.parameters;
      const nextFacilities = p.facilities ? p.facilities.map((facility) => ({ ...facility, id: facility.id || uid("facility") })) : next.facilities;
      const patchedFacilities = p.facilityPatches ? (nextFacilities ?? []).map((facility) => {
        const patch = p.facilityPatches?.find((item) => item.facilityId === facility.id)?.patch;
        return patch ? { ...facility, ...patch } : facility;
      }) : nextFacilities;
      next = { ...next, facilities: patchedFacilities };
      if (next.kind === "highway" && next.highway) next.highway = { ...next.highway, ...(p.lanes === undefined ? {} : { lanes: p.lanes }), ...(p.laneWidthM === undefined ? {} : { laneWidthM: p.laneWidthM }), ...(p.designSpeedKph === undefined ? {} : { designSpeedKph: p.designSpeedKph }) };
      if (next.kind === "airport" && next.airport) next.airport = { ...next.airport, ...(p.runways === undefined ? {} : { runways: p.runways }), ...(p.runwayLengthM === undefined ? {} : { runwayLengthM: p.runwayLengthM }) };
      if (next.kind === "ports" && next.ports) next.ports = { ...next.ports, ...(p.berths === undefined ? {} : { berths: p.berths }) };
      if (next.kind === "dams" && next.dams) next.dams = { ...next.dams, ...(p.damType === undefined ? {} : { damType: p.damType }), ...(p.heightM === undefined ? {} : { heightM: p.heightM }) };
    }
    applied.push(action);
  }
  return { infra: next, applied, skipped: previews.filter((item) => !applied.includes(item.action)) };
}

function numberAfter(text: string, pattern: RegExp, fallback: number): number {
  const match = text.match(pattern);
  return match ? Number(match[1]) : fallback;
}

function siteDraft(kind: DraftElementKind): DraftElement {
  return {
    id: uid("ai"),
    kind,
    x: 0,
    z: 0,
    w: kind === "column" ? 0.6 : kind === "wall" ? 10 : 8,
    d: kind === "column" ? 0.6 : kind === "wall" ? 0.2 : 8,
    h: kind === "column" ? 3 : kind === "wall" ? 2.7 : kind === "slab" ? 0.25 : undefined,
    rotationDeg: 0,
    color: "#d6a84a",
  };
}

export function runCommunityCommand(input: string, design: CommunityDesign, branch: BuildingBranch): AssistantResult {
  const text = input.trim().toLowerCase();
  if (!text) return { design, reply: "Type a design command, for example: add a 4-floor villa or create a 30 m x 20 m plot." };
  if (text === "help" || text === "what can you do") {
    return { design, reply: "Try: create a 30 m x 20 m plot, add a swimming pool, add a wall, add a 4-floor tower, set units per floor to 6, clear the site." };
  }
  if (text.includes("clear") && (text.includes("site") || text.includes("everything"))) {
    return { design: { ...design, towers: [], amenities: [], drafts: [], exteriors: [], interiors: [] }, reply: "Cleared buildings, amenities, drafting geometry, exteriors and interiors. The plot remains.", step: "land" };
  }

  const plot = text.match(/(?:create|set|make).*?(\d+(?:\.\d+)?)\s*(?:m|meter|metres?)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:m|meter|metres?)?/);
  if (plot) {
    const width = Math.max(Number(plot[1]), 1);
    const depth = Math.max(Number(plot[2]), 1);
    return { design: { ...design, land: { ...design.land, unit: "m", width, depth } }, reply: `Set the plot to ${width} × ${depth} m.`, step: "land" };
  }

  const floors = numberAfter(text, /(?:set|make).*?(?:floor|storey)s?\s*(?:to|=)?\s*(\d+)/, 0);
  if (floors > 0 && design.towers.length) {
    const towers = design.towers.map((tower, index) => index === design.towers.length - 1 ? { ...tower, floors } : tower);
    return { design: { ...design, towers }, reply: `Set ${design.towers[design.towers.length - 1].label} to ${floors} floors.`, step: "towers" };
  }

  const units = numberAfter(text, /(?:set|make).*?(?:units?|houses?).*?(?:per floor)?\s*(?:to|=)?\s*(\d+)/, 0);
  if (units > 0 && design.towers.length) {
    const towers = design.towers.map((tower, index) => index === design.towers.length - 1 ? { ...tower, unitsPerFloor: units } : tower);
    return { design: { ...design, towers }, reply: `Set ${design.towers[design.towers.length - 1].label} to ${units} units per floor.`, step: "towers" };
  }

  const draftKind = (["wall", "slab", "column", "roof", "line", "rectangle", "circle", "dimension"] as DraftElementKind[]).find((kind) => text.includes(kind));
  if (draftKind) {
    return { design: { ...design, drafts: [...(design.drafts ?? []), siteDraft(draftKind)] }, reply: `Added a ${draftKind}. Select it to edit its dimensions and position.`, step: "drafting" };
  }

  const amenity = AMENITIES.find((candidate) => text.includes(candidate.kind) || text.includes(candidate.label.toLowerCase()));
  if (amenity && (!amenity.branch || amenity.branch === branch)) {
    const index = design.amenities.length;
    const next = { id: uid("ai"), kind: amenity.kind, x: -design.land.width / 2 + 8 + (index % 4) * 8, z: -design.land.depth / 2 + 8 + Math.floor(index / 4) * 8, rotY: 0, w: amenity.defW, d: amenity.defD, h: amenity.defH };
    return { design: { ...design, amenities: [...design.amenities, next] }, reply: `Added ${amenity.label}. You can move and resize it in the scene.`, step: "amenities" };
  }

  if (text.includes("tower") || text.includes("building") || text.includes("villa") || text.includes("townhouse")) {
    const label = text.includes("villa") ? "Villa" : text.includes("townhouse") ? "Townhouse" : branch === "residential" ? "Tower" : "Block";
    const tower = defaultTower(branch, `${label} ${design.towers.length + 1}`, 0, 0);
    return { design: { ...design, towers: [...design.towers, tower] }, reply: `Added ${tower.label}. Set floors, units, dimensions and openings in the properties panel.`, step: "towers" };
  }

  return { design, reply: "I could not map that command yet. Try “help” for supported commands." };
}
