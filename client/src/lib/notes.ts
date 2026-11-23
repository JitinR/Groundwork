import type { CommunityDesign } from "../types";
import { FACADES, UNIT_LABELS, amenityFootprint, amenityKind, landAreaSqYards, landMeters, undergroundDepth, undergroundRamp } from "./community";
import { computeTakeoff, type TakeoffResult } from "./takeoff";
import { communityReviewFindings } from "./review";
import { analyzeCommunity } from "./structural";

/**
 * Notes-app export.
 *
 * Produces a plain-text brief that pastes cleanly into Notepad, OneNote,
 * Samsung Notes, Apple Notes or any markdown-aware editor, and provides
 * download / clipboard / native-share helpers.
 */

export interface NotesContext {
  projectName: string;
  design: CommunityDesign;
  takeoff?: TakeoffResult;
}

const pad = (label: string, value: string, width = 34) => {
  const dots = Math.max(2, width - label.length);
  return `${label} ${".".repeat(dots)} ${value}`;
};

export function buildNotesText({ projectName, design, takeoff }: NotesContext): string {
  const t = takeoff ?? computeTakeoff(design);
  const land = landMeters(design.land);
  const branch = design.branch === "residential" ? "Residential community" : "Commercial complex";
  const now = new Date();
  const lines: string[] = [];

  lines.push(`# ${projectName}`);
  lines.push(`${branch} · generated ${now.toLocaleString()}`);
  lines.push("");

  lines.push("## Site");
  lines.push(pad("Plot size", `${design.land.width} × ${design.land.depth} ${UNIT_LABELS[design.land.unit]}`));
  lines.push(pad("Plot area", `${Math.round(land.w * land.d).toLocaleString()} m² (${Math.round(landAreaSqYards(design.land)).toLocaleString()} sq yd)`));
  lines.push(pad("Footprint", `${t.summary.footprintM2.toLocaleString()} m²`));
  lines.push(pad("Built-up area", `${t.summary.builtUpM2.toLocaleString()} m²`));
  lines.push(pad("FAR / FSI", `${t.summary.far}`));
  lines.push(pad("Open area", `${t.summary.openAreaM2.toLocaleString()} m²`));
  lines.push("");

  lines.push("## Parking & basement");
  lines.push(pad("Parking type", design.parking.mode === "none" ? "None" : design.parking.mode === "surface" ? "Surface" : "Underground"));
  if (design.parking.mode === "underground" && design.parking.underground) {
    const u = design.parking.underground;
    const ramp = undergroundRamp(u);
    lines.push(pad("Basement levels", `${u.levels}`));
    lines.push(pad("Basement storey height", `${u.floorHeight} m`));
    lines.push(pad("First parking deck depth", `${ramp.rise.toFixed(2)} m`));
    lines.push(pad("Foundation depth", `${u.foundationDepth} m`));
    lines.push(pad("Excavation depth", `${undergroundDepth(u).toFixed(1)} m`));
    lines.push(pad("Ramp", `${ramp.width} m wide × ${ramp.length} m horizontal run @ ${ramp.slope}%`));
    lines.push(pad("Lift / stair lobby", `${u.liftLobby ? "Yes" : "No"} / ${u.stairLobby ? "Yes" : "No"}`));
  }
  lines.push(pad("Parking bays", `${t.summary.parkingBays}`));
  lines.push("");

  lines.push("## Towers");
  design.towers.forEach((tw, i) => {
    const facade = FACADES.find((f) => f.key === tw.facadeMaterial)?.label ?? tw.facadeMaterial;
    lines.push(`${i + 1}. ${tw.label}`);
    lines.push(`   Floors ${tw.floors} · ${tw.unitsPerFloor} units/floor · floor height ${tw.floorHeight} m`);
    lines.push(`   Unit ${tw.unitWidth} × ${tw.unitDepth} m · door faces ${tw.doorFacing} · facade ${facade}`);
    lines.push(`   Common ${tw.commonAreaPerFloor} m² · open ${tw.openAreaPerFloor} m² per floor`);
  });
  lines.push("");

  if (design.amenities.length > 0) {
    lines.push("## Ground-floor amenities");
    design.amenities.forEach((a) => {
      const k = amenityKind(a.kind);
      const footprint = amenityFootprint(a);
      const size = footprint.diameter === undefined ? `${footprint.w} × ${footprint.d} m` : `Ø ${footprint.diameter} m`;
      lines.push(`- ${a.label ?? k?.label ?? a.kind} — ${size}`);
    });
    lines.push("");
  }

  lines.push("## Level & drafting schedule");
  for (const level of design.levels ?? [{ name: "Ground Floor", elevation: 0, floorHeight: 3.2 }]) {
    lines.push(`- ${level.name} · elevation ${level.elevation} m · floor height ${level.floorHeight} m`);
  }
  lines.push(`- Structural grid lines · ${design.structuralGrid?.length ?? 0}`);
  for (const draft of design.drafts ?? []) {
    const annotation = draft.civilKind ? ` · ${draft.civilKind}` : "";
    lines.push(`- ${draft.kind}${annotation} · ${draft.w} × ${draft.d} m at (${draft.x}, ${draft.z})`);
  }
  lines.push("");

  const structural = analyzeCommunity(design);
  lines.push("## Preliminary structural screening");
  lines.push("Not certified engineering, a code check, or a substitute for site-specific loads, geotechnical information, sealed drawings, or a licensed structural engineer.");
  lines.push(`- Floor area · ${structural.totalAreaM2.toFixed(0)} m²`);
  lines.push(`- Gravity load screen · ${structural.totalLoadKN.toFixed(0)} kN`);
  lines.push(`- Wind base shear screen · ${structural.totalWindBaseShearKN.toFixed(0)} kN`);
  lines.push(`- Seismic base shear screen · ${structural.totalSeismicBaseShearKN.toFixed(0)} kN`);
  structural.results.forEach((result) => lines.push(`- ${result.tower.label} · governing ${result.governingCombination} · ${result.governingLoadKN.toFixed(0)} kN · lateral screen ${result.lateralUtilization.toFixed(2)}x`));
  structural.warnings.forEach((warning) => lines.push(`- Warning · ${warning}`));
  lines.push("");

  if (design.exteriors.length > 0) {
    lines.push("## Exterior material panels");
    design.exteriors.forEach((p) => {
      const facade = FACADES.find((f) => f.key === p.material)?.label ?? p.material;
      const tower = design.towers.find((x) => x.id === p.towerId)?.label ?? p.towerId;
      lines.push(`- ${tower} · ${p.face} face · ${p.w} × ${p.h} m · ${facade}`);
    });
    lines.push("");
  }

  const roomsWithFurniture = design.interiors.filter((r) => r.furniture && r.furniture.length > 0);
  if (roomsWithFurniture.length > 0) {
    lines.push("## Interiors");
    roomsWithFurniture.forEach((r) => {
      const tower = design.towers.find((x) => x.id === r.towerId)?.label ?? r.towerId;
      lines.push(`- ${r.name} (${tower}, floor ${r.floor})`);
      r.furniture!.forEach((f) => lines.push(`    · ${f.name}`));
    });
    lines.push("");
  }

  const findings = communityReviewFindings(design);
  const markups = design.review?.markers ?? [];
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
      lines.push(pad(item.label, `${item.qty.toLocaleString()} ${item.unit}`));
    }
    lines.push("");
  }

  lines.push("## Basis of quantities");
  for (const item of t.items) {
    lines.push(`- ${item.label}: ${item.basis}`);
  }
  lines.push("");
  lines.push("Estimates follow conventional RCC practice and standard work-item norms.");
  lines.push("Verify against structural drawings and a certified BOQ before procurement.");
  lines.push("");

  return lines.join("\n");
}

export function notesFilename(projectName: string): string {
  const safe = projectName.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").slice(0, 40) || "project";
  return `${safe}-brief.txt`;
}

export function boqFilename(projectName: string): string {
  const safe = projectName.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").slice(0, 40) || "project";
  return `${safe}-boq.csv`;
}

export function buildBoqCsv(items: Array<{ group: string; label: string; qty: number; unit: string; basis: string }>): string {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  return [
    ["Group", "Item", "Quantity", "Unit", "Basis"].map(cell).join(","),
    ...items.map((item) => [item.group, item.label, item.qty, item.unit, item.basis].map(cell).join(",")),
  ].join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function shareText(title: string, text: string): Promise<boolean> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (!nav.share) return false;
  try {
    await nav.share({ title, text });
    return true;
  } catch {
    return false;
  }
}
