import assert from "node:assert/strict";
import test from "node:test";
import type { Mesh } from "three";
import { defaultDesign, type AssistantAction } from "../src/types";
import {
  amenityFootprint, defaultCommunity, defaultUnderground, makeAmenity, undergroundParkingBayLayout,
} from "../src/lib/community";
import { applyCommunityAssistantActions, previewAssistantActions } from "../src/lib/assistant";
import { buildBimExchange } from "../src/lib/bim";
import { documentationInventory } from "../src/lib/documentationSchedule";
import { buildNotesText } from "../src/lib/notes";
import { computeTakeoff } from "../src/lib/takeoff";

function parkingFixture() {
  const design = defaultCommunity("residential");
  design.land = { width: 100, depth: 100, unit: "m" };
  design.parking = {
    mode: "underground", surfaceBays: 0,
    underground: { ...defaultUnderground(), parkingWidthM: 20, parkingLengthM: 20, bayCols: 10, bayRows: 10 },
  };
  return design;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should be near ${expected}`);
}

test("parking capacity in takeoff and exchange counts the clipped modeled layout", () => {
  const community = parkingFixture();
  assert.equal(undergroundParkingBayLayout(community).capacity, 18);
  assert.equal(computeTakeoff(community).summary.parkingBays, 18);
  const json = JSON.parse(buildBimExchange({ ...defaultDesign(), community }));
  assert.equal(json.entities.find((item: { type: string }) => item.type === "PARKING_STRUCTURE")?.properties.modeledBays, 18);
  assert.match(buildNotesText({ projectName: "Test", design: community }), /Parking bays\s+\.+\s+18/);

  community.land.width = 1;
  assert.equal(computeTakeoff(community).summary.parkingBays, 0);
});

test("3D ramp starts on the basement slab, ends at site grade and slopes along travel", async () => {
  const { Box3 } = await import("three");
  const { buildCommunityScene } = await import("../src/editor/CommunityScene");
  const community = parkingFixture();
  const scene = buildCommunityScene(community);
  assert.equal(scene.getObjectsByProperty("name", "basement-parking-bay").length, 18);
  const ramp = scene.getObjectByName("basement-entry-ramp") as Mesh;
  const slab = scene.getObjectByName("basement-floor-1");
  assert.ok(ramp?.isMesh && slab);
  scene.updateMatrixWorld(true);
  const rampBounds = new Box3().setFromObject(ramp);
  const slabBounds = new Box3().setFromObject(slab);
  const vertices = ramp.geometry.getAttribute("position");
  const topAt = (x: number) => Math.max(
    ...Array.from({ length: vertices.count }, (_, index) => index)
      .filter((index) => Math.abs(vertices.getX(index) + ramp.position.x - x) < 1e-6)
      .map((index) => vertices.getY(index) + ramp.position.y),
  );
  near(rampBounds.min.x, slabBounds.max.x);
  near(topAt(rampBounds.min.x), slabBounds.max.y);
  near(topAt(rampBounds.max.x), 0);
  near((topAt(rampBounds.max.x) - topAt(rampBounds.min.x)) / (rampBounds.max.x - rampBounds.min.x), 0.12);
});

test("legacy circle footprint stays at its visible diameter and schedules the circular area", async () => {
  const community = defaultCommunity("residential");
  const circle = { ...makeAmenity("circle-platform", 0, 0), w: 16, d: 8 };
  community.amenities = [circle];
  const selected = documentationInventory({ ...defaultDesign(), community }).find((item) => item.id === circle.id);
  assert.equal(selected?.values["diameter m"], 8);
  assert.equal(selected?.values["width m"], 8);
  assert.equal(selected?.values["depth m"], 8);
  assert.equal(selected?.values["area m2"], Math.PI * 16);
  assert.deepEqual([circle.w, circle.d], [16, 8], "reading an older project does not rewrite its geometry");
  const edit = { type: "update_amenity", amenityId: circle.id, patch: { w: 10 } } as const;
  const updated = applyCommunityAssistantActions([edit], community, community.branch);
  assert.deepEqual(amenityFootprint(updated.design.amenities[0]), { w: 10, d: 10, diameter: 10, area: Math.PI * 25 });
  assert.deepEqual([updated.design.amenities[0].w, updated.design.amenities[0].d], [10, 10]);
});

test("hotel and resort assistant actions follow the same amenity availability as their catalogs", () => {
  const pool: AssistantAction = { type: "add_amenity", kind: "swimming-pool", x: 5, z: 7 };
  const office = defaultCommunity("commercial");
  assert.equal(previewAssistantActions([pool], office, "commercial")[0].applicable, false);
  for (const commercialStyle of ["hotel", "resort"] as const) {
    const design = { ...office, commercialStyle };
    assert.equal(previewAssistantActions([pool], design, "commercial")[0].applicable, true);
    const result = applyCommunityAssistantActions([pool], design, "commercial");
    assert.equal(result.design.amenities[0]?.kind, "swimming-pool");
  }
});
