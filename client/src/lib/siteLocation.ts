import type { CommunityDesign, InfraDesign, SiteLocation } from "../types";
import { boundaryMetrics, localToLatLng, type BoundaryMetrics, type LatLng } from "./geo";

export interface SiteReferenceInput {
  latitude: string;
  longitude: string;
  width: string;
  depth: string;
  rotation: string;
  unit: "m" | "ft";
  shape: "rectangle" | "polygon" | "corridor";
  polygon: string;
  mode: "area" | "route";
}

export interface SiteMeasureFields { width: string; depth: string; unit: "m" | "ft" }
const dimensionText = (value: number) => String(Number(value.toPrecision(10)));

/** Unit switches preserve the same physical measurements, including an unfinished invalid field. */
export function siteMeasuresInUnit(fields: SiteMeasureFields, unit: SiteMeasureFields["unit"]): SiteMeasureFields {
  if (fields.unit === unit) return fields;
  const factor = (fields.unit === "ft" ? 0.3048 : 1) / (unit === "ft" ? 0.3048 : 1);
  const convert = (value: string) => value.trim() && Number.isFinite(Number(value)) ? dimensionText(Number(value) * factor) : value;
  return { width: convert(fields.width), depth: convert(fields.depth), unit };
}

export function siteReferenceFields(location?: SiteLocation, unit: SiteMeasureFields["unit"] = "m"): Omit<SiteReferenceInput, "mode"> {
  const factor = unit === "ft" ? 0.3048 : 1;
  return {
    latitude: location ? String(location.lat) : "12.9716",
    longitude: location ? String(location.lng) : "77.5946",
    width: dimensionText((location?.boundaryWidthM ?? 80) / factor),
    depth: dimensionText((location?.boundaryDepthM ?? 60) / factor), unit,
    rotation: String(location?.boundaryRotationDeg ?? 0),
    shape: location?.boundaryShape ?? (location?.boundary && location.boundary.length >= 3 ? "polygon" : "rectangle"),
    polygon: location?.boundary?.map((point) => `${point.lat}, ${point.lng}`).join("\n") ?? "",
  };
}

/** Stable value key ignores unrelated metadata and object identity so rerenders preserve drafts. */
export function siteLocationValue(location?: SiteLocation): string {
  return JSON.stringify(location ? {
    lat: location.lat, lng: location.lng, boundaryWidthM: location.boundaryWidthM,
    boundaryDepthM: location.boundaryDepthM, boundaryRotationDeg: location.boundaryRotationDeg,
    boundaryShape: location.boundaryShape, boundary: location.boundary?.map(({ lat, lng }) => ({ lat, lng })),
  } : null);
}

const normalizeAxis = (angle: number) => ((angle % 180) + 180) % 180;
const validCoordinate = ({ lat, lng }: LatLng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
function numberInput(value: string, label: string): number {
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result)) throw new Error(`Enter a finite ${label}.`);
  return result;
}

/** Builds one validated local site reference without mutating project state. */
export function createSiteReference(input: SiteReferenceInput): { location: SiteLocation; metrics: BoundaryMetrics } {
  let boundary: LatLng[], metrics: BoundaryMetrics;
  if (input.shape === "polygon") {
    const lines = input.polygon.trim().split(/\r?\n/);
    if (lines.length < 3 || lines.length > 256) throw new Error("Enter between 3 and 256 boundary corners, one latitude/longitude pair per line.");
    boundary = lines.map((line, index) => {
      const parts = line.trim().split(/[,\s]+/);
      if (parts.length !== 2) throw new Error(`Boundary corner ${index + 1} needs latitude and longitude.`);
      const point = { lat: numberInput(parts[0], "latitude"), lng: numberInput(parts[1], "longitude") };
      if (!validCoordinate(point)) throw new Error(`Boundary corner ${index + 1} is outside valid latitude/longitude ranges.`);
      return point;
    });
    const last = boundary[boundary.length - 1];
    if (boundary.length > 3 && boundary[0].lat === last.lat && boundary[0].lng === last.lng) boundary.pop();
    // Keep minimum-extent validation independent of the normal 0.1 m display rounding.
    const calculated = boundaryMetrics(boundary, 6);
    if (!calculated || calculated.widthM <= 0 || calculated.depthM <= 0 || calculated.areaM2 <= 0) throw new Error("Boundary corners must enclose a measurable area.");
    metrics = calculated;
  } else {
    const center = { lat: numberInput(input.latitude, "latitude"), lng: numberInput(input.longitude, "longitude") };
    if (!validCoordinate(center)) throw new Error("Latitude must be between −90 and 90; longitude between −180 and 180.");
    if (Math.abs(center.lat) === 90) throw new Error("A local rectangular canvas cannot be created at a pole. Choose a nearby coordinate or enter boundary corners.");
    const metresPerUnit = input.unit === "ft" ? 0.3048 : 1;
    const widthM = numberInput(input.width, "width") * metresPerUnit, depthM = numberInput(input.depth, "depth") * metresPerUnit;
    if (widthM <= 0 || depthM <= 0) throw new Error("Width and depth must be greater than zero.");
    const rotationDeg = normalizeAxis(numberInput(input.rotation, "rotation"));
    const angle = rotationDeg * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    boundary = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = sx * widthM / 2, y = sy * depthM / 2;
      return localToLatLng(x * cos - y * sin, x * sin + y * cos, center);
    });
    if (!boundary.every(validCoordinate)) throw new Error("This canvas crosses the supported coordinate range. Use a smaller local extent or boundary corners.");
    metrics = { center, widthM, depthM, rotationDeg, areaM2: widthM * depthM };
  }
  const { center, widthM, depthM, rotationDeg } = metrics;
  // Decimal input-unit conversion can put exactly 1 m a few picometres below
  // the limit. This tolerance is smaller than the supported geometry precision.
  if (widthM < 1 - 1e-8 || depthM < 1 - 1e-8) throw new Error("The modeled site canvas needs width and depth of at least 1 m (about 3.281 ft). Smaller extents would be enlarged by the canvas minimum.");
  const location: SiteLocation = {
    ...center, zoom: 18, boundary, boundaryShape: input.shape, boundaryWidthM: widthM, boundaryDepthM: depthM, boundaryRotationDeg: rotationDeg,
    ...(input.mode === "route" ? {
      routeLengthM: Math.max(widthM, depthM),
      routeBearingDeg: normalizeAxis(90 - rotationDeg - (depthM >= widthM ? 90 : 0)),
    } : {}),
  };
  return { location, metrics };
}

/** One replacement value keeps the measured extent and its new coordinate reference together. */
export function communityAtSite(design: CommunityDesign, location: SiteLocation | undefined, metrics?: BoundaryMetrics): CommunityDesign {
  if (!metrics) return { ...design, location };
  const metresPerUnit = design.land.unit === "m" ? 1 : design.land.unit === "yd" ? 0.9144 : 0.3048;
  const inUnits = (metres: number) => Math.max(Math.round(metres / metresPerUnit * 10) / 10, 1);
  return { ...design, location, land: { ...design.land, width: inUnits(metrics.widthM), depth: inUnits(metrics.depthM) } };
}

/** Fit from the location passed by the current action, never a prior render's location. */
export function infraAtSite(design: InfraDesign, location: SiteLocation): InfraDesign {
  const next = { ...design, location };
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const width = location.boundaryWidthM ?? 0, depth = location.boundaryDepthM ?? 0;
  const span = Math.max(width, depth), area = width * depth, route = location.routeLengthM ?? 0;
  if (design.kind === "airport" && design.airport && span > 200) {
    next.airport = {
      ...design.airport,
      runwayLengthM: clamp(Math.round(span / 50) * 50, 1200, 4500),
      runwayHeadingDeg: Math.round(normalizeAxis(location.routeBearingDeg ?? (90 - (location.boundaryRotationDeg ?? 0) - (depth >= width ? 90 : 0)))),
    };
  } else if (design.kind === "ports" && design.ports && area > 5000) {
    next.ports = {
      ...design.ports,
      containerYardM2: clamp(Math.round(area * 0.45), 20000, 800000),
      berths: clamp(Math.round(width / (design.ports.berthLengthM || 250)), 1, 12),
    };
  } else if (design.kind === "dams" && design.dams && route > 40) {
    next.dams = { ...design.dams, crestLengthM: clamp(Math.round(route), 60, 2000) };
  }
  return next;
}
