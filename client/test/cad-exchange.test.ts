import test from "node:test";
import assert from "node:assert/strict";
import { defaultDesign, type Design, type DraftElement } from "../src/types";
import { cadFootprintArea, cadQuantities, createCadObject, executeCadCommand, localCadAxis, resizeDraft, resolveCadSnap } from "../src/lib/cadModel";
import { buildDxf } from "../src/lib/dxf";
import { defaultCommunity, defaultTower, makeAmenity } from "../src/lib/community";
import { defaultInfra } from "../src/lib/infra";
import { buildBimExchange, buildBimScheduleCsv, buildIfcStep, ifcSourceGuid, validateIfcProfile, validateIfcStep } from "../src/lib/bim";
import { inspectBimGeometry } from "../src/lib/bimValidation";
import { documentationInventory, documentationScheduleCsv } from "../src/lib/documentationSchedule";
import { exportIfcMeshObj, exportIfcRoundTrip, ifcGeometryCoverageWarnings, importIfcGeometry } from "../src/lib/ifcGeometry";
import { buildBillOfMaterials, buildObjMtl } from "../src/lib/obj";
import { catalogEntry } from "../src/lib/catalog";
import { buildBoqCsv } from "../src/lib/notes";

const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const project = (...objects: DraftElement[]): Design => ({ ...defaultDesign(), drafts: objects, cad: { version: 1, revision: 7 } });

test("model CSV exports preserve literal labels, separators and typed quantities", () => {
  const design = defaultDesign();
  const customType = '- Existing "bench"';
  const furniture = { id: "bench-a", type: customType, name: '\n- Existing "bench", north', x: 0, z: 0, rotationDeg: 0, scale: 1, color: "Blue" };
  design.furniture = [furniture, { ...furniture, id: "bench-b", color: "Green" }];
  design.curtains = { enabled: true, style: "sheer", color: "Warm, white", wall: "north", heightPercent: 80, widthPercentPerPanel: 25 };

  assert.ok(buildBimScheduleCsv(design).includes(`"bench-a","FURNISHING","'\n- Existing ""bench"", north",`));
  assert.equal(buildBillOfMaterials(design), [
    "Qty,Item,Type,Size W x D x H (mm),Colours",
    `2,"'- Existing ""bench""","'- Existing ""bench""","0 x 0 x 0","Blue, Green"`,
    `1,"Curtains","sheer","wall-mounted","Warm, white"`,
    "",
  ].join("\n"));
  assert.ok(buildBoqCsv([{ group: "Furniture", label: customType, qty: 2, unit: "ea", basis: "Survey, level 1" }])
    .includes(`"Furniture","'- Existing ""bench""","2","ea","Survey, level 1"`));
  assert.ok(documentationScheduleCsv({ fields: ["Name", "Elevation m"], rows: [{ id: "bench-a", sourceIds: [], cells: [customType, -1.23456] }], sourceCount: 1, warnings: [] })
    .includes(`"'- Existing ""bench""","-1.2346"`));
});

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

test("legacy OBJ uses centered room walls, mounted furniture poses and outward faces", () => {
  const design = defaultDesign();
  design.room = { ...design.room, widthMm: 6000, depthMm: 4000, wallHeightMm: 2800 };
  design.furniture = [
    { id: "sofa-one", name: "Rotated sofa", type: "sofa", x: -900, z: 300, rotationDeg: 90, scale: 1, color: "#ff5500" },
    { id: "cooler", name: "Wall-mounted unit", type: "air-conditioner", x: 0, z: 400, rotationDeg: 0, scale: 1, color: "#ffffff", mount: "wall", mountWall: "east", mountHeightM: 2.1 },
  ];
  const { obj, mtl } = buildObjMtl(design, "coordination-room.mtl");
  assert.match(obj, /^mtllib coordination-room\.mtl\n/);
  assert.match(mtl, /newmtl item_sofa-o/);
  const objects = obj.split(/^o /m).slice(1).map(part => part.split("\n"));
  const getObject = (name: string) => objects.find(lines => lines[0] === name)!;
  const vertices = (name: string) => getObject(name).filter(line => line.startsWith("v ")).map(line => line.slice(2).split(" ").map(Number));
  const bounds = (name: string, axis: number) => {
    const values = vertices(name).map(point => point[axis]);
    return [Math.min(...values), Math.max(...values)];
  };
  assert.deepEqual(bounds("floor", 0), [-3, 3]);
  assert.deepEqual(bounds("floor", 2), [-2, 2]);
  assert.deepEqual(bounds("floor", 1), [-.02, 0]);
  assert.deepEqual(bounds("wall_north", 2), [1.94, 2.06]);
  assert.deepEqual(bounds("wall_east", 0), [2.94, 3.06]);
  const [minX, maxX] = bounds("item_sofa-o", 0), [minZ, maxZ] = bounds("item_sofa-o", 2);
  const sofa = catalogEntry("sofa")!;
  close((minX + maxX) / 2, -.9); close((minZ + maxZ) / 2, .3);
  close(maxX - minX, sofa.d / 1000); close(maxZ - minZ, sofa.w / 1000);
  const [wallMinX, wallMaxX] = bounds("item_cooler", 0);
  close((wallMinX + wallMaxX) / 2, 2.84);
  close(bounds("item_cooler", 1)[0], 2.1);
  const floor = vertices("floor");
  const faces = getObject("floor").filter(line => line.startsWith("f "));
  assert.equal(faces.length, 6);
  for (const face of faces) {
    const [a, b, c] = face.slice(2).split(" ").slice(0, 3).map(index => floor[Number(index) - 1]);
    const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert(normal.reduce((sum, value, i) => sum + value * (a[i] - [0, -.01, 0][i]), 0) > 0, face);
  }
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

test("community DXF uses the rotated tower footprint from the design without exporting the default room", () => {
  const community = { ...defaultCommunity("commercial"), commercialStyle: "hotel" as const };
  community.towers = [{
    ...defaultTower("commercial", "Hotel", 45, 12),
    unitsPerFloor: 4, unitWidth: 6, unitDepth: 8, commonAreaPerFloor: 25, rotY: 90,
  }];
  community.amenities = [{ ...makeAmenity("circle-platform", 20, 30), w: 16, d: 8 }];
  const entities = dxfEntities(buildDxf({ ...defaultDesign(), community }));
  const walls = entities.filter(entity => entity.values.some(([code, value]) => code === 8 && value === "WALLS"));
  assert.equal(walls.length, 1, "only the hotel contributes a wall footprint");
  const [tower] = walls;
  assert.deepEqual(tower.values.filter(([code]) => code === 10).map(([, value]) => Number(value)), [36000, 36000, 54000, 54000]);
  assert.deepEqual(tower.values.filter(([code]) => code === 20).map(([, value]) => Number(value)), [19000, 5000, 5000, 19000]);
  const circle = entities.find(entity => entity.kind === "CIRCLE");
  assert.ok(circle);
  assert.ok(circle.values.some(([code, value]) => code === 40 && Number(value) === 4000));
  assert.ok(!entities.some(entity => entity.values.some(([code, value]) => code === 8 && value === "DIMENSIONS")));
});

test("highway DXF contains the concept carriageway, median and shoulders instead of a room", () => {
  const infra = defaultInfra("highway");
  const source = buildDxf({ ...defaultDesign(), infra });
  const entities = dxfEntities(source);
  const onLayer = (name: string) => entities.filter(entity => entity.kind === "LWPOLYLINE" && entity.values.some(([code, value]) => code === 8 && value === name));
  const xCoordinates = (entity: (typeof entities)[number]) => entity.values.filter(([code]) => code === 10).map(([, value]) => Number(value));
  const zCoordinates = (entity: (typeof entities)[number]) => entity.values.filter(([code]) => code === 20).map(([, value]) => Number(value));
  assert.deepEqual(onLayer("HIGHWAY_CARRIAGEWAY").map(xCoordinates), [[-8500, -1500, -1500, -8500], [1500, 8500, 8500, 1500]]);
  assert.deepEqual(onLayer("HIGHWAY_MEDIAN").map(zCoordinates), [[-400000, -400000, 400000, 400000]]);
  assert.deepEqual(onLayer("HIGHWAY_SHOULDER").map(xCoordinates), [[-10000, -8500, -8500, -10000], [8500, 10000, 10000, 8500]]);
  assert.equal(onLayer("WALLS").length, 0);
  assert.match(source, /Straight local highway concept plan/);
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
