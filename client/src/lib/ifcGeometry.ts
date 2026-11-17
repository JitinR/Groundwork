/** Bounded IFC STEP exchange. Geometry is a declared subset; original STEP is retained for lossless export. */
export type StepValue = null | number | string | StepValue[] | { ref: number } | { enumeration: string } | { type: string; values: StepValue[] };
export interface StepEntity { id: number; type: string; args: StepValue[]; start: number; end: number }
export interface IfcMesh { vertices: number[]; triangles: number[] }
/** Unit records retain authoring provenance; property values are not converted to SI here. */
export interface IfcPropertyUnit { stepId: number; entityType: string; unitType: string; name: string; prefix: string; source: "explicit" | "project"; conversionFactor?: number; baseUnitStepId?: number }
export interface IfcPropertyValue { propertySet: string; name: string; dataType: string; value: string | number | boolean | null; lexicalValue: string; unit: IfcPropertyUnit | null; propertyStepId: number; propertySetStepId: number; origin: "occurrence" | "type"; typeStepId?: number; supported: boolean; issues: string[] }
export interface IfcProduct { stepId: number; globalId: string; type: string; name: string; attributes: Record<string, string>; attributePresence?: Record<string, boolean>; properties: Record<string, string>; propertyTypes?: Record<string, string>; propertyValues?: Record<string, IfcPropertyValue>; metadataIssues?: string[]; declaredType?: { stepId: number; entityType: string; predefinedType: string; elementType: string }; predefinedTypeSupported?: boolean; meshes: IfcMesh[]; issues: string[] }
export interface IfcDocument { schema: string; source: string; products: IfcProduct[]; issues: string[]; entities: Map<number, StepEntity>; unitScale: number }
type V = [number, number, number];
type Matrix = [V, V, V, V];
const identity = (): Matrix => [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): V => { const n = Math.hypot(...a); if (!Number.isFinite(n) || n < 1e-12) throw new Error("Degenerate/non-finite placement direction."); return mul(a, 1 / n); };
const vector = (m: Matrix, p: V): V => add(add(mul(m[0], p[0]), mul(m[1], p[1])), mul(m[2], p[2]));
const point = (m: Matrix, p: V): V => add(m[3], vector(m, p));
const compose = (a: Matrix, b: Matrix): Matrix => [vector(a, b[0]), vector(a, b[1]), vector(a, b[2]), point(a, b[3])];
export const IFC_SUPPORTED_SCHEMAS = ["IFC2X3", "IFC4", "IFC4_ADD1", "IFC4_ADD2", "IFC4_ADD2_TC1", "IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2"] as const;
/** Exact occurrence classes with the common product metadata layout understood by the IDS subset. */
export const IFC_METADATA_PRODUCT_CLASSES = "IFCWALL IFCWALLSTANDARDCASE IFCSLAB IFCROOF IFCCOLUMN IFCBEAM IFCMEMBER IFCPLATE IFCCOVERING IFCDOOR IFCWINDOW IFCSTAIR IFCSTAIRFLIGHT IFCRAMP IFCRAMPFLIGHT IFCBUILDINGELEMENTPROXY IFCBUILDINGELEMENTPART IFCFURNISHINGELEMENT IFCFURNITURE IFCSPACE IFCSITE IFCBUILDING IFCBUILDINGSTOREY IFCOPENINGELEMENT IFCFOOTING IFCPILE IFCFLOWSEGMENT IFCFLOWFITTING IFCFLOWTERMINAL IFCFLOWCONTROLLER IFCFLOWMOVINGDEVICE IFCFLOWSTORAGEDEVICE IFCENERGYCONVERSIONDEVICE IFCDUCTSEGMENT IFCPIPESEGMENT IFCCABLESEGMENT IFCDUCTFITTING IFCPIPEFITTING IFCVALVE IFCPUMP IFCSANITARYTERMINAL IFCAIRTERMINAL IFCLIGHTFIXTURE".split(" ");
const list = (v: StepValue | undefined): StepValue[] => Array.isArray(v) ? v : [];
const scalar = (v: StepValue | undefined): string => v === null || v === undefined ? "" : typeof v === "object" ? "type" in v ? scalar(v.values[0]) : "enumeration" in v ? v.enumeration : "" : String(v);
const enumeration = (v: StepValue | undefined): string | undefined => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) && "enumeration" in v ? v.enumeration : undefined;
const numeric = (v: StepValue | undefined): number => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Expected finite STEP number."); return v; };
function decodeString(value: string): string {
  let out = "", i = 0;
  while (i < value.length) {
    if (value.startsWith("\\\\", i)) { out += "\\"; i += 2; continue; }
    const kind = value.startsWith("\\X2\\", i) ? 4 : value.startsWith("\\X4\\", i) ? 8 : 0;
    if (kind) { const end = value.indexOf("\\X0\\", i + 4), hex = value.slice(i + 4, end); if (end < 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length % kind) throw new Error("Malformed STEP Unicode escape."); for (let k = 0; k < hex.length; k += kind) { const code = parseInt(hex.slice(k, k + kind), 16); if (kind === 8 && code > 0x10ffff) throw new Error("Invalid STEP Unicode code point."); out += kind === 4 ? String.fromCharCode(code) : String.fromCodePoint(code); } i = end + 4; continue; }
    out += value[i++];
  }
  return out;
}

function parseArguments(text: string, budget: { values: number }): StepValue[] {
  let i = 0;
  const skip = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  const value = (depth: number): StepValue => {
    if (depth > 32 || ++budget.values > 1000000) throw new Error("STEP global nesting/value limit exceeded."); skip();
    const c = text[i++];
    if (c === "$" || c === "*") return null;
    if (c === "'") { let s = ""; while (i < text.length) { const ch = text[i++]; if (ch === "'") { if (text[i] === "'") { s += "'"; i++; } else return decodeString(s); } else s += ch; } throw new Error("Unterminated STEP string."); }
    if (c === "(") { const a: StepValue[] = []; skip(); if (text[i] === ")") { i++; return a; } while (i < text.length) { a.push(value(depth + 1)); skip(); if (text[i++] === ")") return a; if (text[i - 1] !== ",") throw new Error("Malformed STEP aggregate."); } throw new Error("Unclosed STEP aggregate."); }
    if (c === "#") { const match = /^\d+/.exec(text.slice(i)); if (!match) throw new Error("Malformed STEP reference."); i += match[0].length; const ref = Number(match[0]); if (!Number.isSafeInteger(ref) || ref <= 0) throw new Error("STEP references require positive safe integer identifiers."); return { ref }; }
    if (c === "." && /^[A-Z]/i.test(text[i] ?? "")) { const end = text.indexOf(".", i); if (end < 0 || !/^[A-Z][A-Z0-9_]*$/i.test(text.slice(i, end))) throw new Error("Malformed STEP enumeration."); const s = `.${text.slice(i, end).toUpperCase()}.`; i = end + 1; return { enumeration: s }; }
    i--; const n = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/.exec(text.slice(i)); if (n) { i += n[0].length; const f = Number(n[0]); if (!Number.isFinite(f)) throw new Error("Nonfinite STEP number."); return f; }
    const t = /^[A-Z][A-Z0-9_]*/i.exec(text.slice(i)); if (t) { i += t[0].length; skip(); if (text[i] !== "(") throw new Error("Malformed typed STEP value."); return { type: t[0].toUpperCase(), values: list(value(depth + 1)) }; }
    throw new Error(`Unsupported STEP token at ${i}.`);
  };
  const result = list(value(0)); skip(); if (i !== text.length) throw new Error("Trailing STEP argument data."); return result;
}

function scan(source: string): Map<number, StepEntity> {
  const entities = new Map<number, StepEntity>(), budget = { values: 0 }; let i = 0;
  // A statement scanner preserves semicolons/hash characters inside quoted strings and comments.
  while (i < source.length) {
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) throw new Error("Unclosed STEP comment."); i = end + 2; continue; }
    if (source[i] === "'") { i++; while (i < source.length) { if (source[i++] === "'") { if (source[i] === "'") i++; else break; } } continue; }
    if (source[i] !== "#") { i++; continue; }
    const start = i, head = /^#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*/i.exec(source.slice(i)); if (!head) throw new Error("Unsupported complex/malformed STEP entity."); i += head[0].length;
    const argStart = i; let quoted = false, clean = "";
    while (i < source.length) {
      const c = source[i];
      if (!quoted && source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) throw new Error("Unclosed STEP comment."); clean += " "; i = end + 2; continue; }
      if (c === "'") { if (quoted && source[i + 1] === "'") { clean += "''"; i += 2; continue; } quoted = !quoted; }
      if (c === ";" && !quoted) break;
      clean += c; i++;
    }
    if (i === source.length || i === argStart) throw new Error("Unclosed STEP statement.");
    const id = Number(head[1]); if (!Number.isSafeInteger(id) || id <= 0 || entities.has(id)) throw new Error("Invalid/duplicate STEP identifier.");
    entities.set(id, { id, type: head[2].toUpperCase(), args: parseArguments(clean, budget), start, end: ++i });
    if (entities.size > 100000) throw new Error("IFC entity limit is 100,000.");
  }
  return entities;
}

/** Ear clipping for simple planar polygons. Self intersections/holes are deliberately rejected. */
export function triangulatePolygon(points: V[]): number[] {
  if (points.length < 3 || points.length > 4096) throw new Error("Polygon vertex limit is 3–4096.");
  const n: V = [0, 0, 0];
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
  const normal = norm(n), distance = (a: V, b: V) => normal.reduce((s, v, k) => s + v * (a[k] - b[k]), 0);
  if (points.some(p => Math.abs(distance(p, points[0])) > 1e-5)) throw new Error("Nonplanar polygon not supported.");
  const axis = Math.abs(n[0]) > Math.abs(n[1]) ? Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2 : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
  const p = points.map(a => axis === 0 ? [a[1], a[2]] : axis === 1 ? [a[0], a[2]] : [a[0], a[1]]);
  const turn = (a: number, b: number, c: number) => (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);
  let intersections = 0;
  const on = (a: number, b: number, c: number) => Math.abs(turn(a, b, c)) <= 1e-10 && (p[c][0] - p[a][0]) * (p[c][0] - p[b][0]) + (p[c][1] - p[a][1]) * (p[c][1] - p[b][1]) <= 1e-10;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) { const a = i, b = (i + 1) % p.length, c = j, d = (j + 1) % p.length; if (a === d || b === c) continue; if (++intersections > 2000000) throw new Error("Polygon intersection check budget exceeded."); if (turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) throw new Error("Self-intersecting/touching polygon is unsupported."); }
  let area = 0; for (let i = 0; i < p.length; i++) area += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  const sign = area > 0 ? 1 : -1, remaining = p.map((_, k) => k), out: number[] = []; let attempts = 0;
  while (remaining.length > 3) {
    let cut = false;
    for (let k = 0; k < remaining.length; k++) { if (++attempts > 2000000) throw new Error("Polygon triangulation budget exceeded."); const a = remaining[(k + remaining.length - 1) % remaining.length], b = remaining[k], c = remaining[(k + 1) % remaining.length];
      if (sign * turn(a, b, c) <= 1e-10) continue;
      if (remaining.some(j => j !== a && j !== b && j !== c && sign * turn(a, b, j) >= -1e-10 && sign * turn(b, c, j) >= -1e-10 && sign * turn(c, a, j) >= -1e-10)) continue;
      out.push(a, b, c); remaining.splice(k, 1); cut = true; break;
    }
    if (!cut) throw new Error("Invalid/degenerate polygon or unsupported self intersection.");
  }
  out.push(...remaining); return out;
}

export function importIfcGeometry(source: string): IfcDocument {
  if (source.length > 20000000 || !/^\s*ISO-10303-21;/i.test(source)) throw new Error("Expected IFC STEP text, maximum 20 MB.");
  const entities = scan(source), schemaStatement = /FILE_SCHEMA\s*(\(\s*\([^;]*\)\s*\))\s*;/i.exec(source)?.[1];
  const schemaValues = schemaStatement ? list(parseArguments(schemaStatement, { values: 0 })[0]) : [], schema = schemaValues.length === 1 && typeof schemaValues[0] === "string" ? schemaValues[0].toUpperCase() : "UNKNOWN";
  if (!(IFC_SUPPORTED_SCHEMAS as readonly string[]).includes(schema)) throw new Error(`Unsupported or ambiguous IFC schema ${schema}; future/draft schema names are not inferred from a prefix.`);
  const get = (v: StepValue | undefined): StepEntity | undefined => v && typeof v === "object" && !Array.isArray(v) && "ref" in v ? entities.get(v.ref) : undefined;
  const issues: string[] = []; let unitScale = 1;
  const projects = [...entities.values()].filter(e => e.type === "IFCPROJECT"); if (projects.length !== 1) throw new Error("Exactly one IFC project is required to resolve units unambiguously.");
  const project = projects[0], units = get(project.args[8]); if (units?.type !== "IFCUNITASSIGNMENT") throw new Error("IFC project requires a unit assignment.");
  const projectUnits = list(units.args[0]).map(get), lengthUnits = projectUnits.filter(e => e && scalar(e.args[1]) === ".LENGTHUNIT."); if (lengthUnits.length !== 1) throw new Error("Exactly one IFC project length unit is required.");
  const lengthUnit = lengthUnits[0];
  if (lengthUnit?.type === "IFCSIUNIT" && scalar(lengthUnit.args[3]) === ".METRE.") {
    const prefix = scalar(lengthUnit.args[2]), scales: Record<string, number> = { "": 1, ".MILLI.": .001, ".CENTI.": .01, ".DECI.": .1, ".KILO.": 1000, ".MICRO.": .000001 };
    if (!Object.prototype.hasOwnProperty.call(scales, prefix)) throw new Error("Unsupported IFC SI length prefix."); unitScale = scales[prefix];
  } else if (lengthUnit?.type === "IFCCONVERSIONBASEDUNIT") {
    const factor = get(lengthUnit.args[3]), base = get(factor?.args[1]);
    if (base?.type !== "IFCSIUNIT" || scalar(base.args[3]) !== ".METRE." || scalar(base.args[2])) throw new Error("Conversion length unit must reference unprefixed metres.");
    unitScale = Number(scalar(factor?.args[0])); if (!Number.isFinite(unitScale) || unitScale <= 0) throw new Error("Invalid length conversion factor.");
  } else throw new Error("IFC project length unit is required and must be supported.");
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new Error("IFC length scale must be finite and positive.");
  const coords = (v: StepValue | undefined): V => { const e = get(v); if (!e || !["IFCCARTESIANPOINT", "IFCDIRECTION"].includes(e.type)) throw new Error("Coordinates require a Cartesian point or direction reference."); const a = list(e.args[0]); if (a.length < 2 || a.length > 3) throw new Error("Invalid point/direction coordinates."); return [numeric(a[0]), numeric(a[1]), a[2] === undefined ? 0 : numeric(a[2])]; };
  const coordinates3D = (v: StepValue | undefined, entityType: "IFCCARTESIANPOINT" | "IFCDIRECTION"): V => { const e = get(v); if (e?.type !== entityType || list(e.args[0]).length !== 3) throw new Error(`Mapped 3D transforms require three-dimensional ${entityType} coordinates.`); return coords(v); };
  const axis = (v: StepValue | undefined): Matrix => {
    if (v === null || v === undefined) return identity(); const e = get(v); if (!e) throw new Error("Missing axis placement reference.");
    if (e.type === "IFCAXIS2PLACEMENT2D") {
      const location = get(e.args[0]), direction = get(e.args[1]); if (e.args.length !== 2 || location?.type !== "IFCCARTESIANPOINT" || list(location.args[0]).length !== 2 || e.args[1] !== null && (direction?.type !== "IFCDIRECTION" || list(direction.args[0]).length !== 2)) throw new Error("2D axis placement requires matching point/direction dimensions.");
      const x = e.args[1] ? norm(coords(e.args[1])) : [1, 0, 0] as V; return [x, [-x[1], x[0], 0], [0, 0, 1], coords(e.args[0])];
    }
    if (e.type !== "IFCAXIS2PLACEMENT3D" || e.args.length !== 3) throw new Error(`Unsupported/malformed placement ${e.type}.`);
    const location = coordinates3D(e.args[0], "IFCCARTESIANPOINT"), z = e.args[1] ? norm(coordinates3D(e.args[1], "IFCDIRECTION")) : [0, 0, 1] as V, ref = e.args[2] ? norm(coordinates3D(e.args[2], "IFCDIRECTION")) : [1, 0, 0] as V, y = norm(cross(z, ref)); return [norm(cross(y, z)), y, z, location];
  };
  const placement = (v: StepValue | undefined, seen = new Set<number>()): Matrix => { if (v === null || v === undefined) return identity(); const e = get(v); if (!e) throw new Error("Missing local placement reference."); if (e.type !== "IFCLOCALPLACEMENT" || seen.has(e.id) || seen.size > 64) throw new Error("Unsupported/circular placement."); seen.add(e.id); return compose(placement(e.args[0], seen), axis(e.args[1])); };
  const contextAxis = (v: StepValue | undefined, seen = new Set<number>()): Matrix => { const e = get(v); if (!e || seen.has(e.id) || seen.size > 64) throw new Error("Missing/circular representation context."); seen.add(e.id); if (e.type === "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") return contextAxis(e.args[6], seen); if (e.type !== "IFCGEOMETRICREPRESENTATIONCONTEXT" || e.args[2] !== 3 || get(e.args[4])?.type !== "IFCAXIS2PLACEMENT3D") throw new Error("Only 3D representation contexts with a 3D world-coordinate placement are supported."); return axis(e.args[4]); };
  const mappingTarget = (v: StepValue | undefined): Matrix => {
    const e = get(v); if (e?.type !== "IFCCARTESIANTRANSFORMATIONOPERATOR3D" || e.args.length !== 5) throw new Error("Only uniform IFC CartesianTransformationOperator3D mapped targets are supported; 2D/nonuniform targets remain in source.");
    const scale = e.args[3] === null ? 1 : numeric(e.args[3]); if (scale <= 0 || scale < 1e-9 || scale > 1e9) throw new Error("Mapped scale must be positive uniform and within 1e-9..1e9 resource bounds.");
    const directions = [e.args[0], e.args[1], e.args[4]], present = directions.filter(v => v !== null && v !== undefined).length;
    if (present !== 0 && present !== 3) throw new Error("Partial mapped axes require an unsupported base-axis derivation; supply all three orthogonal axes or omit all three.");
    const [x, y, z] = present ? directions.map(v => norm(coordinates3D(v, "IFCDIRECTION"))) : identity().slice(0, 3) as V[];
    if ([dot(x, y), dot(x, z), dot(y, z)].some(v => Math.abs(v) > 1e-10) || Math.abs(dot(cross(x, y), z) - 1) > 1e-10) throw new Error("Mapped axes must be orthonormal and right handed; shears/mirrors are unsupported.");
    return [mul(x, scale), mul(y, scale), mul(z, scale), coordinates3D(e.args[2], "IFCCARTESIANPOINT")];
  };
  let vertexCount = 0, triangleCount = 0, geometrySteps = 0;
  const checkedMesh = (vertices: V[], triangles: number[], transform: Matrix): IfcMesh => {
    vertexCount += vertices.length; triangleCount += triangles.length / 3;
    if (vertexCount > 250000 || triangleCount > 500000 || triangles.length % 3 || triangles.some(i => !Number.isInteger(i) || i < 0 || i >= vertices.length)) throw new Error("Invalid indices or geometry budget exceeded.");
    const values = vertices.flatMap(p => point(transform, p).map(v => v * unitScale)); if (values.some(v => !Number.isFinite(v) || Math.abs(v) > 1e8)) throw new Error("Transformed IFC coordinates exceed finite 100,000 km bounds."); return { vertices: values, triangles };
  };
  const geometry = (v: StepValue | undefined, transform: Matrix, stack = new Set<number>(), applyContext = true): IfcMesh[] => {
    if (++geometrySteps > 200000) throw new Error("IFC geometry traversal budget exceeded.");
    const e = get(v); if (!e) throw new Error("Missing geometry reference."); if (stack.has(e.id) || stack.size > 64) throw new Error("Circular geometry graph."); const next = new Set(stack); next.add(e.id);
    if (e.type === "IFCPRODUCTDEFINITIONSHAPE" || e.type === "IFCPRODUCTREPRESENTATION") return list(e.args[2]).flatMap(r => geometry(r, transform, next, applyContext));
    if (e.type === "IFCSHAPEREPRESENTATION") { if (scalar(e.args[1]) && !["Body", "Facetation", "Model"].includes(scalar(e.args[1]))) return []; const context = contextAxis(e.args[0]), world = applyContext ? compose(context, transform) : transform; return list(e.args[3]).flatMap(r => geometry(r, world, next, false)); }
    if (e.type === "IFCMAPPEDITEM") {
      const map = get(e.args[0]); if (e.args.length !== 2 || map?.type !== "IFCREPRESENTATIONMAP" || map.args.length !== 2 || next.has(map.id)) throw new Error("Missing/circular mapped representation source.");
      const origin = get(map.args[0]), representation = get(map.args[1]); if (origin?.type !== "IFCAXIS2PLACEMENT3D" || representation?.type !== "IFCSHAPEREPRESENTATION") throw new Error("Mapped geometry requires a 3D mapping origin and shape representation.");
      coordinates3D(origin.args[0], "IFCCARTESIANPOINT"); if (origin.args[1]) coordinates3D(origin.args[1], "IFCDIRECTION"); if (origin.args[2]) coordinates3D(origin.args[2], "IFCDIRECTION");
      const originMatrix = axis(map.args[0]), zeroOrigin = identity(); if (originMatrix.some((column, index) => column.some((value, component) => value !== zeroOrigin[index][component]))) throw new Error("Nonidentity MappingOrigin requires a separately verified transformation convention and is unsupported; original STEP is retained.");
      next.add(map.id); const mapped = mappingTarget(e.args[1]);
      // The mapped source stays in its representation coordinate system; context/WCS is applied only by the outer occurrence representation.
      return geometry(map.args[1], compose(transform, mapped), next, false);
    }
    if (e.type === "IFCTRIANGULATEDFACESET") { const vertices = list(get(e.args[0])?.args[0]).map(a => { const b = list(a); return [numeric(b[0]), numeric(b[1]), numeric(b[2])] as V; }), pn = list(e.args[4]); const triangles = list(e.args[3]).flatMap(a => { const b = list(a); if (b.length !== 3) throw new Error("Triangle needs 3 indices."); return b.map(i => { const n = numeric(i); return (pn.length ? numeric(pn[n - 1]) : n) - 1; }); }); return [checkedMesh(vertices, triangles, transform)]; }
    if (e.type === "IFCFACETEDBREP" || e.type === "IFCSHELLBASEDSURFACEMODEL") { const shells = e.type === "IFCFACETEDBREP" ? [e.args[0]] : list(e.args[0]); return shells.flatMap(shell => list(get(shell)?.args[0]).map(face => { const bounds = list(get(face)?.args[0]); if (bounds.length !== 1) throw new Error("BRep faces with holes are not supported."); const bound = get(bounds[0]), loop = get(bound?.args[0]); if (loop?.type !== "IFCPOLYLOOP") throw new Error("Only polygonal BRep face bounds supported."); const p = list(loop.args[0]).map(coords); if (scalar(bound?.args[1]) === ".F.") p.reverse(); return checkedMesh(p, triangulatePolygon(p), transform); })); }
    if (e.type === "IFCEXTRUDEDAREASOLID") {
      const profile = get(e.args[0]); if (!profile) throw new Error("Missing extrusion profile."); let p: V[];
      if (profile.type === "IFCRECTANGLEPROFILEDEF") { const w = numeric(profile.args[3]) / 2, h = numeric(profile.args[4]) / 2; if (w <= 0 || h <= 0) throw new Error("Invalid rectangular profile."); p = [[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]].map(a => point(axis(profile.args[2]), a as V)); }
      else if (profile.type === "IFCCIRCLEPROFILEDEF") { const radius = numeric(profile.args[3]); if (radius <= 0) throw new Error("Invalid circular profile."); p = Array.from({ length: 48 }, (_, i) => point(axis(profile.args[2]), [radius * Math.cos(i * Math.PI / 24), radius * Math.sin(i * Math.PI / 24), 0])); }
      else if (profile.type === "IFCARBITRARYCLOSEDPROFILEDEF") { const curve = get(profile.args[2]); if (curve?.type !== "IFCPOLYLINE") throw new Error("Arbitrary profile requires a closed polyline."); p = list(curve.args[0]).map(coords); if (p.length < 4 || Math.hypot(...p[0].map((n, k) => n - p[p.length - 1][k])) > 1e-8) throw new Error("Profile polyline is not closed."); p.pop(); }
      else throw new Error(`Unsupported profile ${profile.type}.`);
      let area = 0; for (let i = 0; i < p.length; i++) area += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1]; if (area < 0) p.reverse();
      const depth = numeric(e.args[3]); if (depth <= 0) throw new Error("Invalid extrusion depth."); const direction = norm(coords(e.args[2])); if (direction[2] <= 1e-8) throw new Error("Only positive local-Z extrusion directions are supported."); const cap = triangulatePolygon(p), count = p.length, vertices = [...p, ...p.map(a => add(a, mul(direction, depth)))], triangles: number[] = [];
      for (let i = 0; i < cap.length; i += 3) triangles.push(cap[i + 2], cap[i + 1], cap[i], cap[i] + count, cap[i + 1] + count, cap[i + 2] + count);
      for (let i = 0; i < count; i++) { const j = (i + 1) % count; triangles.push(i, j, j + count, i, j + count, i + count); }
      return [checkedMesh(vertices, triangles, compose(transform, axis(e.args[1])))];
    }
    throw new Error(`Unsupported geometric entity ${e.type} (#${e.id}).`);
  };
  const products: IfcProduct[] = [], byId = new Map<number, IfcProduct>(), guids = new Set<string>();
  const productClasses = new Set(IFC_METADATA_PRODUCT_CLASSES);
  const predefinedIndex: Record<string, number> = { IFCWALL: 8, IFCWALLSTANDARDCASE: 8, IFCSLAB: 8, IFCROOF: 8, IFCCOLUMN: 8, IFCBEAM: 8, IFCMEMBER: 8, IFCPLATE: 8, IFCCOVERING: 8, IFCDOOR: 10, IFCWINDOW: 10 };
  const supportedTypeClasses = new Set([...productClasses].filter(t => !["IFCWALLSTANDARDCASE", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCOPENINGELEMENT"].includes(t)).map(t => `${t}TYPE`));
  const predefinedTypeClasses = new Set(Object.keys(predefinedIndex).filter(t => t !== "IFCWALLSTANDARDCASE").map(t => `${t}TYPE`));
  for (const e of entities.values()) {
    // Product common attributes: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation.
    if (e.type.startsWith("IFCREL") || !productClasses.has(e.type) && get(e.args[6])?.type !== "IFCPRODUCTDEFINITIONSHAPE") continue;
    const globalId = typeof e.args[0] === "string" ? e.args[0] : ""; if (!/^[0-3][0-9A-Za-z_$]{21}$/.test(globalId)) { issues.push(`Invalid product GlobalId at #${e.id}; product omitted.`); continue; }
    const attributes: Record<string, string> = { GlobalId: globalId, Name: scalar(e.args[2]), Description: scalar(e.args[3]), ObjectType: scalar(e.args[4]) };
    if (schema !== "IFC2X3" && predefinedIndex[e.type] !== undefined) attributes.PredefinedType = scalar(e.args[predefinedIndex[e.type]]).replace(/^\.|\.$/g, "");
    const attributePresence = { GlobalId: true, Name: typeof e.args[2] === "string", Description: typeof e.args[3] === "string", ObjectType: typeof e.args[4] === "string" };
    const p: IfcProduct = { stepId: e.id, globalId, type: e.type, name: scalar(e.args[2]), attributes, attributePresence, properties: Object.create(null) as Record<string, string>, propertyTypes: Object.create(null) as Record<string, string>, propertyValues: Object.create(null) as Record<string, IfcPropertyValue>, metadataIssues: [], predefinedTypeSupported: schema !== "IFC2X3" && predefinedIndex[e.type] !== undefined, meshes: [], issues: [] };
    if ([e.args[2], e.args[3], e.args[4]].some(v => v !== null && typeof v !== "string")) p.metadataIssues!.push("Product Name/Description/ObjectType fields must be STEP strings or unset; malformed common attributes are not interpreted.");
    if (p.predefinedTypeSupported && e.args[predefinedIndex[e.type]] !== null && enumeration(e.args[predefinedIndex[e.type]]) === undefined) { p.predefinedTypeSupported = false; p.metadataIssues!.push("Occurrence PredefinedType is not a supported STEP enumeration."); }
    if (p.predefinedTypeSupported && attributes.PredefinedType === "USERDEFINED" && (!attributePresence.ObjectType || !attributes.ObjectType)) { p.predefinedTypeSupported = false; p.metadataIssues!.push("Occurrence USERDEFINED requires a non-empty ObjectType for this predefined classification subset."); }
    if (guids.has(globalId)) p.issues.push("Duplicate GlobalId."); guids.add(globalId);
    try { p.meshes = geometry(e.args[6], placement(e.args[5])); if (!p.meshes.length) p.issues.push("No supported Body representation."); } catch (error) { p.issues.push(error instanceof Error ? error.message : "Geometry import failed."); }
    products.push(p); byId.set(e.id, p); if (products.length > 10000) throw new Error("IFC product limit is 10,000.");
  }
  let metadataSteps = 0;
  const metadataStep = (): void => { if (++metadataSteps > 200000) throw new Error("IFC metadata traversal/assignment budget exceeded; narrow the exchange model."); };
  const metadataIssue = (product: IfcProduct, message: string): void => { const messages = product.metadataIssues!; if (messages.length < 128 && !messages.includes(message)) messages.push(message); else if (messages.length === 128) messages.push("Additional metadata issues exceeded the 128-message per-product limit; metadata coverage is incomplete."); };
  const unitMetadata = (unit: StepEntity, source: IfcPropertyUnit["source"]): IfcPropertyUnit => {
    const record: IfcPropertyUnit = { stepId: unit.id, entityType: unit.type, unitType: scalar(unit.args[1]).replace(/^\.|\.$/g, ""), name: scalar(unit.args[unit.type === "IFCSIUNIT" ? 3 : 2]), prefix: unit.type === "IFCSIUNIT" ? scalar(unit.args[2]).replace(/^\.|\.$/g, "") : "", source };
    if (unit.type === "IFCCONVERSIONBASEDUNIT") { const factor = get(unit.args[3]), base = get(factor?.args[1]), factorValue = Number(scalar(factor?.args[0])); if (factor?.type === "IFCMEASUREWITHUNIT" && base && Number.isFinite(factorValue) && factorValue > 0) { record.conversionFactor = factorValue; record.baseUnitStepId = base.id; } }
    return record;
  };
  const measureUnits: Record<string, string> = { IFCLENGTHMEASURE: "LENGTHUNIT", IFCPOSITIVELENGTHMEASURE: "LENGTHUNIT", IFCNONNEGATIVELENGTHMEASURE: "LENGTHUNIT", IFCAREAMEASURE: "AREAUNIT", IFCVOLUMEMEASURE: "VOLUMEUNIT", IFCMASSMEASURE: "MASSUNIT", IFCTIMEMEASURE: "TIMEUNIT", IFCPLANEANGLEMEASURE: "PLANEANGLEUNIT", IFCPOSITIVEPLANEANGLEMEASURE: "PLANEANGLEUNIT" };
  const scalarPropertyTypes = new Set(["IFCLABEL", "IFCTEXT", "IFCIDENTIFIER", "IFCBOOLEAN", "IFCINTEGER", "IFCREAL", ...Object.keys(measureUnits)]);
  const readProperty = (set: StepEntity, property: StepEntity, origin: IfcPropertyValue["origin"], product: IfcProduct, typeStepId?: number): IfcPropertyValue => {
    metadataStep(); const valueIssues: string[] = [], raw = property.args[2], typed = raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) && "type" in raw ? raw : undefined;
    const dataType = typed?.type ?? (raw === null ? "EMPTY" : "UNKNOWN"), nominal = typed?.values.length === 1 ? typed.values[0] : typed ? undefined : raw;
    if (raw !== null && (!typed || !scalarPropertyTypes.has(dataType))) valueIssues.push("Nominal value must be unset or one explicitly typed scalar in the declared property subset.");
    let value: IfcPropertyValue["value"] = null;
    if (nominal === null || nominal === undefined) { if (raw !== null) valueIssues.push("Nominal value is not one supported typed scalar."); }
    else if (dataType === "IFCBOOLEAN") { const token = enumeration(nominal); if (token === ".T." || token === ".F.") value = token === ".T."; else valueIssues.push("IfcBoolean nominal value must be an unquoted .T. or .F. STEP token."); }
    else if (typeof nominal === "string" || typeof nominal === "number") { value = nominal; if (dataType === "IFCINTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) valueIssues.push("IfcInteger must be a safe integer for this implementation."); if (["IFCLABEL", "IFCTEXT", "IFCIDENTIFIER"].includes(dataType) && typeof value !== "string" || dataType === "IFCREAL" && typeof value !== "number") valueIssues.push("Nominal primitive does not match its declared IFC data type."); }
    else valueIssues.push("Aggregate/reference/complex nominal values are outside the single scalar metadata subset.");
    if (property.args.length !== 4) valueIssues.push("Single-value property has a malformed argument count.");
    if (measureUnits[dataType] && typeof value !== "number") valueIssues.push("Supported physical measure nominal values must be finite STEP numbers.");
    let unit: IfcPropertyUnit | null = null;
    if (property.args[3] !== null && property.args[3] !== undefined) { const explicit = get(property.args[3]); if (!explicit || !["IFCSIUNIT", "IFCCONVERSIONBASEDUNIT", "IFCCONVERSIONBASEDUNITWITHOFFSET", "IFCCONTEXTDEPENDENTUNIT", "IFCDERIVEDUNIT", "IFCMONETARYUNIT"].includes(explicit.type)) valueIssues.push("Explicit property unit reference is unresolved or not an IFC unit."); else unit = unitMetadata(explicit, "explicit"); }
    else if (measureUnits[dataType]) { const matches = projectUnits.filter(e => e && scalar(e.args[1]) === `.${measureUnits[dataType]}.`); if (matches.length !== 1 || !matches[0]) valueIssues.push("Measure property project unit is missing or ambiguous."); else unit = unitMetadata(matches[0], "project"); }
    const propertySet = scalar(set.args[2]), name = scalar(property.args[0]); if (typeof set.args[2] !== "string" || typeof property.args[0] !== "string" || !propertySet || !name || propertySet.length > 2000 || name.length > 2000) { const message = "Property-set and property names require bounded non-empty STEP strings; unresolved names cannot narrow IDS applicability."; valueIssues.push(message); metadataIssue(product, message); }
    return { propertySet, name, dataType, value, lexicalValue: scalar(raw), unit, propertyStepId: property.id, propertySetStepId: set.id, origin, ...(typeStepId === undefined ? {} : { typeStepId }), supported: !valueIssues.length, issues: valueIssues };
  };
  const mergeValue = (target: Record<string, IfcPropertyValue>, entry: IfcPropertyValue, product: IfcProduct): void => {
    metadataStep(); const key = `${entry.propertySet}.${entry.name}`, existing = target[key];
    if (!existing) { target[key] = entry; return; }
    const message = `Duplicate/ambiguous property key ${key} within ${entry.origin} assignments; no first/last value is selected.`; metadataIssue(product, message);
    target[key] = { ...entry, supported: false, value: null, lexicalValue: "", issues: [...existing.issues, ...entry.issues, message].slice(0, 32) };
  };
  const readSets = (refs: StepValue[], origin: IfcPropertyValue["origin"], product: IfcProduct, typeStepId?: number): Record<string, IfcPropertyValue> => {
    const values = Object.create(null) as Record<string, IfcPropertyValue>, seenSets = new Set<number>();
    for (const ref of refs) {
      metadataStep(); const set = get(ref); if (set?.type !== "IFCPROPERTYSET" || seenSets.has(set.id)) { metadataIssue(product, "Missing, duplicate or unsupported property-set definition; quantities/predefined/complex property sets are not evaluated."); continue; } seenSets.add(set.id);
      if (!Array.isArray(set.args[4]) || !set.args[4].length || set.args.length !== 5) { metadataIssue(product, "Property-set members are missing or malformed; no single-value coverage is asserted."); continue; }
      for (const ref of list(set.args[4])) { metadataStep(); const property = get(ref); if (property?.type !== "IFCPROPERTYSINGLEVALUE") { metadataIssue(product, `Property set ${scalar(set.args[2])} contains an unsupported or unresolved property; only single scalar values are evaluated.`); continue; } mergeValue(values, readProperty(set, property, origin, product, typeStepId), product); }
    }
    return values;
  };
  const typeAssignments = new Map<number, StepEntity[]>(), occurrenceSets = new Map<number, StepValue[]>();
  for (const e of entities.values()) {
    if (e.type !== "IFCRELDEFINESBYTYPE" && e.type !== "IFCRELDEFINESBYPROPERTIES") continue;
    if (e.args.length !== 6 || !Array.isArray(e.args[4]) || !e.args[4].length) throw new Error("Malformed IFC property/type relationship argument or related-object set.");
    for (const ref of list(e.args[4])) {
      metadataStep(); const related = get(ref); if (!related) throw new Error("Unresolved related object in an IFC property/type relationship."); const product = byId.get(related.id); if (!product) continue;
      if (e.type === "IFCRELDEFINESBYTYPE") { const type = get(e.args[5]); if (!type || !supportedTypeClasses.has(type.type)) { metadataIssue(product, "Related type is missing or outside the supported direct IfcTypeObject property subset."); continue; } const expectedOccurrence = product.type === "IFCWALLSTANDARDCASE" ? "IFCWALL" : product.type; if (type.type !== `${expectedOccurrence}TYPE`) { metadataIssue(product, `Type ${type.type} is incompatible with ${product.type} in this direct occurrence/type subset; cross-class or IFC2X3 generic remapping is not inferred.`); product.predefinedTypeSupported = false; continue; } const assignments = typeAssignments.get(product.stepId) ?? []; assignments.push(type); typeAssignments.set(product.stepId, assignments); }
      else { const refs = occurrenceSets.get(product.stepId) ?? []; const definition = e.args[5]; if (Array.isArray(definition) || definition && typeof definition === "object" && "type" in definition) metadataIssue(product, "IFC property-set-definition select aggregates are unsupported; use direct property-set relationships."); else refs.push(definition); occurrenceSets.set(product.stepId, refs); }
    }
  }
  for (const product of products) {
    const assigned = typeAssignments.get(product.stepId) ?? [], inherited = Object.create(null) as Record<string, IfcPropertyValue>;
    if (assigned.length > 1) { metadataIssue(product, "Multiple type relationships prevent unambiguous inherited properties/predefined type; no type is selected."); product.predefinedTypeSupported = false; }
    else if (assigned.length === 1) {
      const type = assigned[0]; if (type.args[5] !== null && (!Array.isArray(type.args[5]) || !type.args[5].length)) metadataIssue(product, "Type HasPropertySets is malformed; inherited metadata is incomplete."); const values = readSets(list(type.args[5]), "type", product, type.id); Object.assign(inherited, values);
      const knownPredefined = predefinedTypeClasses.has(type.type) && !(schema === "IFC2X3" && ["IFCDOORTYPE", "IFCWINDOWTYPE"].includes(type.type));
      product.declaredType = { stepId: type.id, entityType: type.type, predefinedType: knownPredefined ? scalar(type.args[9]).replace(/^\.|\.$/g, "") : "", elementType: knownPredefined ? scalar(type.args[8]) : "" };
      if (knownPredefined) product.predefinedTypeSupported = true;
      if (knownPredefined && (enumeration(type.args[9]) === undefined || type.args[8] !== null && typeof type.args[8] !== "string")) { product.predefinedTypeSupported = false; metadataIssue(product, "Type PredefinedType/ElementType fields are malformed; predefined classification is unresolved."); }
      if (knownPredefined && product.declaredType.predefinedType === "USERDEFINED" && !product.declaredType.elementType) { product.predefinedTypeSupported = false; metadataIssue(product, "Type USERDEFINED requires a non-empty ElementType for this predefined classification subset."); }
      if (schema === "IFC2X3" && product.type.startsWith("IFCFLOW")) metadataIssue(product, "IFC2X3 generic flow occurrence/type class remapping is outside the IDS entity subset.");
    }
    const occurrence = readSets(occurrenceSets.get(product.stepId) ?? [], "occurrence", product);
    // Override requires the actual set/name pair to match; dotted legacy keys alone are not an identity.
    const combined = Object.assign(Object.create(null) as Record<string, IfcPropertyValue>, inherited);
    for (const [key, entry] of Object.entries(occurrence)) {
      metadataStep(); const existing = combined[key];
      if (existing && (existing.propertySet !== entry.propertySet || existing.name !== entry.name)) {
        const message = `Different type/occurrence property-set/name pairs collide at legacy key ${key}; no override value is selected.`; metadataIssue(product, message);
        combined[key] = { ...entry, supported: false, value: null, lexicalValue: "", issues: [...existing.issues, ...entry.issues, message].slice(0, 32) };
      } else combined[key] = entry;
    }
    for (const [key, entry] of Object.entries(combined)) { metadataStep(); product.propertyValues![key] = entry; product.properties[key] = entry.lexicalValue; product.propertyTypes![key] = entry.dataType; }
  }
  const hostsWithVoids = new Set<IfcProduct>();
  for (const entity of entities.values()) {
    if (entity.type !== "IFCRELVOIDSELEMENT") continue;
    const host = byId.get(get(entity.args[4])?.id ?? -1);
    if (host) hostsWithVoids.add(host);
  }
  for (const host of hostsWithVoids) {
    host.issues.push("Host void/opening geometry is retained in source but not subtracted from the imported mesh.");
  }
  if (entities.size && !products.length) issues.push("No products with supported product representation attributes found.");
  issues.push("Openings/Boolean operations, mirrored/nonuniform/partially authored mapped transforms, multi-hop type inheritance, non-scalar properties, textures and CRS map conversions are not applied. Source STEP is preserved on export; this is a shared IFC representation/metadata subset, not full schema validation.");
  return { schema, source, products, issues, entities, unitScale };
}

function nameRange(source: string, entity: StepEntity): [number, number] {
  let i = entity.start;
  while (i < entity.end) { if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0 || end >= entity.end) throw new Error("Malformed source comment."); i = end + 2; continue; } if (source[i] === "(") break; i++; }
  if (i >= entity.end) throw new Error("Source entity argument list not found.");
  i++; let start = i, depth = 1, index = 0;
  while (i < entity.end) {
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) throw new Error("Malformed source comment."); i = end + 2; continue; }
    const ch = source[i]; if (ch === "'") { i++; while (i < entity.end) { if (source[i++] === "'") { if (source[i] === "'") i++; else break; } } continue; }
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (depth === 1 && ch === "," || depth === 0) { if (index === 2) return [start, i]; start = i + 1; index++; }
    i++;
  }
  throw new Error("Source product name attribute not found.");
}
function encodeName(name: string): string { let encoded = ""; for (let i = 0; i < name.length; i++) { const code = name.charCodeAt(i); encoded += code > 126 ? `\\X2\\${code.toString(16).padStart(4, "0").toUpperCase()}\\X0\\` : name[i] === "\\" ? "\\\\" : name[i] === "'" ? "''" : name[i]; } return `'${encoded}'`; }

/** Replace only requested product names; all GUIDs, properties, geometry and unsupported source records remain intact. */
export function exportIfcRoundTrip(document: IfcDocument, names: Record<string, string> = {}): string {
  const patches: { start: number; end: number; text: string }[] = [];
  const counts = new Map<string, number>(); for (const product of document.products) counts.set(product.globalId, (counts.get(product.globalId) ?? 0) + 1);
  for (const product of document.products) { const name = names[product.globalId]; if (name === undefined) continue; if (typeof name !== "string") throw new Error("Requested IFC names must be strings."); const e = document.entities.get(product.stepId); if (!e) throw new Error("Source product record is missing."); if (typeof e.args[2] === "string" && name === e.args[2]) continue; if (counts.get(product.globalId)! > 1) throw new Error("Duplicate GlobalIds prevent unambiguous renaming; repair identifiers in the authoring tool."); if (name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Name must be at most 1024 printable characters."); const [start, end] = nameRange(document.source, e); patches.push({ start, end, text: encodeName(name) }); }
  let result = document.source; for (const patch of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, patch.start) + patch.text + result.slice(patch.end); return result;
}

function productCoverageWarning(product: IfcProduct, issue: string): string {
  return `${product.globalId} (#${product.stepId}): ${issue}`.slice(0, 500);
}

/** Reserve four of the scene's 100 warning slots for the caller's scope and conversion notes. */
export function ifcGeometryCoverageWarnings(document: IfcDocument): string[] {
  const warnings: string[] = [];
  let total = 0;
  for (const product of document.products) for (const issue of product.issues) {
    if (++total <= 96) warnings.push(productCoverageWarning(product, issue));
  }
  for (const issue of document.issues) {
    if (++total <= 96) warnings.push(issue.slice(0, 500));
  }
  if (total > warnings.length) {
    warnings.pop();
    warnings.push(`${total - warnings.length} additional IFC geometry findings omitted from this scene. See the full geometry coverage report and retain the source IFC.`);
  }
  return warnings;
}

export function exportIfcMeshObj(document: IfcDocument): string {
  let offset = 1;
  const out = [
    "# IFC supported geometry in metres; IFC Z-up coordinates",
    "# Partial IFC mesh for coordination. Retain the source IFC and geometry coverage report for review.",
  ];
  for (const product of document.products) {
    out.push(`o ${product.globalId}`);
    for (const issue of product.issues) {
      out.push(`# ${productCoverageWarning(product, issue).replace(/[\r\n\u2028\u2029]+/g, " ")}`);
    }
    for (const mesh of product.meshes) {
      for (let i = 0; i < mesh.vertices.length; i += 3) out.push(`v ${mesh.vertices[i]} ${mesh.vertices[i + 1]} ${mesh.vertices[i + 2]}`);
      for (let i = 0; i < mesh.triangles.length; i += 3) out.push(`f ${mesh.triangles[i] + offset} ${mesh.triangles[i + 1] + offset} ${mesh.triangles[i + 2] + offset}`);
      offset += mesh.vertices.length / 3;
    }
  }
  return out.join("\n");
}
