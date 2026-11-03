import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultCommunity } from "../src/lib/community";
import { defaultInfra } from "../src/lib/infra";
import { communityAtSite, createSiteReference, infraAtSite, siteLocationValue, siteMeasuresInUnit, siteReferenceFields, type SiteReferenceInput } from "../src/lib/siteLocation";
import { boundaryMetrics, haversine, localToLatLng, toLocalMetres } from "../src/lib/geo";
import type { SiteLocation } from "../src/types";

test("one community site replacement preserves new coordinates and measured dimensions in every display unit", () => {
  const location: SiteLocation = { lat: 0, lng: 0, boundaryWidthM: 30.48, boundaryDepthM: 60.96, boundaryRotationDeg: 27 };
  const metrics = { center: location, widthM: 30.48, depthM: 60.96, rotationDeg: 27, areaM2: 1858 };
  for (const [unit, width, depth] of [["m", 30.5, 61], ["ft", 100, 200], ["yd", 33.3, 66.7]] as const) {
    const before = { ...defaultCommunity("residential"), location: { lat: 40, lng: -74 }, land: { unit, width: 10, depth: 15 } };
    const next = communityAtSite(before, location, metrics);
    const saved = JSON.parse(JSON.stringify(next));
    assert.deepEqual(saved.location, location, "the size change must not restore the prior location");
    assert.deepEqual(saved.land, { unit, width, depth });
    assert.deepEqual(before.location, { lat: 40, lng: -74 }, "undo keeps the prior complete state");
    assert.equal(before.land.width, 10);
    assert.equal(next.towers, before.towers, "unrelated model geometry is retained");
  }
});

const measured: SiteReferenceInput = {
  latitude: "0", longitude: "0", width: "80", depth: "60", rotation: "0",
  unit: "m", shape: "rectangle", polygon: "", mode: "area",
};

test("measured corners retain actual metres and rotation at the equator and high latitudes", () => {
  for (const latitude of [0, 60, -60]) for (const rotation of [0, 35, 90]) {
    const { location, metrics } = createSiteReference({ ...measured, latitude: String(latitude), longitude: "25", rotation: String(rotation) });
    const points = location.boundary!.map((point) => toLocalMetres(point, location));
    const width = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const depth = { x: points[2].x - points[1].x, y: points[2].y - points[1].y };
    assert.ok(Math.abs(Math.hypot(width.x, width.y) - 80) < 1e-5);
    assert.ok(Math.abs(Math.hypot(depth.x, depth.y) - 60) < 1e-5);
    assert.ok(Math.abs(width.x - 80 * Math.cos(rotation * Math.PI / 180)) < 1e-5);
    assert.ok(Math.abs(width.y - 80 * Math.sin(rotation * Math.PI / 180)) < 1e-5);
    assert.ok(Math.abs(haversine(location.boundary![0], location.boundary![1]) - 80) < 0.01);
    assert.equal(metrics.areaM2, 4800);
  }
  const feet = createSiteReference({ ...measured, width: "100", depth: "200", unit: "ft" });
  assert.equal(feet.metrics.widthM, 30.48);
  assert.equal(feet.metrics.depthM, 60.96);
});

test("polygon references derive their own centre, true area and short-side orientation", () => {
  const origin = { lat: 60, lng: 25 };
  const triangle = [[0, 0], [40, 0], [0, 60]].map(([x, y]) => localToLatLng(x, y, origin));
  const result = createSiteReference({ ...measured, latitude: "10", longitude: "10", rotation: "80", shape: "polygon", polygon: triangle.map((point) => `${point.lat}, ${point.lng}`).join("\n") });
  assert.equal(result.metrics.areaM2, 1200);
  assert.notEqual(result.location.lat, 10);
  assert.notEqual(result.location.lng, 10);
  assert.equal(result.location.lat, result.metrics.center.lat);
  assert.equal(result.location.lng, result.metrics.center.lng);
  assert.notEqual(result.metrics.areaM2, Math.round(result.metrics.widthM * result.metrics.depthM));
  const rotation = 25 * Math.PI / 180;
  const rectangle = [[-40, -10], [40, -10], [40, 10], [-40, 10]].map(([x, y]) => localToLatLng(x * Math.cos(rotation) - y * Math.sin(rotation), x * Math.sin(rotation) + y * Math.cos(rotation), { lat: 0, lng: 0 }));
  const fit = boundaryMetrics(rectangle)!;
  assert.equal(fit.widthM, 20);
  assert.equal(fit.depthM, 80);
  assert.ok(Math.abs(fit.rotationDeg - 115) <= 0.1, "the short-width axis must rotate when dimensions are sorted");
});

test("invalid measured inputs reject instead of substituting defaults or returning unusable geometry", () => {
  for (const patch of [{ latitude: "" }, { latitude: "91" }, { longitude: "181" }, { width: "0" }, { depth: "-1" }, { rotation: "NaN" }, { latitude: "90" }, { longitude: "180" }]) {
    assert.throws(() => createSiteReference({ ...measured, ...patch }));
  }
  for (const polygon of ["", "0,0\n0,1", "0,0\n91,1\n1,1", "0,0\n0,0\n0,0", "0,0,extra\n0,1\n1,1"]) {
    assert.throws(() => createSiteReference({ ...measured, shape: "polygon", polygon }));
  }
});

test("corridor bearing uses compass direction of the long axis", () => {
  assert.equal(createSiteReference({ ...measured, width: "20", depth: "80", rotation: "30", mode: "route" }).location.routeBearingDeg, 150);
  assert.equal(createSiteReference({ ...measured, width: "80", depth: "20", rotation: "30", mode: "route" }).location.routeBearingDeg, 60);
  const area = createSiteReference({ ...measured, width: "1800", depth: "1000", rotation: "30" });
  assert.equal(infraAtSite(defaultInfra("airport"), area.location).airport!.runwayHeadingDeg, 60, "stored runway heading follows the measured long axis; renderer support is separate");
});

test("authored and legacy polygon corners survive reopen and reapply without becoming rectangles", () => {
  const polygon = "0,0\n0,0.0004\n0.0006,0";
  const authored = createSiteReference({ ...measured, shape: "polygon", polygon }).location;
  const saved = JSON.parse(JSON.stringify(authored)) as SiteLocation;
  assert.equal(saved.boundaryShape, "polygon");
  const fields = siteReferenceFields(saved);
  assert.equal(fields.shape, "polygon");
  assert.equal(fields.polygon.split("\n").length, 3);
  const reapplied = createSiteReference({ ...fields, mode: "area" }).location;
  assert.deepEqual(reapplied.boundary, authored.boundary);
  assert.equal(reapplied.boundaryShape, "polygon");
  const { boundaryShape: _shape, ...legacy } = saved;
  assert.equal(siteReferenceFields(legacy).shape, "polygon");
  assert.equal(siteReferenceFields(createSiteReference(measured).location).shape, "rectangle");
});

test("unit changes and prop-derived form fields preserve physical dimensions and unfinished fields", () => {
  const metres = { width: "30.48", depth: "60.96", unit: "m" as const };
  const feet = siteMeasuresInUnit(metres, "ft");
  assert.deepEqual(feet, { width: "100", depth: "200", unit: "ft" });
  assert.deepEqual(siteMeasuresInUnit(feet, "m"), metres);
  const converted = siteMeasuresInUnit(siteMeasuresInUnit({ width: "80", depth: "60", unit: "m" }, "ft"), "m");
  assert.deepEqual(converted, { width: "80", depth: "60", unit: "m" }, "reopening must not display floating point residue");
  assert.equal(siteMeasuresInUnit({ width: "", depth: "not finished", unit: "m" }, "ft").width, "");
  assert.equal(siteMeasuresInUnit({ width: "", depth: "not finished", unit: "m" }, "ft").depth, "not finished");
  const location = createSiteReference({ ...measured, width: "100", depth: "200", unit: "ft" }).location;
  assert.equal(siteReferenceFields(location, "ft").width, "100");
  assert.equal(siteReferenceFields(location, "ft").depth, "200");
  assert.equal(siteLocationValue(location), siteLocationValue({ ...location, address: "Unrelated metadata update" }));
  assert.notEqual(siteLocationValue(location), siteLocationValue({ ...location, lat: 1 }));
});

test("new references reject sub-metre extents before the model minimum can silently enlarge them", () => {
  assert.throws(() => createSiteReference({ ...measured, width: "0.5" }), /at least 1 m/);
  assert.throws(() => createSiteReference({ ...measured, depth: "3.28", unit: "ft" }), /at least 1 m/);
  for (const width of [0.5, 0.95]) {
    const tiny = [[0, 0], [width, 0], [width, 3], [0, 3]].map(([x, y]) => localToLatLng(x, y, { lat: 0, lng: 0 }));
    assert.throws(() => createSiteReference({ ...measured, shape: "polygon", polygon: tiny.map((point) => `${point.lat},${point.lng}`).join("\n") }), /at least 1 m/);
  }
  assert.equal(createSiteReference({ ...measured, width: "1", depth: "1" }).metrics.widthM, 1);
});

test("a one-metre site remains valid after conversion to feet without admitting genuinely undersized extents", () => {
  const feet = siteMeasuresInUnit({ width: "1", depth: "1", unit: "m" }, "ft");
  const { location, metrics } = createSiteReference({ ...measured, ...feet });
  assert.ok(Math.abs(metrics.widthM - 1) < 1e-8);
  assert.ok(Math.abs(metrics.depthM - 1) < 1e-8);
  assert.ok(Math.abs(haversine(location.boundary![0], location.boundary![1]) - 1) < 1e-8);
  assert.throws(() => createSiteReference({ ...measured, width: "0.9999" }), /at least 1 m/);
});

test("infrastructure fitting uses the current action's site and preserves unrelated settings", () => {
  const location: SiteLocation = { lat: 0, lng: 0, boundaryWidthM: 1000, boundaryDepthM: 1800, boundaryRotationDeg: 42, routeLengthM: 375, routeBearingDeg: 42 };
  for (const kind of ["airport", "ports", "dams", "highway"] as const) {
    const before = { ...defaultInfra(kind), location: { lat: 40, lng: -74, boundaryWidthM: 10, boundaryDepthM: 10, routeLengthM: 20 } };
    const next = infraAtSite(before, location);
    const saved = JSON.parse(JSON.stringify(next));
    assert.deepEqual(saved.location, location);
    if (kind === "airport") {
      assert.equal(saved.airport.runwayLengthM, 1800);
      assert.equal(saved.airport.runwayHeadingDeg, 42);
      assert.equal(next.airport!.runwayWidthM, before.airport!.runwayWidthM);
    } else if (kind === "ports") {
      assert.equal(saved.ports.containerYardM2, 800000);
      assert.equal(saved.ports.berths, 4);
      assert.equal(next.ports!.berthLengthM, before.ports!.berthLengthM);
    } else if (kind === "dams") {
      assert.equal(saved.dams.crestLengthM, 375);
      assert.equal(next.dams!.heightM, before.dams!.heightM);
    } else assert.equal(next.highway, before.highway);
    assert.deepEqual(before.location, { lat: 40, lng: -74, boundaryWidthM: 10, boundaryDepthM: 10, routeLengthM: 20 });
    assert.equal(next.facilities, before.facilities);
  }
});
