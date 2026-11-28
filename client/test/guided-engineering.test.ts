import { strict as assert } from "node:assert";
import { test } from "node:test";
import { civilInputErrorMessage, engineeringResultSummary, guidedEngineeringFields, updateGuidedEngineeringNumber } from "../src/lib/guidedEngineering.ts";
import { defaultCommunity, defaultTower, defaultUnderground } from "../src/lib/community.ts";
import { buildMepMachineReport, buildMepReport, makeMepElement, mepPlanningSummary, normalizeMep } from "../src/lib/mep.ts";
import { analyzeMepNetwork } from "../src/lib/mepNetwork.ts";
import { analyzeCommunity } from "../src/lib/structural.ts";
import { buildStructuralFrameModel } from "../src/lib/structuralEngine.ts";
import { createCadObject } from "../src/lib/cadModel.ts";
import { analyzeAdvancedCivil, type AdvancedAlignment } from "../src/lib/civilAlignment.ts";
import { computeTakeoff } from "../src/lib/takeoff.ts";
import type { DraftElement } from "../src/types.ts";

const water = JSON.stringify({ version: 1, medium: "water", densityKgM3: 998.2, kinematicViscosityM2s: 1e-6, sourceNotes: { reviewedBy: "test reviewer", keep: true }, nodes: [{ id: "source", elevationM: 2, fixedPotential: 45, demandM3s: 0 }, { id: "terminal", elevationM: 5, demandM3s: 0.002, minimumPressure: 15 }], links: [{ id: "pipe", from: "source", to: "terminal", lengthM: 80, diameterM: .05, roughnessM: .0001, minorLossK: 3 }], unsupportedForGuide: [1, 2, 3] });
const frame = JSON.stringify({ version: 1, analysis: "p-delta", nodes: [{ id: "base", xM: 0, yM: 0, restraints: [true, true, true] }, { id: "top", xM: 0, yM: 3, restraints: [false, false, false] }], members: [{ id: "column", start: "base", end: "top", areaM2: .02, inertiaM4: .00008, elasticModulusPa: 200e9, design: { effectiveLengthFactor: 2 } }], loadCases: [{ id: "lateral", nodal: [{ node: "top", fxN: 10000, fyN: 0, mzNm: -500 }], uniform: [] }], combinations: [{ id: "service", factors: { lateral: 1 } }], customMetadata: { note: "preserve exactly" } });

test("structural frames match resolved level elevations and retain authored beams", () => {
  const design = defaultCommunity("residential");
  const ground = design.levels![0];
  const upper = { id: "upper", name: "Upper", elevation: 3.2, floorHeight: 3 };
  const column = createCadObject("column", upper);
  column.family = { ...column.family, instanceParameters: { baseOffset: .2 }, typeParameters: { height: 2.7 } };
  const beam = { ...createCadObject("beam", upper), x: 3, z: 4, rotationDeg: 90 };
  beam.family = { ...beam.family, typeParameters: { width: 2, depth: .3, height: .45 } };
  const gridBeam = { ...createCadObject("beam", upper), x: 2.5, z: 0, rotationDeg: 180 };
  gridBeam.family = { ...gridBeam.family, typeParameters: { width: 5 }, instanceParameters: { baseOffset: 3 } };
  const legacySlab = { ...createCadObject("slab"), elevationM: 4.5, family: undefined };
  const model = buildStructuralFrameModel({
    ...design,
    levels: [ground, upper],
    drafts: [column, beam, gridBeam, legacySlab],
    structuralGrid: [
      { id: "x0", axis: "x", position: 0, label: "X0", extent: 5, color: "#888888" },
      { id: "x1", axis: "x", position: 5, label: "X1", extent: 5, color: "#888888" },
      { id: "z0", axis: "z", position: 0, label: "Z0", extent: 5, color: "#888888" },
      { id: "z1", axis: "z", position: 5, label: "Z1", extent: 5, color: "#888888" },
    ],
  });
  const node = (id: string) => model.nodes.find(item => item.id === id)!;
  const authoredColumn = model.members.find(item => item.sourceId === column.id)!;
  assert(Math.abs(node(authoredColumn.startNodeId).y - 3.4) < 1e-9);
  assert(Math.abs(node(authoredColumn.endNodeId!).y - 6.1) < 1e-9);
  const authoredBeam = model.members.find(item => item.sourceId === beam.id)!;
  assert.equal(authoredBeam.kind, "beam");
  assert.deepEqual([authoredBeam.lengthM, authoredBeam.widthM, authoredBeam.depthM], [2, .3, .45]);
  const start = node(authoredBeam.startNodeId), end = node(authoredBeam.endNodeId!);
  assert.deepEqual([start.x, start.y, start.z], [3, 3.2, 5]);
  assert.deepEqual([end.x, end.y, end.z], [3, 3.2, 3]);
  const inferredUpper = model.members.filter(item => item.kind === "beam" && item.levelId === upper.id && !item.sourceId);
  assert.equal(inferredUpper.length, 3);
  assert(!inferredUpper.some(item => item.id === "beam-x-upper-x0-x1-z0"));
  assert(model.members.some(item => item.kind === "beam" && item.sourceId === gridBeam.id));
  assert(model.members.some(item => item.kind === "beam" && item.levelId === ground.id));
  assert.equal(node(model.members.find(item => item.sourceId === legacySlab.id)!.startNodeId).y, 4.5);
});

test("civil cross sections find daylight between the last regular sample and the search limit", () => {
  const alignment: AdvancedAlignment = {
    name: "Flat terrain fill", origin: { x: 0, z: 0 }, headingDeg: 0, startElevationM: 2.25, startGradePct: 0,
    horizontal: [{ kind: "line", lengthM: 10 }], vertical: [], superelevation: [],
    widthM: 4, crownPct: 0, sideSlopeRatio: 2, stationIntervalM: 5, crossSectionIntervalM: 2, maxDaylightM: 5,
  };
  const surface = {
    points: [[-20, -20], [20, -20], [20, 20], [-20, 20]].map(([x, z]) => ({ x, z, elevationM: 0 })),
    triangles: [[0, 1, 2], [0, 2, 3]], warnings: [],
  };
  const study = analyzeAdvancedCivil(alignment, surface);
  assert.equal(study.quantifiedLengthM, 10);
  assert.equal(study.cutM3, 0);
  assert(Math.abs(study.fillM3 - 191.25) < 1e-6);
  for (const section of study.sections) {
    assert.equal(section.complete, true);
    assert(Math.abs(section.points[0].offsetM + 6.5) < 1e-6);
    assert(Math.abs(section.points.at(-1)!.offsetM - 6.5) < 1e-6);
  }
  const atLimit = analyzeAdvancedCivil({ ...alignment, startElevationM: 2.5 }, surface);
  assert.equal(atLimit.quantifiedLengthM, 10);
  assert.equal(atLimit.sections[0].points.at(-1)!.offsetM, 7);
});

test("hydraulic display units translate mm, L/s and viscosity back into SI", () => {
  const guide = guidedEngineeringFields(water, "water");
  const diameter = guide.fields.find(field => field.path.join(".") === "links.0.diameterM")!;
  const demand = guide.fields.find(field => field.path.join(".") === "nodes.1.demandM3s")!;
  const viscosity = guide.fields.find(field => field.path.join(".") === "kinematicViscosityM2s")!;
  assert.equal(diameter.unit, "mm"); assert.equal(diameter.value * diameter.multiplier, 50);
  assert.equal(demand.unit, "L/s"); assert.equal(demand.value * demand.multiplier, 2);
  assert.equal(viscosity.value * viscosity.multiplier, 1);
  const changed = JSON.parse(updateGuidedEngineeringNumber(water, "water", diameter.path, 75));
  assert.equal(changed.links[0].diameterM, .075);
  assert.deepEqual(changed.nodes, JSON.parse(water).nodes);
  assert.deepEqual(changed.sourceNotes, JSON.parse(water).sourceNotes);
  assert.deepEqual(changed.unsupportedForGuide, [1, 2, 3]);
});
test("structural modulus and signed loads update without inferring topology or criteria", () => {
  const changed = JSON.parse(updateGuidedEngineeringNumber(frame, "frame", ["members", 0, "elasticModulusPa"], 210));
  assert.equal(changed.members[0].elasticModulusPa, 210e9);
  assert.deepEqual(changed.nodes, JSON.parse(frame).nodes);
  assert.deepEqual(changed.members[0].design, { effectiveLengthFactor: 2 });
  assert.deepEqual(changed.combinations, JSON.parse(frame).combinations);
  const signed = JSON.parse(updateGuidedEngineeringNumber(frame, "frame", ["loadCases", 0, "nodal", 0, "fxN"], -20000));
  assert.equal(signed.loadCases[0].nodal[0].fxN, -20000);
});
test("invalid JSON is retained and never converted into a default example", () => {
  const source = '{"nodes": [';
  const guide = guidedEngineeringFields(source, "frame");
  assert.equal(guide.fields.length, 0); assert.ok(guide.problem);
  assert.throws(() => updateGuidedEngineeringNumber(source, "frame", ["nodes", 0, "xM"], 1), /not available/);
  assert.equal(source, '{"nodes": [');
});
test("guided fields reject non-finite, overflow, nonphysical and unlisted edits", () => {
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => updateGuidedEngineeringNumber(water, "water", ["nodes", 0, "elevationM"], value), /finite/);
  assert.throws(() => updateGuidedEngineeringNumber(frame, "frame", ["members", 0, "elasticModulusPa"], Number.MAX_VALUE), /finite/);
  assert.throws(() => updateGuidedEngineeringNumber(water, "water", ["links", 0, "diameterM"], 0), /greater than zero/);
  assert.throws(() => updateGuidedEngineeringNumber(water, "water", ["links", 0, "roughnessM"], -1), /zero or a positive/);
  assert.throws(() => updateGuidedEngineeringNumber(frame, "frame", ["nodes", 0, "restraints", 0], 1), /not available/);
  assert.throws(() => updateGuidedEngineeringNumber(frame, "frame", ["__proto__", "xM"], 1), /not available/);
});
test("guide limits rendering and never reinterprets air pressure as water head", () => {
  const large = JSON.parse(water); large.nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, elevationM: i, demandM3s: .001 }));
  const guide = guidedEngineeringFields(JSON.stringify(large), "water");
  assert.equal(guide.limited, true); assert.ok(guide.fields.length <= 240);
  assert.equal(guide.fields.some(field => field.path.join(".") === "nodes.30.elevationM"), false);
  assert.match(guidedEngineeringFields(water.replace('"water"', '"air"'), "water").problem ?? "", /water network/);
  assert.deepEqual(guidedEngineeringFields(frame, "electrical"), { fields: [], problem: null, limited: false });
});
test("result summaries show diagnostics without manufacturing successful verification", () => {
  const result = engineeringResultSummary("water", { status: "converged", iterations: 5, totalSupplyM3s: .002, totalDemandM3s: .002, maxMassResidualM3s: 1e-8 });
  assert.equal(result.find(row => row.label === "Total supply (L/s)")?.value, "2");
  assert.equal(result.some(row => /pass|verified|compliant/i.test(row.value)), false);
  const structural = engineeringResultSummary("frame", { results: [{ status: "converged", displacements: [{ uxM: .003, uyM: .004 }] }] });
  assert.equal(structural.find(row => row.label === "Maximum nodal translation (mm)")?.value, "5");
  assert.deepEqual(engineeringResultSummary("unknown", {}), []);
});
test("civil datum validation names the field and next action while preserving other errors", () => {
  assert.match(civilInputErrorMessage(new Error("Invalid bounded unchanged vertical datum.")), /Enter the unchanged vertical datum.*coordinate reference declaration/);
  assert.equal(civilInputErrorMessage(new Error("Triangle budget exceeded")), "Triangle budget exceeded");
});

test("unrelated drafted columns cannot reduce the preliminary building load screen", () => {
  const community = defaultCommunity("residential");
  const tower = { ...defaultTower("residential", "Test tower", 0, 0), floors: 5, unitsPerFloor: 1, unitWidth: 20, unitDepth: 20, commonAreaPerFloor: 0 };
  const design = { ...community, towers: [tower] };
  const before = analyzeCommunity(design).results[0];
  const drafts: DraftElement[] = Array.from({ length: 16 }, (_, index) => ({
    id: `remote-${index}`, kind: "column", x: 1000 + index, z: 1000,
    w: 0.4, d: 0.4, h: 3, rotationDeg: 0, color: "#888888",
  }));
  assert.equal(before.columnCount, 4);
  assert.equal(before.checks[0].status, "warning");
  assert.equal(before.foundationPressureKPa, 875);
  assert.deepEqual(analyzeCommunity({ ...design, drafts }).results[0], before);
});

test("takeoff sums each tower facade independently", () => {
  const community = defaultCommunity("residential");
  const tower = { ...defaultTower("residential", "Tower A", -10, 0), floors: 2, floorHeight: 5, unitsPerFloor: 1, unitWidth: 10, unitDepth: 10, commonAreaPerFloor: 0 };
  const result = computeTakeoff({ ...community, towers: [tower, { ...tower, id: "tower-b", label: "Tower B", x: 10 }] });
  assert.equal(result.items.find(item => item.key === "glazing")?.qty, 224);
});

test("takeoff uses waterproofing surface area and reconciles every concrete row", () => {
  const community = defaultCommunity("residential");
  const slab: DraftElement = { id: "slab", kind: "slab", x: 0, z: 0, w: 5, d: 4, h: 0.2, rotationDeg: 0, color: "#888888" };
  const result = computeTakeoff({
    ...community,
    land: { ...community.land, width: 40, depth: 40 },
    parking: { ...community.parking, mode: "underground", underground: { ...defaultUnderground(), parkingWidthM: 20, parkingLengthM: 20 } },
    drafts: [slab],
  });
  const quantity = (key: string) => result.items.find(item => item.key === key)?.qty;
  assert.equal(quantity("waterproofing"), 874.48);
  assert.equal(quantity("drafted-structural"), 4);
  assert.equal(quantity("ramp"), 36.75);
  const concreteRows = result.items.filter(item => item.group === "Concrete");
  assert.equal(result.summary.concreteM3, Number(concreteRows.reduce((sum, item) => sum + item.qty, 0).toFixed(2)));
  assert.equal(quantity("formwork"), Number((result.summary.concreteM3 * 8).toFixed(2)));
});

test("MEP screens use authored loads regardless of visibility and separate air and water losses", () => {
  const equipment = { ...makeMepElement("equipment"), ratedPowerKw: 10 };
  const control = { ...makeMepElement("fixture"), ratedPowerKw: 3 };
  const duct = { ...makeMepElement("duct"), route: [{ x: 0, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }] };
  const pipe = { ...makeMepElement("pipe"), route: [{ x: 0, y: 1, z: 0 }, { x: 100, y: 1, z: 0 }], visible: false };
  const modeled = { ...normalizeMep(undefined), elements: [equipment, control, duct] };
  const hidden = { ...modeled, elements: [{ ...equipment, visible: false }, control, duct, pipe] };
  const before = mepPlanningSummary(modeled);
  const after = mepPlanningSummary(hidden);
  assert.equal(before.demandLoadKw, 8);
  assert.equal(after.demandLoadKw, analyzeMepNetwork(hidden).electrical.demandKw);
  assert.equal(after.demandLoadKw, before.demandLoadKw);
  assert.equal(after.ductPressureLossPa, before.ductPressureLossPa);
  assert.equal(after.ductPressureLossPa, 20);
  assert.equal(after.pipePressureLossPa, 450);
  assert.match(buildMepReport(hidden), /^Ducts:.*20 Pa route loss screen$/m);
  assert.match(buildMepReport(hidden), /^Pipes:.*450 Pa route loss screen$/m);
  assert.equal(buildMepMachineReport(hidden).capacity.ductPressureLossPa, 20);
  assert.equal(buildMepMachineReport(hidden).capacity.pipePressureLossPa, 450);
});
