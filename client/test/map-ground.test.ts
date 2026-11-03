import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Box3, type Line } from "three";
import { buildMapGround } from "../src/lib/mapGround";
import type { LandSite, SiteLocation } from "../src/types";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const labels: string[] = [];
let imageRequests = 0;
Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
  constructor() { imageRequests++; throw new Error("Site references must not request external images"); }
} });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  createElement(kind: string) {
    assert.equal(kind, "canvas");
    return { width: 0, height: 0, getContext: () => ({
      clearRect() {}, beginPath() {}, roundRect() {}, fill() {},
      measureText: (text: string) => ({ width: text.length * 30 }),
      fillText: (text: string) => labels.push(text),
    }) };
  },
} });
after(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  if (originalImage) Object.defineProperty(globalThis, "Image", originalImage); else Reflect.deleteProperty(globalThis, "Image");
});

const land = { width: 40, depth: 60, unit: "m" } as LandSite;
test("site reference retains aligned local boundary geometry and discloses no imagery without provider requests", async () => {
  const location = { lat: 0, lng: 0, boundary: [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.0001 }, { lat: 0.0001, lng: 0.0001 },
  ] } as SiteLocation;
  const group = await buildMapGround(location, land);
  const line = group.getObjectByName("site-boundary-reference");
  const fill = group.getObjectByName("site-boundary-fill-reference");
  assert.ok(line && fill);
  const positions = (line as Line).geometry.getAttribute("position");
  assert.equal(positions.count, 4);
  assert.ok(Math.abs(positions.getX(1) - 11.1195) < 0.001);
  assert.ok(Math.abs(positions.getZ(2) + 11.1195) < 0.001);
  group.updateMatrixWorld(true);
  const outlineBounds = new Box3().setFromObject(line), fillBounds = new Box3().setFromObject(fill);
  for (const axis of ["x", "z"] as const) {
    assert.ok(Math.abs(outlineBounds.min[axis] - fillBounds.min[axis]) < 1e-5);
    assert.ok(Math.abs(outlineBounds.max[axis] - fillBounds.max[axis]) < 1e-5);
  }
  assert.equal(imageRequests, 0);
  assert.ok(labels.includes("0.00000, 0.00000"));
  assert.ok(labels.includes("Coordinate reference · no imagery"));
});

test("invalid reference coordinates fail closed and invalid boundary points never become geometry", async () => {
  for (const [lat, lng] of [[NaN, 0], [91, 0], [0, 181]]) {
    assert.equal((await buildMapGround({ lat, lng } as SiteLocation, land)).children.length, 0);
  }
  const group = await buildMapGround({ lat: 0, lng: 0, boundary: [{ lat: 0, lng: 0 }, { lat: 91, lng: 1 }, { lat: 1, lng: 1 }] } as SiteLocation, land);
  assert.equal(group.getObjectByName("site-boundary-reference"), undefined);
  assert.equal(imageRequests, 0);
});
