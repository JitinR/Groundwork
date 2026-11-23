import type { MepDesign, MepElement, ReviewMarker } from "../types";
import type { CommunityReviewInput, InfraReviewInput } from "./reviewWorkerProtocol";
import { amenityFootprint, amenityKind, towerMeters } from "./community";
import { SpatialHash2D } from "./performance";

export interface ReviewFinding {
  id: string;
  text: string;
  severity: "warning" | "blocker";
  category: "clash" | "clearance" | "vertical" | "mep-building" | "mep-structure" | "site-fit";
  score: number;
  approximation: string;
  x: number;
  z: number;
  targetIds: string[];
}

type Footprint = { id: string; label: string; x: number; z: number; w: number; d: number; rotationDeg: number; minY: number; maxY: number };
type PointStructure = { id: string; label: string; x: number; z: number; w: number; d: number; minY: number; maxY: number };

const footprintRadius = (box: { w: number; d: number }) => Math.hypot(box.w, box.d) / 2;
function footprintIndex<T extends { id: string; x: number; z: number; w: number; d: number }>(objects: T[]) {
  const index = new SpatialHash2D<T>(20);
  for (const object of objects) {
    if ([object.x, object.z, object.w, object.d].every(Number.isFinite)) index.insert({ id: object.id, x: object.x, z: object.z, radius: footprintRadius(object), value: object });
  }
  return index;
}

/** Circular broad phase retains every rotated-envelope candidate for the SAT narrow phase. */
function* footprintPairs(objects: Footprint[]): Generator<[Footprint, Footprint]> {
  const index = footprintIndex(objects), order = new Map(objects.map((box, i) => [box.id, i]));
  for (const [i, a] of objects.entries()) {
    for (const b of index.query(a.x, a.z, footprintRadius(a))) if ((order.get(b.id) ?? -1) > i) yield [a, b.value];
  }
}

function axes(box: Footprint): [number, number][] {
  const angle = box.rotationDeg * Math.PI / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  return [[cos, sin], [-sin, cos]];
}

function projection(box: Footprint, axis: [number, number]): { min: number; max: number } {
  const radius = Math.abs(axis[0] * Math.cos(box.rotationDeg * Math.PI / 180) + axis[1] * Math.sin(box.rotationDeg * Math.PI / 180)) * box.w / 2
    + Math.abs(axis[0] * -Math.sin(box.rotationDeg * Math.PI / 180) + axis[1] * Math.cos(box.rotationDeg * Math.PI / 180)) * box.d / 2;
  const center = box.x * axis[0] + box.z * axis[1];
  return { min: center - radius, max: center + radius };
}

function horizontalGap(a: Footprint, b: Footprint): number {
  const centerDelta: [number, number] = [b.x - a.x, b.z - a.z];
  let gap = 0;
  for (const axis of [...axes(a), ...axes(b)]) {
    const distance = Math.abs(centerDelta[0] * axis[0] + centerDelta[1] * axis[1]);
    const separation = distance - (projection(a, axis).max - projection(a, axis).min) / 2 - (projection(b, axis).max - projection(b, axis).min) / 2;
    gap = Math.max(gap, separation);
  }
  return Math.max(gap, 0);
}

function horizontalOverlap(a: Footprint, b: Footprint): boolean {
  const centerDelta: [number, number] = [b.x - a.x, b.z - a.z];
  return [...axes(a), ...axes(b)].every((axis) => {
    const distance = Math.abs(centerDelta[0] * axis[0] + centerDelta[1] * axis[1]);
    return distance < (projection(a, axis).max - projection(a, axis).min) / 2 + (projection(b, axis).max - projection(b, axis).min) / 2;
  });
}

function verticalOverlap(a: { minY: number; maxY: number }, b: { minY: number; maxY: number }): boolean {
  return a.minY < b.maxY && a.maxY > b.minY;
}

function verticalGap(a: { minY: number; maxY: number }, b: { minY: number; maxY: number }): number {
  return Math.max(Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY), 0);
}

function finding(id: string, text: string, severity: "warning" | "blocker", category: ReviewFinding["category"], score: number, x: number, z: number, targetIds: string[]): ReviewFinding {
  return { id, text, severity, category, score, approximation: "Preliminary envelope approximation; verify in coordinated 3D/BIM geometry.", x, z, targetIds };
}

function mepEnvelope(element: MepElement): Footprint | null {
  if (!element.route.length) return null;
  const xs = element.route.map((point) => point.x); const zs = element.route.map((point) => point.z); const ys = element.route.map((point) => point.y);
  const radius = element.kind === "duct" ? Math.max(element.width, element.height) / 2 : Math.max(element.width, element.diameter) / 2;
  return { id: element.id, label: element.name, x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, w: Math.max(Math.max(...xs) - Math.min(...xs), radius * 2), d: Math.max(Math.max(...zs) - Math.min(...zs), radius * 2), rotationDeg: 0, minY: Math.min(...ys) - (element.kind === "duct" ? element.height : element.diameter) / 2, maxY: Math.max(...ys) + (element.kind === "duct" ? element.height : element.diameter) / 2 };
}

function mepFindings(mep: MepDesign | undefined, structures: Footprint[], pointStructures: PointStructure[], prefix: string): ReviewFinding[] {
  const elements = (mep?.elements ?? []).filter((element) => element.visible).map(mepEnvelope).filter((item): item is Footprint => Boolean(item));
  const findings: ReviewFinding[] = [];
  for (const [a, b] of footprintPairs(elements)) {
    if (horizontalOverlap(a, b) && verticalOverlap(a, b)) findings.push(finding(`${prefix}-mep-clash-${a.id}-${b.id}`, `${a.label} intersects ${b.label} in the approximate 3D envelope`, "blocker", "clash", 92, (a.x + b.x) / 2, (a.z + b.z) / 2, [a.id, b.id]));
  }
  const structureIndex = footprintIndex(structures), pointIndex = footprintIndex(pointStructures);
  for (const element of elements) for (const { value: structure } of structureIndex.query(element.x, element.z, footprintRadius(element) + 0.2)) {
    const gap = horizontalGap(element, structure);
    if (gap <= 0 && verticalOverlap(element, structure)) findings.push(finding(`${prefix}-mep-building-${element.id}-${structure.id}`, `${element.label} crosses the ${structure.label} building envelope`, "warning", "mep-building", 76, element.x, element.z, [element.id, structure.id]));
    else if (gap > 0 && gap < 0.2 && verticalOverlap(element, structure)) findings.push(finding(`${prefix}-mep-clearance-${element.id}-${structure.id}`, `${element.label} is about ${gap.toFixed(2)} m from ${structure.label}; below the 0.20 m planning clearance`, "warning", "clearance", 62, element.x, element.z, [element.id, structure.id]));
    else if (gap <= 0 && !verticalOverlap(element, structure) && verticalGap(element, structure) < 0.2) findings.push(finding(`${prefix}-vertical-${element.id}-${structure.id}`, `${element.label} and ${structure.label} are vertically separated by only about ${verticalGap(element, structure).toFixed(2)} m`, "warning", "vertical", 57, element.x, element.z, [element.id, structure.id]));
  }
  for (const element of elements) for (const { value: structure } of pointIndex.query(element.x, element.z, footprintRadius(element) + 0.2)) {
    const pointBox: Footprint = { ...structure, rotationDeg: 0 };
    const gap = horizontalGap(element, pointBox);
    if (gap <= 0 && verticalOverlap(element, structure)) findings.push(finding(`${prefix}-mep-structure-${element.id}-${structure.id}`, `${element.label} intersects approximate structural element ${structure.label}`, "blocker", "mep-structure", 88, element.x, element.z, [element.id, structure.id]));
    else if (gap < 0.15 && verticalOverlap(element, structure)) findings.push(finding(`${prefix}-structure-clearance-${element.id}-${structure.id}`, `${element.label} has only about ${gap.toFixed(2)} m clearance to ${structure.label}`, "warning", "clearance", 58, element.x, element.z, [element.id, structure.id]));
    else if (gap <= 0 && !verticalOverlap(element, structure) && verticalGap(element, structure) < 0.2) findings.push(finding(`${prefix}-structure-vertical-${element.id}-${structure.id}`, `${element.label} and ${structure.label} have only about ${verticalGap(element, structure).toFixed(2)} m vertical separation`, "warning", "vertical", 54, element.x, element.z, [element.id, structure.id]));
  }
  return findings;
}

export function communityReviewFindings(design: CommunityReviewInput): ReviewFinding[] {
  const objects: Footprint[] = [
    ...design.towers.map((tower) => {
      const size = towerMeters(tower);
      return { id: tower.id, label: tower.label, x: tower.x, z: tower.z, w: size.w, d: size.d, rotationDeg: tower.rotY ?? 0, minY: 0, maxY: size.h };
    }),
    ...design.amenities.map((amenity) => {
      const { w, d } = amenityFootprint(amenity);
      return {
        id: amenity.id,
        label: amenity.label ?? amenityKind(amenity.kind)?.label ?? amenity.kind,
        x: amenity.x, z: amenity.z, w, d, rotationDeg: amenity.rotY, minY: 0, maxY: amenity.h,
      };
    }),
  ];
  const findings: ReviewFinding[] = [];
  for (const [a, b] of footprintPairs(objects)) {
      if (!horizontalOverlap(a, b) || !verticalOverlap(a, b)) continue;
      findings.push(finding(`clash-${a.id}-${b.id}`, `${a.label} overlaps ${b.label} in the rotated footprint`, "blocker", "clash", 95, (a.x + b.x) / 2, (a.z + b.z) / 2, [a.id, b.id]));
  }
  const draftedColumns: PointStructure[] = (design.drafts ?? []).filter((draft) => draft.kind === "column").map((draft) => ({ id: draft.id, label: draft.label ?? "drafted column", x: draft.x, z: draft.z, w: draft.w, d: draft.d, minY: draft.elevationM ?? 0, maxY: (draft.elevationM ?? 0) + (draft.h ?? 3) }));
  const gridX = (design.structuralGrid ?? []).filter((line) => line.axis === "x");
  const gridZ = (design.structuralGrid ?? []).filter((line) => line.axis === "z");
  const gridColumns: PointStructure[] = gridX.flatMap((xLine) => gridZ.map((zLine) => ({ id: `grid-column-${xLine.id}-${zLine.id}`, label: `structural grid ${xLine.label}/${zLine.label}`, x: xLine.position, z: zLine.position, w: design.structural?.columnWidthM ?? 0.4, d: design.structural?.columnDepthM ?? 0.4, minY: 0, maxY: 3 })));
  const columns = [...draftedColumns, ...gridColumns];
  return [...findings, ...mepFindings(design.mep, objects, columns, "community")];
}

export function infraReviewFindings(design: InfraReviewInput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const width = design.location?.boundaryWidthM ?? 0;
  const depth = design.location?.boundaryDepthM ?? 0;
  for (const facility of design.facilities ?? []) {
      if (width > 0 && facility.lengthM > width && facility.widthM > depth) {
      findings.push(finding(`site-fit-${facility.id}`, `${facility.kind} footprint exceeds the traced site in both dimensions`, "warning", "site-fit", 64, 0, 0, [facility.id]));
    }
  }
  const structures: Footprint[] = (design.facilities ?? []).map((facility) => ({ id: facility.id, label: facility.kind, x: 0, z: 0, w: facility.lengthM, d: facility.widthM, rotationDeg: 0, minY: 0, maxY: facility.heightM }));
  const pointStructures: PointStructure[] = (design.drafts ?? []).filter((draft) => draft.kind === "column").map((draft) => ({ id: draft.id, label: draft.label ?? "drafted column", x: draft.x, z: draft.z, w: draft.w, d: draft.d, minY: draft.elevationM ?? 0, maxY: (draft.elevationM ?? 0) + (draft.h ?? 3) }));
  return [...findings, ...mepFindings(design.mep, structures, pointStructures, "infra")];
}

export function reviewMarkers(review: { markers: ReviewMarker[] } | undefined): ReviewMarker[] {
  return review?.markers ?? [];
}

export function reviewRiskScore(findings: ReviewFinding[]): number {
  return findings.length ? Math.max(...findings.map((item) => item.score)) : 0;
}

