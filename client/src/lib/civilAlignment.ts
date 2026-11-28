import { surveySurfaceElevation, type SurveySurface } from "./surveyExchange";

export interface HorizontalSegment { kind: "line" | "arc" | "spiral"; lengthM: number; radiusM?: number; curvatureStart?: number; curvatureEnd?: number }
export interface VerticalCurve { stationM: number; lengthM: number; startGradePct: number; endGradePct: number }
export interface SuperelevationPoint { stationM: number; slopePct: number }
export interface AdvancedAlignment {
  name: string; origin: { x: number; z: number }; headingDeg: number; startElevationM: number; startGradePct: number;
  horizontal: HorizontalSegment[]; vertical: VerticalCurve[]; superelevation: SuperelevationPoint[];
  widthM: number; crownPct: number; sideSlopeRatio: number; stationIntervalM: number; crossSectionIntervalM: number; maxDaylightM: number;
}
export interface AlignmentPosition { stationM: number; x: number; z: number; headingRad: number; curvature: number; elevationM: number; gradePct: number; superelevationPct?: number }
export interface CorridorSection { stationM: number; points: { offsetM: number; x: number; z: number; groundM: number; designM: number }[]; cutAreaM2: number; fillAreaM2: number; complete: boolean }
export interface AdvancedCivilReport { stations: AlignmentPosition[]; sections: CorridorSection[]; lengthM: number; cutM3: number; fillM3: number; quantifiedLengthM: number; warnings: string[] }
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const bounded = (n: unknown, lo: number, hi: number) => finite(n) && n >= lo && n <= hi;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseAdvancedAlignment(text: string): AdvancedAlignment {
  if (text.length > 100000) throw new Error("Alignment JSON limit is 100 KB."); const value: unknown = JSON.parse(text);
  if (!record(value) || typeof value.name !== "string" || !record(value.origin) || !bounded(value.origin.x, -1e8, 1e8) || !bounded(value.origin.z, -1e8, 1e8) || !bounded(value.headingDeg, -360, 360) || !bounded(value.startElevationM, -10000, 10000) || !bounded(value.startGradePct, -30, 30)) throw new Error("Alignment needs finite metre coordinates, heading and starting elevation/grade.");
  if (!Array.isArray(value.horizontal) || !value.horizontal.length || value.horizontal.length > 100 || !Array.isArray(value.vertical) || value.vertical.length > 100 || !Array.isArray(value.superelevation) || value.superelevation.length > 100) throw new Error("Horizontal segments, vertical curves and superelevation must be bounded arrays.");
  for (const item of value.horizontal) { if (!record(item) || typeof item.kind !== "string" || !["line", "arc", "spiral"].includes(item.kind) || !bounded(item.lengthM, .01, 100000)) throw new Error("Invalid horizontal segment."); if (item.kind === "arc" && (!finite(item.radiusM) || Math.abs(item.radiusM) < 1 || Math.abs(item.radiusM) > 1e7)) throw new Error("Signed arc radius must have magnitude 1–10,000,000 m."); if (item.kind === "spiral" && (!bounded(item.curvatureStart, -1, 1) || !bounded(item.curvatureEnd, -1, 1))) throw new Error("Spiral needs start/end curvature within ±1/m."); }
  const alignment = value as unknown as AdvancedAlignment, length = alignment.horizontal.reduce((s, h) => s + h.lengthM, 0); if (length > 1000000) throw new Error("Alignment length limit is 1000 km.");
  let priorEnd = 0, grade = alignment.startGradePct;
  for (const curve of alignment.vertical) { if (!record(curve) || !bounded(curve.stationM, priorEnd, length) || !bounded(curve.lengthM, .01, length - curve.stationM) || !bounded(curve.startGradePct, -30, 30) || !bounded(curve.endGradePct, -30, 30) || Math.abs(curve.startGradePct - grade) > 1e-6) throw new Error("Parabolic vertical curves must be ordered, non-overlapping, within alignment length, and continuous with the preceding grade."); priorEnd = curve.stationM + curve.lengthM; grade = curve.endGradePct; }
  let priorStation = -1; for (const point of alignment.superelevation) { if (!record(point) || !bounded(point.stationM, 0, length) || !bounded(point.slopePct, -20, 20) || point.stationM <= priorStation) throw new Error("Superelevation station/slope must be ordered and within ±20%."); priorStation = point.stationM; }
  for (const [key, lo, hi] of [["widthM", 1, 100], ["crownPct", 0, 20], ["sideSlopeRatio", .25, 10], ["stationIntervalM", 1, 10000], ["crossSectionIntervalM", .25, 10], ["maxDaylightM", 1, 200]] as const) if (!bounded(alignment[key], lo, hi)) throw new Error(`${key} must be ${lo}–${hi}.`);
  return alignment;
}

interface SegmentStart { stationM: number; x: number; z: number; headingRad: number; segment: HorizontalSegment }
function horizontalOffset(segment: HorizontalSegment, heading: number, distance: number): { x: number; z: number; headingRad: number; curvature: number } {
  if (segment.kind === "line") return { x: Math.cos(heading) * distance, z: Math.sin(heading) * distance, headingRad: heading, curvature: 0 };
  if (segment.kind === "arc") { const k = 1 / segment.radiusM!, end = heading + k * distance; return { x: (Math.sin(end) - Math.sin(heading)) / k, z: (Math.cos(heading) - Math.cos(end)) / k, headingRad: end, curvature: k }; }
  const start = segment.curvatureStart!, rate = (segment.curvatureEnd! - start) / segment.lengthM, theta = (s: number) => heading + start * s + rate * s * s / 2;
  // Composite Simpson integration of the clothoid Fresnel integral, angular step <= .02 rad.
  const maxK = Math.max(Math.abs(start), Math.abs(start + rate * distance)), steps = Math.max(8, Math.ceil(distance * maxK / .02 / 2) * 2);
  if (steps > 10000) throw new Error("Spiral angular integration budget exceeded; split the segment.");
  const h = distance / steps; let x = 0, z = 0; for (let i = 0; i <= steps; i++) { const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2; x += weight * Math.cos(theta(i * h)); z += weight * Math.sin(theta(i * h)); }
  return { x: x * h / 3, z: z * h / 3, headingRad: theta(distance), curvature: start + rate * distance };
}
function starts(alignment: AdvancedAlignment): SegmentStart[] { const result: SegmentStart[] = []; let x = alignment.origin.x, z = alignment.origin.z, headingRad = alignment.headingDeg * Math.PI / 180, stationM = 0; for (const segment of alignment.horizontal) { result.push({ x, z, headingRad, stationM, segment }); const delta = horizontalOffset(segment, headingRad, segment.lengthM); x += delta.x; z += delta.z; headingRad = delta.headingRad; stationM += segment.lengthM; } return result; }
export function advancedProfileElevation(alignment: AdvancedAlignment, stationM: number): { elevationM: number; gradePct: number } {
  let station = 0, elevation = alignment.startElevationM, grade = alignment.startGradePct / 100;
  for (const curve of alignment.vertical) { if (stationM <= curve.stationM) return { elevationM: elevation + (stationM - station) * grade, gradePct: grade * 100 }; elevation += (curve.stationM - station) * grade; const x = Math.min(stationM - curve.stationM, curve.lengthM), change = (curve.endGradePct - curve.startGradePct) / 100;
    const curveElevation = elevation + grade * x + change * x * x / (2 * curve.lengthM); if (stationM <= curve.stationM + curve.lengthM) return { elevationM: curveElevation, gradePct: (grade + change * x / curve.lengthM) * 100 }; elevation = curveElevation; grade = curve.endGradePct / 100; station = curve.stationM + curve.lengthM; }
  return { elevationM: elevation + (stationM - station) * grade, gradePct: grade * 100 };
}
function superSlope(alignment: AdvancedAlignment, station: number): number | undefined { const points = alignment.superelevation; if (!points.length) return undefined; if (station <= points[0].stationM) return points[0].slopePct; for (let i = 1; i < points.length; i++) if (station <= points[i].stationM) { const a = points[i - 1], b = points[i]; return a.slopePct + (b.slopePct - a.slopePct) * (station - a.stationM) / (b.stationM - a.stationM); } return points[points.length - 1].slopePct; }

/** Metre-based alignment and sampled daylight sections. Missing terrain at samples excludes adjoining volume intervals; between-sample gaps may remain undetected. */
export function analyzeAdvancedCivil(alignment: AdvancedAlignment, terrain?: SurveySurface): AdvancedCivilReport {
  const segments = starts(alignment), last = segments[segments.length - 1], lengthM = last.stationM + last.segment.lengthM, stationsSet = new Set<number>([0, lengthM]);
  for (let station = alignment.stationIntervalM; station < lengthM; station += alignment.stationIntervalM) { if (stationsSet.size > 500) throw new Error("Civil analysis supports at most 500 stations; increase stationIntervalM."); stationsSet.add(station); }
  for (const s of segments) stationsSet.add(s.stationM); for (const c of alignment.vertical) { stationsSet.add(c.stationM); stationsSet.add(c.stationM + c.lengthM); } for (const p of alignment.superelevation) stationsSet.add(p.stationM);
  if (stationsSet.size > 500) throw new Error("Civil station count exceeds 500.");
  const stations = [...stationsSet].sort((a, b) => a - b).map(stationM => { let index = segments.length - 1; while (index > 0 && segments[index].stationM > stationM) index--; const s = segments[index], delta = horizontalOffset(s.segment, s.headingRad, stationM - s.stationM); return { stationM, x: s.x + delta.x, z: s.z + delta.z, headingRad: delta.headingRad, curvature: delta.curvature, ...advancedProfileElevation(alignment, stationM), superelevationPct: superSlope(alignment, stationM) }; });
  const warnings = ["Plan tangents are continuous; curvature discontinuities between authored segments are retained.", "Daylight cross sections and average-end-area volumes are sampled approximations; no bulking, pavement layers, geotechnics or drainage network design."];
  const sections: CorridorSection[] = []; let queries = 0;
  if (terrain) for (const station of stations) {
    const normal = { x: -Math.sin(station.headingRad), z: Math.cos(station.headingRad) }, half = alignment.widthM / 2, top = (offset: number) => station.elevationM + (station.superelevationPct === undefined ? -Math.abs(offset) * alignment.crownPct / 100 : offset * station.superelevationPct / 100);
    const ground = (offset: number) => { if (++queries > 50000) throw new Error("Civil terrain query budget exceeded; increase intervals/reduce sections."); return surveySurfaceElevation(terrain, station.x + normal.x * offset, station.z + normal.z * offset); };
    let complete = true;
    const daylight = (side: number): { reach: number; sign: number } => { const edge = side * half, g = ground(edge); if (g === undefined) { complete = false; return { reach: half, sign: 0 }; } const sign = top(edge) >= g ? -1 : 1, difference = (distance: number): number | undefined => { const terrainElevation = ground(side * distance); return terrainElevation === undefined ? undefined : top(edge) + sign * (distance - half) / alignment.sideSlopeRatio - terrainElevation; }; let prior = half, previous = top(edge) - g;
      if (Math.abs(previous) < 1e-8) return { reach: half, sign };
      const limit = half + alignment.maxDaylightM, step = alignment.crossSectionIntervalM;
      while (prior < limit) {
        const distance = Math.min(prior + step, limit);
        const current = difference(distance);
        if (current === undefined) { complete = false; return { reach: prior, sign }; }
        if (Math.abs(current) < 1e-8) return { reach: distance, sign };
        if (previous * current < 0) {
          let a = prior, b = distance;
          for (let i = 0; i < 24; i++) {
            const mid = (a + b) / 2, v = difference(mid);
            if (v === undefined) { complete = false; break; }
            if (previous * v <= 0) b = mid; else a = mid;
          }
          return { reach: (a + b) / 2, sign };
        }
        prior = distance; previous = current;
      }
      complete = false; return { reach: limit, sign };
    };
    const left = daylight(-1), right = daylight(1), offsets = new Set<number>([-left.reach, -half, 0, half, right.reach]); for (let o = -left.reach; o <= right.reach; o += alignment.crossSectionIntervalM) offsets.add(o);
    const section: CorridorSection = { stationM: station.stationM, points: [], cutAreaM2: 0, fillAreaM2: 0, complete };
    for (const offsetM of [...offsets].sort((a, b) => a - b)) { const groundM = ground(offsetM); if (groundM === undefined) { section.complete = false; continue; } const side = offsetM < 0 ? left : right, edge = offsetM < 0 ? -half : half, designM = Math.abs(offsetM) <= half ? top(offsetM) : top(edge) + side.sign * (Math.abs(offsetM) - half) / alignment.sideSlopeRatio; section.points.push({ offsetM, x: station.x + normal.x * offsetM, z: station.z + normal.z * offsetM, groundM, designM }); }
    for (let i = 1; i < section.points.length; i++) { const a = section.points[i - 1], b = section.points[i], da = a.designM - a.groundM, db = b.designM - b.groundM, width = b.offsetM - a.offsetM; if (da * db >= 0) { const area = width * (Math.abs(da) + Math.abs(db)) / 2; if (da + db >= 0) section.fillAreaM2 += area; else section.cutAreaM2 += area; } else { const split = width * Math.abs(da) / (Math.abs(da) + Math.abs(db)), first = split * Math.abs(da) / 2, second = (width - split) * Math.abs(db) / 2; section.fillAreaM2 += da > 0 ? first : second; section.cutAreaM2 += da < 0 ? first : second; } }
    sections.push(section);
  }
  let cutM3 = 0, fillM3 = 0, quantifiedLengthM = 0; for (let i = 1; i < sections.length; i++) { const a = sections[i - 1], b = sections[i]; if (!a.complete || !b.complete) continue; const length = b.stationM - a.stationM; cutM3 += length * (a.cutAreaM2 + b.cutAreaM2) / 2; fillM3 += length * (a.fillAreaM2 + b.fillAreaM2) / 2; quantifiedLengthM += length; }
  if (!terrain) warnings.push("No terrain supplied; alignment/profile exported without earthwork quantities.");
  else warnings.push("Terrain coverage is checked at sampled offsets/stations. Narrow holes or survey gaps between samples can remain undetected and their intervals can contribute approximate area/volume; refine intervals and independently verify coverage before relying on quantities.");
  if (sections.some(s => !s.complete)) warnings.push("Some sampled daylight sections encounter missing terrain or exceed maximum daylight distance; adjoining volume intervals are excluded.");
  return { stations, sections, lengthM, cutM3, fillM3, quantifiedLengthM, warnings };
}

export function advancedCivilCsv(report: AdvancedCivilReport): string { const header = "station_m,easting_m,northing_m,elevation_m,grade_pct,heading_rad,curvature_1_per_m,superelevation_pct,cut_area_m2,fill_area_m2,section_complete"; return [header, ...report.stations.map((s, i) => [s.stationM, s.x, s.z, s.elevationM, s.gradePct, s.headingRad, s.curvature, s.superelevationPct ?? "", report.sections[i]?.cutAreaM2 ?? "", report.sections[i]?.fillAreaM2 ?? "", report.sections[i]?.complete ?? ""].join(","))].join("\n"); }

export const exampleAdvancedAlignment: AdvancedAlignment = {
  name: "Alignment study", origin: { x: 0, z: 0 }, headingDeg: 0, startElevationM: 10, startGradePct: 1,
  horizontal: [{ kind: "line", lengthM: 100 }, { kind: "spiral", lengthM: 50, curvatureStart: 0, curvatureEnd: .005 }, { kind: "arc", lengthM: 100, radiusM: 200 }, { kind: "spiral", lengthM: 50, curvatureStart: .005, curvatureEnd: 0 }],
  vertical: [{ stationM: 100, lengthM: 100, startGradePct: 1, endGradePct: -1 }], superelevation: [{ stationM: 0, slopePct: 0 }, { stationM: 150, slopePct: 5 }, { stationM: 300, slopePct: 0 }], widthM: 12, crownPct: 2, sideSlopeRatio: 2, stationIntervalM: 25, crossSectionIntervalM: 2, maxDaylightM: 50,
};
