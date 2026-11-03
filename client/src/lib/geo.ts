/**
 * Geodesy helpers.
 *
 * Pure, dependency-free math used by the site locator: distances between
 * WGS84 points, a local metric projection and a minimum-area bounding
 * rectangle for a plot boundary. Kept free of the Google Maps SDK so it can
 * be unit-tested and reused offline.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const rounded = (n: number, d = 2) => Math.round((Number.isFinite(n) ? n : 0) * 10 ** d) / 10 ** d;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function centroid(points: LatLng[]): LatLng {
  const n = points.length || 1;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lng: points.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Metres east/north of an origin, good enough over a single plot. */
export function toLocalMetres(p: LatLng, origin: LatLng): { x: number; y: number } {
  const x = rad(p.lng - origin.lng) * EARTH_R * Math.cos(rad((p.lat + origin.lat) / 2));
  const y = rad(p.lat - origin.lat) * EARTH_R;
  return { x, y };
}

export function localToLatLng(x: number, y: number, origin: LatLng): LatLng {
  const lat = origin.lat + (y / EARTH_R) * (180 / Math.PI);
  const lng = origin.lng + (x / (EARTH_R * Math.cos(rad((lat + origin.lat) / 2)))) * (180 / Math.PI);
  return { lat, lng };
}

/** Shoelace area of a plot boundary, m². */
export function polygonAreaM2(points: LatLng[]): number {
  if (points.length < 3) return 0;
  const c = centroid(points);
  const local = points.map((p) => toLocalMetres(p, c));
  let sum = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function convexHull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length <= 3) return pts;
  const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface BoundaryMetrics {
  center: LatLng;
  /** Best-fit width (short side), metres. */
  widthM: number;
  /** Best-fit depth (long side), metres. */
  depthM: number;
  /** Width axis rotation from east, degrees in [0, 180). */
  rotationDeg: number;
  areaM2: number;
}

/**
 * Minimum-area bounding rectangle of a plot boundary (rotating calipers over
 * the convex hull), so dimensions match the surveyor's "frontage × depth"
 * even when the plot is not north-aligned.
 */
export function boundaryMetrics(points: LatLng[], dimensionDigits = 1): BoundaryMetrics | null {
  if (points.length < 3) return null;
  const c = centroid(points);
  const local = points.map((p) => toLocalMetres(p, c));
  const hull = convexHull(local);
  if (hull.length < 3) return null;

  let best = { area: Infinity, w: 0, d: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      const x = p.x * cos - p.y * sin;
      const y = p.x * sin + p.y * cos;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const w = maxX - minX;
    const d = maxY - minY;
    const area = w * d;
    if (area < best.area) best = { area, w, d, angle: ang };
  }

  const widthM = Math.min(best.w, best.d);
  const depthM = Math.max(best.w, best.d);
  const rotationDeg = ((best.angle * 180) / Math.PI + (best.w > best.d ? 90 : 0) + 180) % 180;

  return {
    center: c,
    widthM: rounded(widthM, dimensionDigits),
    depthM: rounded(depthM, dimensionDigits),
    rotationDeg: rounded(rotationDeg, 1) % 180,
    areaM2: rounded(polygonAreaM2(points), 0),
  };
}

/** Deep link to open the location in Google Earth (no key required). */
export function googleEarthUrl(lat: number, lng: number): string {
  return `https://earth.google.com/web/@${lat.toFixed(6)},${lng.toFixed(6)},0a,600d,35y,0h,0t,0r`;
}

/** Initial bearing from a to b, degrees from north in [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Total length of a polyline, metres. */
export function polylineLengthM(points: LatLng[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversine(points[i - 1], points[i]);
  return sum;
}
