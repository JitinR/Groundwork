import test from "node:test";
import assert from "node:assert/strict";
import { defaultDesign, type Design, type DraftElement } from "../src/types";
import { cadFootprintArea, cadQuantities, createCadObject, executeCadCommand, localCadAxis, resizeDraft, resolveCadSnap } from "../src/lib/cadModel";
import { buildDxf } from "../src/lib/dxf";
import { buildBimExchange, buildIfcStep, ifcSourceGuid, validateIfcProfile, validateIfcStep } from "../src/lib/bim";
import { inspectBimGeometry } from "../src/lib/bimValidation";
import { documentationInventory } from "../src/lib/documentationSchedule";
import { exportIfcMeshObj, exportIfcRoundTrip, ifcGeometryCoverageWarnings, importIfcGeometry } from "../src/lib/ifcGeometry";
import { buildObjMtl } from "../src/lib/obj";

const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const project = (...objects: DraftElement[]): Design => ({ ...defaultDesign(), drafts: objects, cad: { version: 1, revision: 7 } });

test("OBJ retains hidden authored mesh dimensions, rotated position and stable identity", () => {
  const column = { ...createCadObject("column"), x: 12, z: 7, w: .6, d: .5, h: 4.2, rotationDeg: 90, visible: false };
  const { obj, mtl } = buildObjMtl(project(column));
  const authored = obj.split(`o cad_${column.id}`)[1];
  assert(authored); assert(mtl.includes(`newmtl cad_${column.id}`));
  const vertices = authored.split("\n").filter(line => line.startsWith("v ")).map(line => line.split(" ").slice(1).map(Number));
  const bounds = [0,1,2].map(axis => [Math.min(...vertices.map(point => point[axis])), Math.max(...vertices.map(point => point[axis]))]);
  close(bounds[0][1] - bounds[0][0], .5, 1e-6); close(bounds[1][1] - bounds[1][0], 4.2, 1e-6); close(bounds[2][1] - bounds[2][0], .6, 1e-6);
  close((bounds[0][0] + bounds[0][1]) / 2, 12); close((bounds[2][0] + bounds[2][1]) / 2, 7);
});
const footprint = (): DraftElement => ({ ...createCadObject("slab"), w: 4, d: 3, h: .2, rotationDeg: 31, points: [{ x: -2, z: -1.5 }, { x: 2, z: -1.5 }, { x: 2, z: -.5 }, { x: 0, z: -.5 }, { x: 0, z: 1.5 }, { x: -2, z: 1.5 }] });
const dxfEntities = (source: string) => {
  const lines = source.trim().split(/\r?\n/), entities: { kind: string; values: [number, string][] }[] = [];
  let inEntities = false;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1]?.trim() ?? "";
    if (code === 2 && value === "ENTITIES") { inEntities = true; continue; }
    if (!inEntities) continue;
    if (code === 0 && value === "ENDSEC") break;
    if (code === 0) entities.push({ kind: value, values: [] });
    else entities.at(-1)?.values.push([code, value]);
  }
  return entities;
};

test("polygon slab resize scales its real boundary and fixes the opposite rotated face", () => {
  const original = footprint();
  for (const side of [-1, 1] as const) {
    const resized = resizeDraft(original, "x", side, 6), axis = localCadAxis(original, "x");
    close(Math.min(...resized.points!.map(point => point.x)), -3);
    close(Math.max(...resized.points!.map(point => point.x)), 3);
    close(resized.x - side * 3 * axis.x, original.x - side * 2 * axis.x);
    close(resized.z - side * 3 * axis.z, original.z - side * 2 * axis.z);
    close(cadFootprintArea(resized), 12);
  }
  const symmetric = resizeDraft(original, "z", -1, 6, true);
  close(symmetric.x, original.x); close(symmetric.z, original.z); close(cadFootprintArea(symmetric), 16);
  close(cadQuantities(project(original))[0].volumeM3, 1.6);
  const command = executeCadCommand(project(original), { type: "modify", id: original.id, patch: { w: 8 } });
  close(Math.max(...command.drafts![0].points!.map(point => point.x)) - Math.min(...command.drafts![0].points!.map(point => point.x)), 8);
  close(cadQuantities(command)[0].volumeM3, 3.2);
});

test("invalid polygon solids fail atomically without changing the project", () => {
  const base = project(), before = JSON.stringify(base);
  for (const points of [
    [{ x: -1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }, { x: 1, z: -1 }],
    [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }],
    [{ x: 0, z: 0 }, { x: 1, z: 1 }],
    [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }],
  ]) assert.throws(() => executeCadCommand(base, { type: "create", object: { ...footprint(), points } }), /Footprint|footprint/);
  assert.equal(JSON.stringify(base), before);
});

test("overlapping wall openings are rejected while shared edges remain valid", () => {
  const wall = { ...createCadObject("wall"), openings: [{ id: "a", kind: "void" as const, widthM: 1, heightM: 2, offsetM: -.5, sillM: 0 }, { id: "b", kind: "window" as const, widthM: 1, heightM: 1, offsetM: 0, sillM: 1 }] };
  assert.throws(() => executeCadCommand(project(), { type: "create", object: wall }), /cannot overlap/);
  wall.openings[1].offsetM = .5;
  const valid = executeCadCommand(project(), { type: "create", object: wall });
  close(cadQuantities(valid)[0].volumeM3, 4 * .2 * 3 - 3 * .2);
});

test("root CAD objects export stable IDs and resolved level/family dimensions", () => {
  const level = { id: "l1", name: "Upper", elevation: 4, floorHeight: 3 };
  const beam = { ...createCadObject("beam", level), id: "beam-precision", family: { levelId: level.id, typeParameters: { width: 4.123456, depth: .3, height: .45 }, instanceParameters: { baseOffset: .125 } } };
  const design = project(beam); design.cad!.levels = [level];
  const exchange = JSON.parse(buildBimExchange(design));
  const entity = exchange.entities.find((item: { id: string }) => item.id === beam.id);
  assert.equal(entity.type, "DRAFT_BEAM"); close(entity.geometry.widthM, 4.123456); close(entity.geometry.yM, 4.125);
  const record = documentationInventory(design).find(item => item.id === beam.id)!;
  close(Number(record.values["width m"]), 4.123456); close(Number(record.values["elevation m"]), 4.125);
  const ifc = buildIfcStep(design);
  assert.match(ifc, /IFCBEAM\(/); assert.match(ifc, /4\.123456/); assert.match(ifc, /beam-precision/);
});

test("circular column exchange uses circular section and visibility-independent quantities", () => {
  const column = resizeDraft({ ...createCadObject("circular-column"), id: "round-column", visible: false }, "x", 1, .654321, true);
  const design = project(column), area = Math.PI * .654321 ** 2 / 4;
  const entity = JSON.parse(buildBimExchange(design)).entities.find((item: { id: string }) => item.id === column.id);
  assert.equal(entity.geometry.kind, "cylinder"); close(entity.geometry.radiusM, .654321 / 2); close(entity.properties.grossVolumeM3, area * 3);
  close(Number(documentationInventory(design).find(item => item.id === column.id)!.values["volume m3"]), area * 3);
  assert.match(buildIfcStep(design), /IFCCIRCLEPROFILEDEF\(\.AREA\.,\$,#\d+,0\.327161\)/);
  const circle = dxfEntities(buildDxf(design)).find(item => item.kind === "CIRCLE" && item.values.some(([code,value]) => code === 1000 && value === column.id));
  assert.ok(circle); close(Number(circle.values.find(([code]) => code === 40)![1]), 327.161, .00001);
});

test("DXF plan coordinates follow the same positive-Y rotation as the viewport", () => {
  const wall = { ...createCadObject("wall"), id: "rotated-wall", x: 3, z: 5, w: 4, d: .2, rotationDeg: 90 };
  const entity = dxfEntities(buildDxf(project(wall))).find(item => item.kind === "LWPOLYLINE" && item.values.some(([code,value]) => code === 1000 && value === wall.id))!;
  assert.ok(entity);
  const x = entity.values.filter(([code]) => code === 10).map(([,value]) => Number(value));
  const z = entity.values.filter(([code]) => code === 20).map(([,value]) => Number(value));
  assert.deepEqual(x, [2900,2900,3100,3100]); assert.deepEqual(z, [7000,3000,3000,7000]);
  assert.match(buildIfcStep(project(wall)), /IFCDIRECTION\(\(0\.000000000,-1\.000000000,0\.\)\)/);
});

test("polygon exchange preserves its authored footprint and net quantities", () => {
  const slab = { ...footprint(), id: "L-slab", rotationDeg: 0 }, design = project(slab);
  const entity = JSON.parse(buildBimExchange(design)).entities.find((item: { id: string }) => item.id === slab.id);
  assert.equal(entity.geometry.kind, "polygon-extrusion"); assert.deepEqual(entity.geometry.points, slab.points); close(entity.properties.netVolumeM3, 1.6);
  close(Number(documentationInventory(design).find(item => item.id === slab.id)!.values["area m2"]), 8);
  const plan = dxfEntities(buildDxf(design)).find(item => item.kind === "LWPOLYLINE" && item.values.some(([code,value]) => code === 1000 && value === slab.id))!;
  assert.equal(plan.values.filter(([code]) => code === 10).length, 6);
  const ifc = buildIfcStep(design);
  assert.match(ifc, /IFCARBITRARYCLOSEDPROFILEDEF\(\.AREA\.,\$,#\d+\)/);
  assert.match(ifc, /IFCCARTESIANPOINT\(\(2\.000000,-0\.500000\)\)/);
  assert.match(ifc, /IFCQUANTITYVOLUME\('GrossVolume',\$,\$,1\.600000,\$\)/);
  assert.equal(validateIfcStep(ifc).valid, true);
});

test("unfilled authored IFC voids retain their host and pass reference-view preflight without an invented fill", () => {
  const wall = { ...createCadObject("wall"), id: "void-host", openings: [{ id: "unfilled-void", kind: "void" as const, widthM: 1, heightM: 2, offsetM: 0, sillM: 0 }] };
  const ifc = buildIfcStep(project(wall));
  const opening = ifc.split("\n").find(line => line.includes(`=IFCOPENINGELEMENT('${ifcSourceGuid("unfilled-void")}'`));
  assert.ok(opening, "Authored void must be an actual IfcOpeningElement");
  const openingId = opening.match(/^#(\d+)=/)![1];
  assert.match(ifc, new RegExp(`=IFCRELVOIDSELEMENT\\([^\\n]+,#${openingId}\\);`));
  assert.doesNotMatch(ifc, /=IFCRELFILLSELEMENT\(/, "An authored unfilled void must not acquire a fictitious fill");
  assert.equal(validateIfcStep(ifc).valid, true);
  const profile = validateIfcProfile(ifc, "reference-view");
  assert.equal(profile.valid, true, JSON.stringify(profile.issues));

  const noHost = ifc.split("\n").filter(line => !line.includes("=IFCRELVOIDSELEMENT(")).join("\n");
  assert.ok(validateIfcStep(noHost).issues.some(issue => issue.code === "opening-host-missing"), "Missing unfilled-void hosts must still fail preflight");
});

test("IFC proxy and OBJ coverage preserve relational-void warnings on the affected mesh", () => {
  const wall = { ...createCadObject("wall"), id: "coverage-host", openings: [
    { id: "coverage-void-west", kind: "void" as const, widthM: .5, heightM: 2, offsetM: -1, sillM: 0 },
    { id: "coverage-void-east", kind: "void" as const, widthM: .5, heightM: 2, offsetM: 1, sillM: 0 },
  ] };
  const plainWall = { ...createCadObject("wall"), id: "coverage-plain" };
  const source = buildIfcStep(project(wall, plainWall));
  assert.equal((source.match(/=IFCRELVOIDSELEMENT\(/g) ?? []).length, 2);
  const document = importIfcGeometry(source);
  const host = document.products.find(product => product.globalId === ifcSourceGuid(wall.id))!;
  const control = document.products.find(product => product.globalId === ifcSourceGuid(plainWall.id))!;
  assert.ok(host.meshes.length && control.meshes.length);
  const warning = "Host void/opening geometry is retained in source but not subtracted from the imported mesh.";
  const identifiedWarning = `${host.globalId} (#${host.stepId}): ${warning}`;
  assert.deepEqual(host.issues, [warning]);
  assert.deepEqual(control.issues, []);

  const coverage = inspectBimGeometry(document);
  assert.ok(coverage.findings.some(finding => finding.globalId === host.globalId && finding.status === "unsupported" && finding.message === warning));
  assert.ok(coverage.findings.some(finding => finding.globalId === control.globalId && finding.status === "pass"));
  assert.ok(ifcGeometryCoverageWarnings(document).includes(identifiedWarning));
  const obj = exportIfcMeshObj(document);
  assert.ok(obj.includes(`o ${host.globalId}\n# ${identifiedWarning}\nv `));
  assert.ok(obj.includes(`o ${control.globalId}\nv `));
  assert.equal((obj.match(/^f /gm) ?? []).length, document.products.flatMap(product => product.meshes).reduce((count, mesh) => count + mesh.triangles.length / 3, 0));
  assert.equal(exportIfcRoundTrip(document), source);

  const crowdedCoverage = ifcGeometryCoverageWarnings({ ...document, issues: Array.from({ length: 100 }, (_, index) => `Synthetic issue ${index}`) });
  assert.equal(crowdedCoverage.length, 96);
  assert.ok(crowdedCoverage.includes(identifiedWarning));
  assert.match(crowdedCoverage.at(-1)!, /additional IFC geometry findings omitted/);
});

test("IFC spaces require storey decomposition and openings stay out of ordinary spatial containment", () => {
  const wall = { ...createCadObject("wall"), openings: [{ id: "space-window", kind: "window" as const, widthM: 1, heightM: 1, offsetM: 0, sillM: 1 }] };
  const ifc = buildIfcStep(project(wall));
  assert.equal(validateIfcStep(ifc).valid, true);
  const noSpaceDecomposition = ifc.split("\n").filter(line => !line.includes("'Storey space'")).join("\n");
  assert.ok(validateIfcStep(noSpaceDecomposition).issues.some(issue => issue.code === "space-decomposition"));
  const openingId = ifc.match(/^#(\d+)=IFCOPENINGELEMENT\(/m)![1];
  const containedOpening = ifc.replace(/(=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^\n]*,\()([^)]*)(\),#\d+\);)/, `$1$2,#${openingId}$3`);
  assert.notEqual(containedOpening, ifc, "Fixture must add the opening to an existing containment relation");
  assert.ok(validateIfcStep(containedOpening).issues.some(issue => issue.code === "opening-containment"));
});

test("snapping rejects polygon cutouts, wall voids, and invented 2D bounding-box faces", () => {
  const slab = { ...footprint(), rotationDeg: 0 };
  assert.equal(resolveCadSnap({ x: 1.5, y: .2, z: 1 }, project(slab), { kinds: ["face", "edge", "endpoint"], toleranceM: .01 }), null);
  const face = resolveCadSnap({ x: -1, y: .201, z: 1 }, project(slab), { kinds: ["face"], toleranceM: .01 });
  assert.equal(face?.kind, "face"); close(face!.point.y, .2);
  const wall = { ...createCadObject("wall"), openings: [{ id: "window", kind: "window" as const, widthM: 1, heightM: 1, offsetM: 0, sillM: 1 }] };
  assert.equal(resolveCadSnap({ x: 0, y: 1.5, z: .1 }, project(wall), { kinds: ["face"], toleranceM: .01 }), null);
  const line = createCadObject("line");
  assert.equal(resolveCadSnap({ x: 0, y: .01, z: .5 }, project(line), { kinds: ["edge", "face", "endpoint"], toleranceM: .01 }), null);
  const circular = { ...createCadObject("circle"), w: 2 };
  const edge = resolveCadSnap({ x: .7071, y: .01, z: .7071 }, project(circular), { kinds: ["edge"], toleranceM: .01 });
  close(Math.hypot(edge!.point.x, edge!.point.z), 1);
});
