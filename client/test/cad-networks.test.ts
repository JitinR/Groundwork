import test from "node:test";
import assert from "node:assert/strict";
import { defaultDesign } from "../src/types";
import { addCadNetworkElement, assessCadCircuit, assessCadGravity, assessCadWater, cadMep, cadNetworkFingerprint, cadNetworkIssues, cadNetworkQuantities, cadNetworkState, cadPorts, connectCadPorts, disconnectCadPorts, insertCadRouteBend, removeCadNetworkElement, removeCadRouteBend, setCadMep, traceCadNetwork, updateCadRoutePoint, validateCadNetworks, type CadCircuit } from "../src/lib/cadNetworks";

function electricalFixture() {
  let design = defaultDesign();
  const panel = addCadNetworkElement(design, "panel", "electrical", { x: 0, y: 1, z: 0 }); design = panel.design;
  const cable = addCadNetworkElement(design, "cable", "electrical", { x: 0, y: 1, z: 0 }, { end: { x: 10, y: 1, z: 0 } }); design = cable.design;
  const lamp = addCadNetworkElement(design, "light", "electrical", { x: 10, y: 1, z: 0 }); design = lamp.design;
  design = connectCadPorts(design, `${panel.element.id}:start`, `${cable.element.id}:start`);
  design = connectCadPorts(design, `${cable.element.id}:end`, `${lamp.element.id}:start`);
  design = setCadMep(design, { ...cadMep(design), elements: cadMep(design).elements.map(item => item.id === lamp.element.id ? { ...item, ratedPowerKw: 1.2 } : item) });
  const circuit: CadCircuit = { id: "circuit-fixture", name: "Light L1", panelId: panel.element.id, deviceIds: [lamp.element.id], cableIds: [cable.element.id], basis: "Explicit synthetic 230V single phase criterion fixture", inputs: { voltageV: 230, phases: 1, demandFactor: 1, powerFactor: 1, conductorResistanceOhmPerM: .01, conductorReactanceOhmPerM: 0, sourceResistanceOhm: .1, sourceReactanceOhm: 0, earthLoopResistanceOhm: .5, earthLoopReactanceOhm: 0, minimumVoltageFactor: .95, maximumVoltageFactor: 1.1, cableAmpacityA: 32, cableDeratingFactor: 1, breakerRatingA: 16, breakerBreakingCapacityA: 10000, instantaneousPickupA: 50, requiredDisconnectSeconds: .4, suppliedTripSecondsAtMinimumFault: .1, suppliedLetThroughA2sAtMaximumFault: 1000, conductorAreaMm2: 2.5, adiabaticK: 115, maximumVoltageDropPct: 3 } };
  design = { ...design, cadNetworks: { ...cadNetworkState(design), circuits: [circuit] } };
  return { design, panel: panel.element, cable: cable.element, lamp: lamp.element };
}

test("visual crossings and coincident endpoints do not create network edges", () => {
  let design = defaultDesign();
  design = addCadNetworkElement(design, "pipe", "cold-water", { x: -1, y: 0, z: 0 }, { end: { x: 1, y: 0, z: 0 } }).design;
  design = addCadNetworkElement(design, "pipe", "cold-water", { x: 0, y: 0, z: -1 }, { end: { x: 0, y: 0, z: 1 } }).design;
  assert.equal(cadNetworkState(design).connections.length, 0);
  assert.equal(traceCadNetwork(design, cadMep(design).elements[0].id).length, 1);
  assert.equal(cadNetworkIssues(design).filter(issue => issue.kind === "open").length, 4);
});
test("cross-system and conductor-containment links are rejected", () => {
  let design = defaultDesign();
  const cold = addCadNetworkElement(design, "pipe", "cold-water", { x: 0, y: 0, z: 0 }, { end: { x: 2, y: 0, z: 0 } }); design = cold.design;
  const hot = addCadNetworkElement(design, "fixture", "hot-water", { x: 0, y: 0, z: 0 }); design = hot.design;
  assert.throws(() => connectCadPorts(design, `${cold.element.id}:start`, `${hot.element.id}:start`), /incompatible/);
  const panel = addCadNetworkElement(design, "panel", "electrical", { x: 0, y: 0, z: 0 }); design = panel.design;
  const tray = addCadNetworkElement(design, "tray", "electrical", { x: 0, y: 0, z: 0 }, { end: { x: 2, y: 0, z: 0 } }); design = tray.design;
  assert.throws(() => connectCadPorts(design, `${panel.element.id}:start`, `${tray.element.id}:start`), /incompatible/);
});
test("physical connections trace, break on move, and require explicit align", () => {
  const fixture = electricalFixture(); const { panel, lamp, cable } = fixture;
  assert.equal(traceCadNetwork(fixture.design, panel.id, true).length, 3);
  const moved = updateCadRoutePoint(fixture.design, cable.id, 1, { x: 11, y: 1, z: 0 });
  assert.equal(cadNetworkState(moved).connections.length, 2);
  assert(cadNetworkIssues(moved).some(issue => issue.kind === "broken"));
  assert(!traceCadNetwork(moved, panel.id, true).includes(lamp.id));
  const without = disconnectCadPorts(moved, cadNetworkState(moved).connections[1].id);
  assert.throws(() => connectCadPorts(without, `${cable.id}:end`, `${lamp.id}:start`), /not coincident/);
  const aligned = connectCadPorts(without, `${cable.id}:end`, `${lamp.id}:start`, { align: true });
  assert.equal(traceCadNetwork(aligned, panel.id, true).length, 3);
});
test("route bends and element deletion preserve valid explicit topology", () => {
  const { design, cable, lamp } = electricalFixture();
  const bent = insertCadRouteBend(design, cable.id, 0);
  assert.equal(cadMep(bent).elements.find(item => item.id === cable.id)!.route.length, 3);
  const straight = removeCadRouteBend(bent, cable.id, 1);
  assert.deepEqual(cadMep(straight).elements, cadMep(design).elements);
  const removed = removeCadNetworkElement(straight, lamp.id);
  validateCadNetworks(removed);
  assert.equal(cadNetworkState(removed).connections.length, 1);
  assert.equal(cadNetworkState(removed).circuits[0].deviceIds.length, 0);
});
test("quantities and electrical loads are independent of visibility", () => {
  const { design } = electricalFixture();
  const hidden = setCadMep(design, { ...cadMep(design), elements: cadMep(design).elements.map(item => ({ ...item, visible: false })) });
  assert.deepEqual(cadNetworkQuantities(hidden), cadNetworkQuantities(design));
  assert.deepEqual(assessCadCircuit(hidden, "circuit-fixture").result, assessCadCircuit(design, "circuit-fixture").result);
  assert.equal(cadNetworkFingerprint(hidden), cadNetworkFingerprint(design));
});
test("circuit uses actual connected load and cable lengths with authored impedance", () => {
  const { design } = electricalFixture();
  const report = assessCadCircuit(design, "circuit-fixture");
  const inputs = report.inputs as { routeLengthM: number; connectedPowerW: number; conductorResistanceOhm: number };
  assert.equal(inputs.routeLengthM, 10); assert.equal(inputs.connectedPowerW, 1200); assert.equal(inputs.conductorResistanceOhm, .2);
  assert(report.method.includes("analyzeElectricalCircuit"));
});
test("missing circuit engineering inputs and missing device loads never receive defaults", () => {
  const { design, lamp } = electricalFixture();
  const incomplete = { ...design, cadNetworks: { ...cadNetworkState(design), circuits: cadNetworkState(design).circuits.map(circuit => ({ ...circuit, inputs: {} })) } };
  assert.throws(() => assessCadCircuit(incomplete, "circuit-fixture"), /resistance/);
  const missingLoad = setCadMep(design, { ...cadMep(design), elements: cadMep(design).elements.map(item => item.id === lamp.id ? { ...item, ratedPowerKw: undefined } : item) });
  assert.throws(() => assessCadCircuit(missingLoad, "circuit-fixture"), /load kW/);
});
test("network calculation fingerprint changes after geometry or engineering inputs, not after storing results", () => {
  const { design, cable } = electricalFixture(); const calculation = assessCadCircuit(design, "circuit-fixture");
  const recorded = { ...design, cadNetworks: { ...cadNetworkState(design), calculations: [calculation] } };
  assert.equal(cadNetworkFingerprint(recorded), calculation.fingerprint);
  const edited = updateCadRoutePoint(recorded, cable.id, 1, { x: 12, y: 1, z: 0 });
  assert.notEqual(cadNetworkFingerprint(edited), calculation.fingerprint);
});
test("pressure water maps explicit connector topology to existing deterministic solver", () => {
  let design = defaultDesign();
  const source = addCadNetworkElement(design, "source", "cold-water", { x: 0, y: 0, z: 0 }); design = source.design;
  const pipe = addCadNetworkElement(design, "pipe", "cold-water", { x: 0, y: 0, z: 0 }, { end: { x: 10, y: 0, z: 0 }, diameterM: .025 }); design = pipe.design;
  const outlet = addCadNetworkElement(design, "outlet", "cold-water", { x: 10, y: 0, z: 0 }); design = outlet.design;
  design = connectCadPorts(design, `${source.element.id}:start`, `${pipe.element.id}:start`); design = connectCadPorts(design, `${pipe.element.id}:end`, `${outlet.element.id}:start`);
  design = { ...design, cadNetworks: { ...cadNetworkState(design), fluidInputs: { densityKgM3: 998, kinematicViscosityM2s: 1e-6, basis: "Explicit synthetic water properties" }, equipment: cadNetworkState(design).equipment.map(item => ({ ...item, ...(item.type === "source" ? { fixedHeadM: 30 } : item.type === "outlet" ? { demandLps: .1 } : { roughnessM: .00001, minorLossK: 0 }) })) } };
  const report = assessCadWater(design, "cold-water");
  assert.equal((report.inputs as { links: unknown[] }).links.length, 1);
  assert.equal((report.result as { status: string }).status, "converged");
  assert.throws(() => assessCadWater(design, "sanitary" as "cold-water"), /Pressure analysis/);
});
test("gravity review reports invert and slope without pressure or vent claims", () => {
  let design = defaultDesign();
  const pipe = addCadNetworkElement(design, "pipe", "sanitary", { x: 0, y: 1, z: 0 }, { end: { x: 10, y: .8, z: 0 }, diameterM: .1 }); design = pipe.design;
  design = { ...design, cadNetworks: { ...cadNetworkState(design), equipment: cadNetworkState(design).equipment.map(item => ({ ...item, minimumSlopePct: 1 })) } };
  const review = assessCadGravity(design, "sanitary")[0];
  assert(Math.abs(review.slopePct! - 2) < 1e-12); assert.equal(review.invertStartM, .95); assert.equal(review.status, "satisfies-supplied-slope");
  assert.throws(() => assessCadGravity(design, "vent" as "sanitary"), /Only sanitary/);
});
test("a gravity run must meet the supplied slope on each nonvertical segment", () => {
  const pipe = addCadNetworkElement(defaultDesign(), "pipe", "sanitary", { x: 0, y: 2, z: 0 }, { end: { x: 10, y: 0, z: 0 } });
  const design = { ...pipe.design, cadNetworks: {
    ...cadNetworkState(pipe.design),
    equipment: cadNetworkState(pipe.design).equipment.map(item => ({ ...item, minimumSlopePct: 1 })),
  } };
  const study = (middleY: number) => assessCadGravity(setCadMep(design, {
    ...cadMep(design),
    elements: [{ ...pipe.element, route: [{ x: 0, y: 2, z: 0 }, { x: 10, y: middleY, z: 0 }, { x: 10, y: 0, z: 0 }] }],
  }), "sanitary")[0];
  assert.equal(study(2).slopePct, 0);
  assert.equal(study(2).status, "review");
  assert.equal(study(1.9).status, "satisfies-supplied-slope");
});
test("malformed connector metadata cannot make containment a conductor", () => {
  const { design } = electricalFixture();
  const port = cadPorts(design)[0];
  const forged = { ...design, cadNetworks: { ...cadNetworkState(design), equipment: cadNetworkState(design).equipment.map(item => item.elementId === port.elementId ? { ...item, ports: item.ports.map(value => ({ ...value, medium: "fluid" as const })) } : item) } };
  assert.throws(() => validateCadNetworks(forged), /Connector/);
});
