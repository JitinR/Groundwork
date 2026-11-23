import type { Design, DocumentationSchedule, FurnitureItem, MepDesign, ParametricFamilyMetadata } from "../types";
import { amenityFootprint, towerMeters } from "./community";
import { resolveDraft, resolveRoomOpening, resolveTowerOpening } from "./parametric";
import { cadFootprintArea } from "./cadModel";

export type ScheduleCell = string | number | boolean;
export interface ScheduleRecord {
  id: string;
  scope: string;
  domain: DocumentationSchedule["category"];
  values: Record<string, ScheduleCell>;
}
export interface ScheduleRow { id: string; sourceIds: string[]; cells: ScheduleCell[]; }
export interface ScheduleResult { fields: string[]; rows: ScheduleRow[]; sourceCount: number; warnings: string[]; }

export const SCHEDULE_FIELDS = ["Id", "Category", "Name", "Scope", "Quantity", "Unit", "Width m", "Depth m", "Height m", "Diameter m", "Length m", "Area m2", "Volume m3", "Elevation m", "Level", "Floor", "Phase", "Family", "Type", "Host", "Material", "System", "Visible", "Scale", "Rated power kW"];
const key = (field: string) => field.trim().toLowerCase().replace(/\s+/g, " ");
const finite = (value: number | undefined): ScheduleCell => typeof value === "number" && Number.isFinite(value) ? value : "";
const product = (...values: number[]): ScheduleCell => {
  if (!values.every(value => Number.isFinite(value) && value >= 0)) return "";
  return finite(values.reduce((total, value) => total * value, 1));
};

/** Persisted occurrences only: generated facade windows, framing and shell proxies are not invented. */
export function documentationInventory(design: Design): ScheduleRecord[] {
  const records: ScheduleRecord[] = [];
  const add = (id: string, domain: DocumentationSchedule["category"], scope: string, category: string, name: string, values: Record<string, ScheduleCell> = {}, family?: ParametricFamilyMetadata) => {
    const cells: Record<string, ScheduleCell> = { id, category, name, scope, quantity: 1, unit: "each", ...values };
    if (family) {
      cells.family = family.family ?? "";
      cells.type = family.type ?? cells.type ?? "";
      cells.host = family.hostId ?? cells.host ?? "";
      cells.level = family.levelId ?? cells.level ?? "";
      for (const [field, value] of Object.entries(family.typeParameters ?? {})) cells[key(`TypeParameter:${field}`)] = typeof value === "number" ? finite(value) : value;
      for (const [field, value] of Object.entries(family.instanceParameters ?? {})) cells[key(`InstanceParameter:${field}`)] = typeof value === "number" ? finite(value) : value;
    }
    records.push({ id, domain, scope, values: cells });
  };
  const furniture = (items: FurnitureItem[], scope: string, level = "") => {
    for (const item of items) add(item.id, "furniture", scope, "furniture", item.name, { type: item.type, material: item.finish ?? "", scale: finite(item.scale), level, phase: item.phaseId ?? "" });
  };
  const mep = (value: MepDesign | undefined, scope: string) => {
    for (const item of value?.elements ?? []) {
      let length = 0;
      let valid = true;
      for (let i = 1; i < item.route.length; i += 1) {
        const a = item.route[i - 1]; const b = item.route[i];
        const segment = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (!Number.isFinite(segment)) valid = false; else length += segment;
      }
      add(item.id, "mep", scope, item.kind, item.name, { "width m": finite(item.width), "height m": finite(item.height), "length m": valid ? finite(length) : "", level: item.levelId ?? "", phase: item.phaseId ?? "", system: item.system ?? "", visible: item.visible, "rated power kw": finite(item.ratedPowerKw) }, item.family);
    }
  };
  add("room", "rooms", "room", "room", "Room shell", { "width m": finite(design.room.widthMm / 1000), "depth m": finite(design.room.depthMm / 1000), "height m": finite(design.room.wallHeightMm / 1000), "area m2": product(design.room.widthMm / 1000, design.room.depthMm / 1000), "volume m3": product(design.room.widthMm / 1000, design.room.depthMm / 1000, design.room.wallHeightMm / 1000) });
  furniture(design.furniture, "room"); mep(design.mep, "room");
  const community = design.community;
  if (community) {
    const levels = community.levels ?? [];
    for (const level of levels) add(level.id, "levels", "community", "level", level.name, { "elevation m": finite(level.elevation), "height m": finite(level.floorHeight), level: level.id });
    for (const tower of community.towers) {
      const size = towerMeters(tower);
      add(tower.id, "objects", "community", "tower", tower.label, { "width m": finite(size.w), "depth m": finite(size.d), "height m": finite(size.h), "area m2": product(size.w, size.d), floor: finite(tower.floors), material: tower.facadeMaterial, phase: tower.phaseId ?? "" }, tower.family);
      for (const opening of tower.openings ?? []) {
        const resolved = resolveTowerOpening(opening);
        add(opening.id, "objects", `tower:${tower.id}`, opening.kind, `${opening.kind} ${opening.face}`, { "width m": finite(resolved.width), "height m": finite(resolved.height), "area m2": product(resolved.width, resolved.height), "elevation m": finite(opening.floor * tower.floorHeight + resolved.sill), floor: opening.floor, host: tower.id, phase: tower.phaseId ?? "" }, opening.family);
      }
    }
    for (const room of community.interiors) {
      add(room.id, "rooms", `tower:${room.towerId}`, "room", room.name, { "width m": finite(room.w), "depth m": finite(room.d), "area m2": product(room.w, room.d), floor: room.floor, type: room.type, host: room.towerId, phase: room.phaseId ?? "" }, room.family);
      furniture(room.furniture ?? [], `interior:${room.id}`, room.family?.levelId ?? ""); mep(room.mep, `interior:${room.id}`);
      for (const opening of room.openings ?? []) {
        const resolved = resolveRoomOpening(opening);
        add(opening.id, "objects", `interior:${room.id}`, opening.kind, `${opening.kind} ${opening.wall}`, { "width m": finite(resolved.width), "height m": finite(resolved.height), "area m2": product(resolved.width, resolved.height), floor: room.floor, host: room.id, phase: room.phaseId ?? "" }, opening.family);
      }
    }
    for (const item of community.amenities) {
      const footprint = amenityFootprint(item);
      add(item.id, "objects", "community", "amenity", item.label ?? item.kind, {
        type: item.kind, "width m": finite(footprint.w), "depth m": finite(footprint.d),
        "diameter m": finite(footprint.diameter), "height m": finite(item.h), "area m2": finite(footprint.area), phase: item.phaseId ?? "",
      });
    }
    for (const item of community.exteriors) add(item.id, "objects", `tower:${item.towerId}`, "facade panel", item.material, { "width m": finite(item.w), "height m": finite(item.h), "area m2": product(item.w, item.h), material: item.material, host: item.towerId });
  }
  if (!design.community && !design.infra) for (const level of design.cad?.levels ?? []) add(level.id, "levels", "cad", "level", level.name, { "elevation m": finite(level.elevation), "height m": finite(level.floorHeight), level: level.id });
  for (const [scope, model] of [["community", design.community], ["infrastructure", design.infra], ["cad", !design.community && !design.infra ? { drafts: design.drafts, mep: undefined } : undefined]] as const) {
    if (!model) continue;
    for (const draft of model.drafts ?? []) {
      const resolved = resolveDraft(draft, scope === "community" && design.community?.levels?.length ? design.community.levels : design.cad?.levels ?? []);
      const solid = ["wall", "slab", "roof", "column", "beam"].includes(draft.kind);
      const circular = draft.kind === "column" && draft.family?.type === "circular-column";
      const area = cadFootprintArea(draft, scope === "community" && design.community?.levels?.length ? design.community.levels : design.cad?.levels ?? []);
      const voidVolume = (draft.openings ?? []).reduce((total, opening) => total + opening.widthM * opening.heightM * resolved.depth, 0);
      add(draft.id, "objects", scope, draft.kind, draft.label ?? draft.family?.instance ?? draft.kind, { "width m": finite(resolved.width), "depth m": finite(resolved.depth), "height m": finite(resolved.height), "diameter m": circular ? finite(resolved.width) : "", "length m": solid ? finite(draft.kind === "column" ? resolved.height : resolved.width) : "", "area m2": solid ? finite(area) : "", "volume m3": solid ? finite(Math.max(0, area * resolved.height - voidVolume)) : "", "elevation m": finite(resolved.elevation), phase: draft.phaseId ?? "", material: draft.material ?? String(draft.family?.typeParameters?.material ?? ""), visible: draft.visible !== false }, draft.family);
      for (const opening of draft.openings ?? []) add(opening.id, "objects", scope, opening.kind, `${opening.kind} in ${draft.label ?? draft.id}`, { "width m": finite(opening.widthM), "height m": finite(opening.heightM), "area m2": product(opening.widthM, opening.heightM), "elevation m": finite(resolved.elevation + opening.sillM), host: draft.id, level: draft.family?.levelId ?? "" });
    }
    mep(model.mep, scope);
  }
  for (const item of design.infra?.facilities ?? []) add(item.id, "objects", "infrastructure", "facility", item.kind, { type: item.kind, quantity: finite(item.count), "width m": finite(item.widthM), "depth m": finite(item.lengthM), "height m": finite(item.heightM), "area m2": product(item.widthM, item.lengthM, item.count), "volume m3": product(item.widthM, item.lengthM, item.heightM, item.count), phase: item.phaseId ?? "" });
  return records;
}

const compare = (a: ScheduleCell, b: ScheduleCell): number => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en", { numeric: true });
const sumFields = new Set(["quantity", "length m", "area m2", "volume m3", "rated power kw"]);

export function buildDocumentationSchedule(design: Design, schedule: DocumentationSchedule, inventory = documentationInventory(design)): ScheduleResult {
  const warnings: string[] = [];
  const fields = schedule.fields.map(field => field.trim()).filter(Boolean);
  const known = new Set([...SCHEDULE_FIELDS.map(key), ...inventory.flatMap(record => Object.keys(record.values))]);
  if (!fields.length) warnings.push("Select at least one schedule field.");
  for (const field of [...fields, ...(schedule.filters ?? []).map(filter => filter.field), schedule.sortField ?? "", schedule.groupBy ?? ""].filter(Boolean)) if (!known.has(key(field))) warnings.push(`Unknown field: ${field}. Its values are blank.`);
  let records = inventory.filter(record => schedule.category === "objects" ? record.domain !== "levels" : record.domain === schedule.category);
  records = records.filter(record => (schedule.filters ?? []).every(filter => {
    const value = record.values[key(filter.field)] ?? "";
    if (filter.operator === "contains") return String(value).toLowerCase().includes(filter.value.toLowerCase());
    if (filter.operator === "equals") return String(value).toLowerCase() === filter.value.toLowerCase();
    const threshold = Number(filter.value);
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(threshold) || !filter.value.trim()) return false;
    return filter.operator === "greater-than" ? value > threshold : value < threshold;
  }));
  const sourceCount = records.length;
  let rows: ScheduleRow[];
  if (schedule.groupBy?.trim()) {
    const groups = new Map<string, ScheduleRecord[]>();
    for (const record of records) {
      const value = record.values[key(schedule.groupBy)] ?? "";
      const groupKey = JSON.stringify([typeof value, value]);
      const group = groups.get(groupKey) ?? []; group.push(record); groups.set(groupKey, group);
    }
    rows = [...groups.entries()].map(([groupId, group]) => ({ id: `group:${groupId}`, sourceIds: group.map(record => record.id), cells: fields.map(field => {
      const values = group.map(record => record.values[key(field)] ?? "");
      if (sumFields.has(key(field))) return values.every(value => typeof value === "number" && Number.isFinite(value)) ? finite(values.reduce<number>((sum, value) => sum + Number(value), 0)) : "";
      return values.every(value => value === values[0]) ? values[0] : "(varies)";
    }) }));
    if (schedule.sortField && !fields.some(field => key(field) === key(schedule.sortField!))) warnings.push("Grouped sort field must be one of the displayed fields; groups retain model order.");
  } else rows = records.map(record => ({ id: `${record.scope}:${record.id}`, sourceIds: [record.id], cells: fields.map(field => record.values[key(field)] ?? "") }));
  if (schedule.sortField) {
    const direction = schedule.sortDirection === "desc" ? -1 : 1;
    const index = fields.findIndex(field => key(field) === key(schedule.sortField!));
    if (index >= 0) rows.sort((a, b) => direction * compare(a.cells[index], b.cells[index]) || a.id.localeCompare(b.id));
    else if (!schedule.groupBy) {
      const byId = new Map(records.map(record => [`${record.scope}:${record.id}`, record]));
      rows.sort((a, b) => direction * compare(byId.get(a.id)?.values[key(schedule.sortField!)] ?? "", byId.get(b.id)?.values[key(schedule.sortField!)] ?? "") || a.id.localeCompare(b.id));
    }
  }
  return { fields, rows, sourceCount, warnings: [...new Set(warnings)] };
}

export function scheduleCellText(cell: ScheduleCell): string {
  return typeof cell === "number" ? (Number.isFinite(cell) ? String(Math.abs(cell) < 1e15 ? Math.round(cell * 10000) / 10000 : cell) : "") : String(cell);
}

export function documentationScheduleCsv(result: ScheduleResult): string {
  const csv = (cell: ScheduleCell) => {
    let value = scheduleCellText(cell);
    if (typeof cell === "string" && /^[\s\uFEFF]*[=+\-@]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [result.fields.map(csv).join(","), ...result.rows.map(row => row.cells.map(csv).join(","))].join("\r\n") + "\r\n";
}
