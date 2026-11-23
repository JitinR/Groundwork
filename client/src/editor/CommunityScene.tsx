import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { createPresentationController, type PresentationApi } from "../lib/presentation";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createAtmosphericSky, applyAtmosphere, type AtmospherePreset } from "../lib/atmosphere";
import { AtmosphereControls } from "../components/AtmosphereControls";
import { ViewportGizmo3D } from "../components/ViewportGizmo3D";
import type { CadTool } from "../components/CadToolPalette";
import type { AmenityData, BuildingLevel, CommunityDesign, DraftElement, DraftElementKind, ExteriorPanel, InteriorRoom, StructuralGridLine, TowerData, TowerOpening, VisualizationSettings } from "../types";
import { addTechnicalEdges, disposeObject3D, material, prism, prismAt } from "../lib/modelcore";
import {
  BASEMENT_RAMP_DECK_M, BASEMENT_RAMP_EDGE_HEIGHT_M, BASEMENT_RAMP_EDGE_WIDTH_M,
  amenityFootprint, amenityKind, facadeOption, landMeters, levelsForDesign, pitFootprint,
  towerMeters, undergroundDepth, undergroundParkingBayLayout, undergroundRamp,
} from "../lib/community";
import { buildMapGround } from "../lib/mapGround";
import { sectionClippingPlanes } from "../lib/section";
import { constrainDraftEnd, constrainedDraftSize, draftingSettings, snapDraftPoint, solveDraftConstraintGraph } from "../lib/drafting";
import { buildTerrainVisualization } from "../lib/terrain";
import { sceneMetricsReporter } from "../lib/sceneMetrics";
import { buildMepScene } from "../lib/mep";
import { resolveDraft, resolveTowerOpening } from "../lib/parametric";
import { familyMetadata, familyForId } from "../lib/families";
import { isSceneObjectVisible, setScenePhase, updateScenePhaseVisibility } from "../lib/phaseVisibility";

/* ---------------------------------- Builder ---------------------------------- */

function buildCustomObject(shape: string, w: number, h: number, d: number, color: string): THREE.Group {
  const g = new THREE.Group();
  switch (shape) {
    case "cylinder": {
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(w / 2, w / 2, h, 20),
        material(color, { rough: 0.7 }),
      );
      cyl.position.y = h / 2;
      cyl.castShadow = true;
      cyl.receiveShadow = true;
      g.add(cyl);
      break;
    }
    case "sphere": {
      const trunk = prism(Math.max(w * 0.12, 0.2), Math.max(h * 0.4, 0.6), Math.max(d * 0.12, 0.2), material("#6d4c41"));
      trunk.position.y = Math.max(h * 0.2, 0.3);
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 14), material(color, { rough: 0.9 }));
      canopy.scale.set(w, h * 0.7, d);
      canopy.position.y = Math.max(h * 0.4, 0.6) + h * 0.35;
      canopy.castShadow = true;
      g.add(trunk, canopy);
      break;
    }
    case "pyramid": {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 4), material(color, { rough: 0.8 }));
      cone.position.y = h / 2;
      cone.rotation.y = Math.PI / 4;
      cone.castShadow = true;
      g.add(cone);
      break;
    }
    case "lshape": {
      const base = prism(w, h, d, material(color, { rough: 0.85 }));
      base.position.y = h / 2;
      const wing = prism(w * 0.35, h * 0.7, d, material(color, { rough: 0.85 }));
      wing.position.set(-w * 0.325, h * 0.35, 0);
      g.add(base, wing);
      break;
    }
    case "frame": {
      const post = Math.max(w, d) * 0.05 + 0.08;
      const corners: [number, number][] = [
        [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2],
      ];
      for (const [cx, cz] of corners) {
        const p = prism(post, h, post, material(color));
        p.position.set(cx, h / 2, cz);
        g.add(p);
      }
      const top = prism(w + post, post * 0.8, d + post, material(color));
      top.position.y = h;
      g.add(top);
      break;
    }
    case "box":
    default: {
      const body = prism(w, h, d, material(color, { rough: 0.75 }));
      body.position.y = h / 2;
      g.add(body);
      break;
    }
  }
  return g;
}

function buildAmenityMesh(a: AmenityData): THREE.Group {
  const g = new THREE.Group();
  const k = amenityKind(a.kind);

  /* Generated objects (offline intent → object) render from their stored shape. */
  if (a.shape) {
    g.add(buildCustomObject(a.shape, a.w, a.h, a.d, a.color ?? k?.color ?? "#90a4ae"));
    g.position.set(a.x, 0, a.z);
    g.rotation.y = (a.rotY * Math.PI) / 180;
    g.userData.selectId = a.id;
    g.userData.selectKind = "amenity";
    g.userData.selW = a.w;
    g.userData.selD = a.d;
    return g;
  }

  const kk = k ?? amenityKind("lawn")!;
  const { w, d } = amenityFootprint(a);
  const mat = material(kk.color);
  switch (kk.shape) {
    case "court": {
      const slab = prism(w, Math.max(a.h, 0.08), d, mat);
      slab.position.y = Math.max(a.h, 0.08) / 2;
      g.add(slab);
      const line = prism(0.15, 0.09, d, material("#ffffff"));
      line.position.y = Math.max(a.h, 0.08) + 0.02;
      g.add(line);
      break;
    }
    case "pool": {
      const rim = prism(w + 0.6, 0.5, d + 0.6, material("#e0e0e0", { rough: 0.6 }));
      rim.position.y = 0.25;
      g.add(rim);
      const water = prism(w, Math.max(a.h, 0.8), d, material("#42a5f5", { trans: 0.75, rough: 0.2 }));
      water.position.y = 0.5;
      g.add(water);
      break;
    }
    case "green": {
      const slabH = Math.max(a.h, 0.05);
      const slab = prism(w, slabH, d, mat);
      slab.position.y = slabH / 2;
      g.add(slab);
      const trees = Math.max(2, Math.floor((w * d) / 60));
      for (let i = 0; i < trees; i++) {
        const tx = (i % 4) * 3 - w / 2 + (i % 3);
        const tz = Math.floor(i / 4) * 3 - d / 2 + (i % 2);
        const trunk = prism(0.35, 1, 0.35, material("#8d6e63"));
        trunk.position.set(tx, 0.5, tz);
        const canopy = new THREE.Mesh(
          new THREE.ConeGeometry(1.4, 1.6, 8),
          material("#388e3c", { rough: 0.9 }),
        );
        canopy.position.set(tx, 1.8, tz);
        canopy.castShadow = true;
        g.add(trunk, canopy);
      }
      break;
    }
    case "track": {
      const trackH = Math.max(a.h, 0.05);
      const base = prism(w, trackH, d, mat);
      base.position.y = trackH / 2;
      g.add(base);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.95, 48), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07;
      ring.scale.set(w / 2, d / 2, 1);
      ring.receiveShadow = true;
      g.add(ring);
      const inner = new THREE.Mesh(new THREE.RingGeometry(0, 0.7, 48), material("#c8e6c9", { rough: 0.95 }));
      inner.rotation.x = -Math.PI / 2;
      inner.position.y = 0.05;
      inner.scale.set(w / 2, d / 2, 1);
      inner.receiveShadow = true;
      g.add(inner);
      break;
    }
    case "steps": {
      const tiers = 3;
      const tierH = Math.max(a.h / tiers, 0.1);
      for (let i = 0; i < tiers; i++) {
        const s = 1 - i * 0.25;
        const tier = prism(w * s, tierH, d * s, material(i === tiers - 1 ? "#cfd8dc" : kk.color));
        tier.position.set(0, tierH / 2 + i * tierH, (i * d * 0.12) / tiers);
        g.add(tier);
      }
      break;
    }
    case "box": {
      const body = prism(w, a.h, d, mat);
      body.position.y = a.h / 2;
      g.add(body);
      const roof = prism(w + 0.4, 0.25, d + 0.4, material("#b0bec5"));
      roof.position.y = a.h + 0.12;
      g.add(roof);
      break;
    }
    case "sand": {
      const slab = prism(w, Math.max(a.h, 0.3), d, material(kk.color));
      slab.position.y = Math.max(a.h, 0.3) / 2;
      g.add(slab);
      break;
    }
    case "kids": {
      const slabH = Math.max(a.h, 0.05);
      const slab = prism(w, slabH, d, mat);
      slab.position.y = slabH / 2;
      g.add(slab);
      for (let i = 0; i < 4; i++) {
        const px = ((i % 2) * 2 - 1) * w * 0.22;
        const pz = (Math.floor(i / 2) * 2 - 1) * d * 0.22;
        const toy = prism(1.6, 1.3, 1.6, material(i % 2 ? "#ff7043" : "#ffca28", { rough: 0.6 }));
        toy.position.set(px, 0.65, pz);
        g.add(toy);
      }
      break;
    }
    case "circle": {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(w / 2, w / 2, Math.max(a.h, 0.12), 48),
        mat,
      );
      disc.position.y = Math.max(a.h, 0.12) / 2;
      disc.castShadow = true;
      disc.receiveShadow = true;
      g.add(disc);
      break;
    }
  }
  g.position.set(a.x, 0, a.z);
  g.rotation.y = (a.rotY * Math.PI) / 180;
  g.userData.selectId = a.id;
  g.userData.selectKind = "amenity";
  g.userData.selW = w;
  g.userData.selD = d;
  return g;
}

function buildDraftMesh(draft: DraftElement, levels: BuildingLevel[] = [], selected = false): THREE.Group {
  const g = new THREE.Group();
  const resolved = resolveDraft(draft, levels);
  const mat = new THREE.MeshBasicMaterial({ color: draft.color, transparent: true, opacity: 0.82, side: THREE.DoubleSide });
  if (draft.kind === "line") {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-draft.w / 2, 0.12, 0),
        new THREE.Vector3(draft.w / 2, 0.12, 0),
      ]),
      new THREE.LineBasicMaterial({ color: draft.color, linewidth: 2 }),
    );
    g.add(line);
  } else if (draft.kind === "polyline" || draft.kind === "spline") {
    const stored = draft.points?.length ? draft.points : [{ x: -draft.w / 2, z: 0 }, { x: draft.w / 2, z: 0 }];
    const source = stored.map((point) => new THREE.Vector3(point.x, 0.12, point.z));
    const points = draft.kind === "spline" && source.length >= 3
      ? new THREE.CatmullRomCurve3(source, false, "centripetal").getPoints(Math.max(24, source.length * 8))
      : source;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: draft.color }),
    );
    g.add(line);
  } else if (draft.kind === "arc") {
    const radius = Math.max(draft.radiusM ?? Math.max(draft.w, draft.d) / 2, 0.05);
    const start = ((draft.startAngleDeg ?? 0) * Math.PI) / 180;
    const end = ((draft.endAngleDeg ?? 180) * Math.PI) / 180;
    const curve = new THREE.EllipseCurve(0, 0, radius, radius, start, end, false, 0);
    const points = curve.getPoints(48).map((point) => new THREE.Vector3(point.x, 0.12, point.y));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: draft.color })));
  } else if (draft.kind === "dimension") {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-draft.w / 2, 0.16, 0),
        new THREE.Vector3(draft.w / 2, 0.16, 0),
      ]),
      new THREE.LineBasicMaterial({ color: draft.color, linewidth: 2 }),
    );
    const tickA = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.8), mat);
    const tickB = tickA.clone();
    tickA.position.set(-draft.w / 2, 0.16, 0);
    tickB.position.set(draft.w / 2, 0.16, 0);
    const label = labelSprite(`${draft.w.toFixed(2)} m`);
    label.position.set(0, 0.28, 0);
    label.scale.set(4, 1, 1);
    g.add(line, tickA, tickB, label);
  } else if (draft.kind === "circle") {
    const circle = new THREE.Mesh(new THREE.RingGeometry(Math.max(Math.min(draft.w, draft.d) / 2 - 0.12, 0.1), Math.min(draft.w, draft.d) / 2, 48), mat);
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = 0.12;
    g.add(circle);
  } else if (draft.kind === "rectangle") {
    const rectangle = new THREE.Mesh(new THREE.PlaneGeometry(draft.w, draft.d), mat);
    rectangle.rotation.x = -Math.PI / 2;
    rectangle.position.y = 0.12;
    g.add(rectangle);
  } else {
    const height = resolved.height;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(resolved.width, height, resolved.depth),
      new THREE.MeshStandardMaterial({ color: draft.color, roughness: 0.78 }),
    );
    body.position.y = resolved.elevation + height / 2;
    if ((draft.kind === "slab" || draft.kind === "roof") && resolved.slope) body.rotation.x = Math.atan(resolved.slope / 100);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
  }
  g.position.set(draft.x, 0, draft.z);
  g.rotation.y = (draft.rotationDeg * Math.PI) / 180;
  g.userData.selectId = draft.id;
  g.userData.selectKind = "draft";
  g.userData.selW = draft.w;
  g.userData.selD = draft.d;
  if (selected && draft.kind !== "line" && draft.kind !== "dimension") {
    const gripMat = new THREE.MeshBasicMaterial({ color: "#f6c453" });
    for (const [x, z] of [[-draft.w / 2, 0], [draft.w / 2, 0], [0, -draft.d / 2], [0, draft.d / 2]]) {
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.18), gripMat);
      grip.position.set(x, 0.22, z);
      grip.userData.noSelect = true;
      g.add(grip);
    }
  }
  return g;
}

function buildRoomPlanMesh(room: InteriorRoom, tower: TowerData, level: BuildingLevel): THREE.Group {
  const g = new THREE.Group();
  // Keep the plan above the solid tower so it remains legible in the site view.
  const y = level.elevation + 0.12;
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(room.w, 0.5), Math.max(room.d, 0.5)),
    new THREE.MeshBasicMaterial({ color: "#5eead4", transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = y;
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(room.w, 0.5), 0.04, Math.max(room.d, 0.5))),
    new THREE.LineBasicMaterial({ color: "#5eead4", transparent: true, opacity: 0.95 }),
  );
  outline.position.y = y + 0.02;
  g.add(fill, outline);
  const label = labelSprite(`${room.name} · F${room.floor + 1}`);
  label.position.set(0, y + 0.08, 0);
  label.scale.set(Math.max(room.w * 0.7, 3), 0.7, 1);
  g.add(label);
  g.position.set(tower.x + room.x, 0, tower.z + room.z);
  g.userData.selectId = room.id;
  g.userData.selectKind = "room";
  g.userData.selW = room.w;
  g.userData.selD = room.d;
  return g;
}

function buildStructuralGridLine(axis: StructuralGridLine, level: BuildingLevel): THREE.Group {
  const g = new THREE.Group();
  const half = Math.max(axis.extent, 1) / 2;
  const points = axis.axis === "x"
    ? [new THREE.Vector3(axis.position, level.elevation + 0.08, -half), new THREE.Vector3(axis.position, level.elevation + 0.08, half)]
    : [new THREE.Vector3(-half, level.elevation + 0.08, axis.position), new THREE.Vector3(half, level.elevation + 0.08, axis.position)];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: axis.color, transparent: true, opacity: 0.9 }),
  );
  line.userData.noSelect = true;
  const label = labelSprite(axis.label);
  label.position.copy(points[0]);
  label.position.y += 0.12;
  label.scale.set(3.5, 0.9, 1);
  g.add(line, label);
  g.userData.noSelect = true;
  return g;
}

function windowGrid(w: number, h: number, rows: number, cols: number, color: string): THREE.Group {
  const g = new THREE.Group();
  const cw = w / cols;
  const ch = h / rows;
  const m = material(color, { rough: 0.2 });
  const count = rows * cols;
  const cells = new THREE.InstancedMesh(new THREE.PlaneGeometry(cw * 0.7, ch * 0.6), m, count);
  const matrix = new THREE.Matrix4();
  let index = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    matrix.makeTranslation((c - (cols - 1) / 2) * cw, (r - (rows - 1) / 2) * ch, 0.01);
    cells.setMatrixAt(index++, matrix);
  }
  cells.instanceMatrix.needsUpdate = true;
  cells.userData.noSelect = true;
  g.add(cells);
  return g;
}

function buildExteriorPanel(p: ExteriorPanel, tower: TowerData): THREE.Group {
  const g = new THREE.Group();
  const { w: tw, d: td } = towerMeters(tower);
  const facade = facadeOption(p.material);
  const panel = prism(p.w, p.h, 0.18, material(p.color || facade.color, { rough: facade.rough, metal: facade.metal }));
  panel.position.y = 0;
  g.add(panel);
  const orient: Record<ExteriorPanel["face"], { x: number; z: number; ry: number }> = {
    front: { x: p.x, z: td / 2 + 0.12, ry: 0 },
    back: { x: p.x, z: -td / 2 - 0.12, ry: Math.PI },
    right: { x: tw / 2 + 0.12, z: p.x, ry: Math.PI / 2 },
    left: { x: -tw / 2 - 0.12, z: p.x, ry: -Math.PI / 2 },
  };
  const o = orient[p.face];
  g.position.set(o.x, p.y + p.h / 2, o.z);
  g.rotation.y = o.ry;
  g.userData.noSelect = true;
  return g;
}

function buildTowerOpening(opening: TowerOpening, tower: TowerData): THREE.Mesh {
  const { w, d } = towerMeters(tower);
  const isDoor = opening.kind === "door";
  const resolved = resolveTowerOpening(opening, opening.face === "east" || opening.face === "west" ? d : w);
  const width = Math.max(resolved.width, 0.3);
  const height = Math.max(resolved.height, 0.3);
  const floor = Math.min(Math.max(Math.round(opening.floor), 1), Math.max(tower.floors, 1));
  const sill = isDoor ? 0 : resolved.sill;
  const openingMesh = prism(
    width,
    height,
    0.12,
    material(isDoor ? "#6d4c41" : "#183b4d", { rough: isDoor ? 0.65 : 0.2, metal: isDoor ? 0.05 : 0.15 }),
  );
  const y = (floor - 1) * tower.floorHeight + sill + height / 2;
  const offset = resolved.offset;
  const faces: Record<TowerOpening["face"], { x: number; z: number; ry: number }> = {
    north: { x: offset, z: -d / 2 - 0.08, ry: 0 },
    south: { x: offset, z: d / 2 + 0.08, ry: 0 },
    east: { x: w / 2 + 0.08, z: offset, ry: Math.PI / 2 },
    west: { x: -w / 2 - 0.08, z: offset, ry: Math.PI / 2 },
  };
  const face = faces[opening.face] ?? faces.south;
  openingMesh.position.set(face.x, y, face.z);
  openingMesh.rotation.y = face.ry;
  openingMesh.userData.noSelect = true;
  return openingMesh;
}

function buildTowerMesh(t: TowerData, panels: ExteriorPanel[]): THREE.Group {
  const g = new THREE.Group();
  const { w, d, h } = towerMeters(t);
  const facade = facadeOption(t.facadeMaterial ?? "glass");
  const bodyMat = material(facade.color, {
    rough: facade.rough,
    metal: facade.metal,
    trans: facade.trans ? 0.85 : 1,
  });
  const body = prism(w, h, d, bodyMat);
  body.position.y = h / 2;
  g.add(body);

  /* Floor separators */
  for (let i = 1; i < t.floors; i++) {
    const band = prism(w + 0.06, 0.18, d + 0.06, material("#37474f"));
    band.position.y = i * t.floorHeight;
    g.add(band);
  }

  if (t.openings) {
    for (const opening of t.openings) g.add(buildTowerOpening(opening, t));
  } else {
    /* Legacy towers retain the generated facade until the user customizes openings. */
    const windows = windowGrid(w * 0.92, h * 0.9, Math.max(t.floors, 2), Math.max(3, Math.ceil(w / t.unitWidth)), "#253238");
    windows.position.set(0, h / 2, d / 2 + 0.02);
    g.add(windows);

    const dirs: Record<string, { x: number; z: number; ry: number }> = {
      north: { x: 0, z: -d / 2, ry: 0 },
      south: { x: 0, z: d / 2, ry: 0 },
      east: { x: w / 2, z: 0, ry: Math.PI / 2 },
      west: { x: -w / 2, z: 0, ry: -Math.PI / 2 },
    };
    const ent = dirs[t.doorFacing] ?? dirs.south;
    const pad = prism(3.5, 0.3, 2.5, material("#e53935", { rough: 0.6 }));
    pad.position.set(ent.x * 0.98, 0.15, ent.z * 0.98);
    pad.rotation.y = ent.ry;
    g.add(pad);
  }

  /* Per-tower exterior material panels */
  for (const p of panels) {
    if (p.towerId === t.id) g.add(buildExteriorPanel(p, t));
  }

  g.position.set(t.x, 0, t.z);
  g.rotation.y = ((t.rotY ?? 0) * Math.PI) / 180;
  g.userData.selectId = t.id;
  g.userData.selectKind = "tower";
  g.userData.selW = w;
  g.userData.selD = d;
  return g;
}

function buildSite(design: CommunityDesign, selectedId?: string | null, visualization?: VisualizationSettings): THREE.Group {
  const g = new THREE.Group();
  const layerVisible = (id: string) => design.layers?.find((layer) => layer.id === id)?.visible !== false;
  const { w: W, d: D } = landMeters(design.land);
  const halfW = W / 2;
  const halfD = D / 2;
  const levels = levelsForDesign(design);
  const activeLevelIndex = Math.max(0, levels.findIndex((level) => level.id === design.activeLevelId));
  const activeLevel = levels[activeLevelIndex] ?? levels[0];

  /* Leave an opening through the visual ground layers along the authored ramp. */
  const parking = design.parking.mode === "underground" ? design.parking.underground : undefined;
  const pit = parking ? pitFootprint(design) : undefined;
  const ramp = parking ? undergroundRamp(parking) : undefined;
  const trench = pit && ramp ? {
    minX: pit.x + pit.w / 2,
    maxX: pit.x + pit.w / 2 + ramp.length,
    minZ: pit.z - ramp.width / 2 - BASEMENT_RAMP_EDGE_WIDTH_M,
    maxZ: pit.z + ramp.width / 2 + BASEMENT_RAMP_EDGE_WIDTH_M,
  } : undefined;
  const groundLayer = (w: number, d: number, y: number, h: number, mat: THREE.Material) => {
    const add = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      if (maxX > minX && maxZ > minZ) g.add(prismAt((minX + maxX) / 2, y, (minZ + maxZ) / 2, maxX - minX, h, maxZ - minZ, mat));
    };
    const minX = Math.max(-w / 2, trench?.minX ?? w / 2);
    const maxX = Math.min(w / 2, trench?.maxX ?? -w / 2);
    const minZ = Math.max(-d / 2, trench?.minZ ?? d / 2);
    const maxZ = Math.min(d / 2, trench?.maxZ ?? -d / 2);
    if (minX >= maxX || minZ >= maxZ) {
      add(-w / 2, w / 2, -d / 2, d / 2);
      return;
    }
    add(-w / 2, minX, -d / 2, d / 2);
    add(maxX, w / 2, -d / 2, d / 2);
    add(minX, maxX, -d / 2, minZ);
    add(minX, maxX, maxZ, d / 2);
  };
  groundLayer(W, D, -0.3, 0.6, material("#6b7280", { rough: 0.95 }));
  groundLayer(W + 18, D + 18, -0.06, 0.12, material("#2e6b35", { rough: 0.85 }));
  groundLayer(W + 38, D + 38, -0.1, 0.08, material("#1e293b", { rough: 0.7 }));

  g.add(buildTerrainVisualization(W, D, design.terrain));

  /* Map overlay slot (filled asynchronously with OSM / Google map) */
  const mapSlot = new THREE.Group();
  mapSlot.name = "map-ground";
  mapSlot.userData.noSelect = true;
  g.add(mapSlot);

  /* Plot boundary frame */
  const frameMat = material("#5d4037", { rough: 0.8 });
  g.add(prismAt(0, 0.12, halfD, W, 0.24, 0.24, frameMat));
  g.add(prismAt(0, 0.12, -halfD, W, 0.24, 0.24, frameMat));
  g.add(prismAt(halfW, 0.12, 0, 0.24, 0.24, D, frameMat));
  g.add(prismAt(-halfW, 0.12, 0, 0.24, 0.24, D, frameMat));

  /* Parking */
  const park = design.parking;
  if (park.mode === "underground" && park.underground) {
    g.add(buildUnderground(design));
  } else if (park.mode === "surface" && park.surfaceBays > 0) {
    const bays = Math.min(Math.max(park.surfaceBays, 0), 300);
    const bayW = 2.5;
    const bayD = 5;
    const perRow = 8;
    const bayGeometry = new THREE.BoxGeometry(bayW * 0.8, 0.08, bayD * 0.9);
    const bayMeshes = [
      new THREE.InstancedMesh(bayGeometry, material("#90a4ae"), Math.ceil(bays / 2)),
      new THREE.InstancedMesh(bayGeometry, material("#b0bec5"), Math.floor(bays / 2)),
    ];
    const matrix = new THREE.Matrix4();
    let counts = [0, 0];
    for (let i = 0; i < bays; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const type = i % 2;
      matrix.compose(new THREE.Vector3(-halfW + 3 + col * (bayW + 0.6), 0.04, halfD - 3 - row * (bayD + 0.8)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1));
      bayMeshes[type].setMatrixAt(counts[type]++, matrix);
    }
    for (const baysMesh of bayMeshes) { baysMesh.instanceMatrix.needsUpdate = true; baysMesh.userData.noSelect = true; g.add(baysMesh); }
  }

  /* Amenities on the ground floor */
  if (layerVisible("site")) {
    for (const a of design.amenities) {
       try {
         const node = buildAmenityMesh(a);
         setScenePhase(node, a.phaseId, visualization);
         g.add(node);
      } catch {
        /* skip */
      }
    }
  }

  if (layerVisible("drafting")) for (const draft of design.drafts ?? []) {
    const node = buildDraftMesh(draft, levels, draft.id === selectedId);
    setScenePhase(node, draft.phaseId, visualization);
    g.add(node);
  }
  if (layerVisible("mep")) g.add(buildMepScene(design.mep, visualization));

  if (activeLevel) {
    for (const axis of design.structuralGrid ?? []) g.add(buildStructuralGridLine(axis, activeLevel));
  }

  if (layerVisible("interiors")) {
    for (const room of design.interiors) {
      const tower = design.towers.find((candidate) => candidate.id === room.towerId);
       if (tower && room.floor === activeLevelIndex) {
         const node = buildRoomPlanMesh(room, tower, activeLevel);
         setScenePhase(node, room.phaseId, visualization);
         g.add(node);
       }
    }
  }

  /* Towers */
  if (layerVisible("buildings")) {
    for (const t of design.towers) {
        const detailed = buildTowerMesh(t, design.exteriors);
        const { w, h, d } = towerMeters(t);
        const node = new THREE.LOD();
        // Both detail levels share one world transform and one distance origin.
        node.position.copy(detailed.position);
        node.rotation.copy(detailed.rotation);
        detailed.position.set(0, 0, 0);
        detailed.rotation.set(0, 0, 0);
        delete detailed.userData.selectId;
        node.addLevel(detailed, 0);
        // Keep distant communities cheap while retaining the detailed node for picking up close.
        const proxy = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          material(facadeOption(t.facadeMaterial ?? "glass").color, { rough: 0.9 }),
        );
        proxy.position.y = h / 2;
        proxy.userData.noTechnicalEdges = true;
        node.addLevel(proxy, Math.max(60, Math.max(w, d) * 4));
        node.userData.selectId = t.id;
        node.userData.selectKind = "tower";
        node.userData.selW = w;
        node.userData.selD = d;
        setScenePhase(node, t.phaseId, visualization);
        g.add(node);
    }
  }

  /* Tower labels */
  if (layerVisible("buildings")) {
    for (const t of design.towers) {
      const lbl = labelSprite(t.label);
      const { d: td } = towerMeters(t);
      lbl.position.set(t.x, towerMeters(t).h + 2.2, t.z + td / 2 + 1.5);
      setScenePhase(lbl, t.phaseId, visualization);
      g.add(lbl);
    }
  }

  g.userData.noSelect = true;
  return g;
}

function buildUnderground(design: CommunityDesign): THREE.Group {
  const g = new THREE.Group();
  const ug = design.parking.underground!;

  const pit = pitFootprint(design);
  const depth = undergroundDepth(ug);
  const layout = undergroundParkingBayLayout(design);
  const ramp = undergroundRamp(ug);
  const rampStartX = pit.x + pit.w / 2;
  const openingHalfWidth = Math.min(pit.d / 2, ramp.width / 2 + BASEMENT_RAMP_EDGE_WIDTH_M);
  const soilMat = material("#8d6e63", { rough: 1 });

  /* Pit side walls (the excavated earth) */
  g.add(prismAt(pit.x, -depth / 2, pit.z - pit.d / 2, pit.w + 1.2, depth, 1.2, soilMat));
  g.add(prismAt(pit.x, -depth / 2, pit.z + pit.d / 2, pit.w + 1.2, depth, 1.2, soilMat));
  g.add(prismAt(pit.x - pit.w / 2, -depth / 2, pit.z, 1.2, depth, pit.d, soilMat));
  const flankingWallDepth = pit.d / 2 - openingHalfWidth;
  if (flankingWallDepth > 0) {
    for (const side of [-1, 1]) {
      const wallZ = pit.z + side * (openingHalfWidth + flankingWallDepth / 2);
      g.add(prismAt(rampStartX, -depth / 2, wallZ, 1.2, depth, flankingWallDepth, soilMat));
    }
  }
  if (depth > ramp.rise) {
    const sillDepth = depth - ramp.rise;
    g.add(prismAt(rampStartX, -ramp.rise - sillDepth / 2, pit.z, 1.2, sillDepth, openingHalfWidth * 2, soilMat));
  }

  /* Basement floor slabs, one per level */
  for (let i = 0; i < layout.levels; i++) {
    const topY = -(ramp.rise + i * ug.floorHeight);
    const wallHeight = i === 0 ? ramp.rise : ug.floorHeight - 0.3;
    const slab = prism(pit.w, 0.3, pit.d, material("#9e9e9e", { rough: 0.8 }));
    slab.name = "basement-floor-" + (i + 1);
    slab.position.set(pit.x, topY - 0.15, pit.z);
    g.add(slab);

    /* Pillars */
    const pxStart = pit.x - pit.w / 2 + ug.pillarSpacingX * 0.5;
    const pzStart = pit.z - pit.d / 2 + ug.pillarSpacingZ * 0.5;
    const pw = 0.5;
    for (let px = pxStart; px <= pit.x + pit.w / 2 - ug.pillarSpacingX * 0.5; px += ug.pillarSpacingX) {
      for (let pz = pzStart; pz <= pit.z + pit.d / 2 - ug.pillarSpacingZ * 0.5; pz += ug.pillarSpacingZ) {
        const col = prism(pw, wallHeight, pw, material("#cfd8dc", { rough: 0.7 }));
        col.position.set(px, topY + wallHeight / 2, pz);
        g.add(col);
      }
    }

    /* Car parking bays */
    const bayDrawW = ug.bayWidth;
    const bayDrawD = ug.bayLength;
    const carMat = material("#4fc3f7", { trans: 0.55, rough: 0.4 });
    const bxStart = pit.x - ((layout.cols - 1) * layout.pitchX) / 2;
    const bzStart = pit.z - ((layout.rows - 1) * layout.pitchZ) / 2;
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const bay = prism(bayDrawW * 0.9, 0.1, bayDrawD * 0.95, carMat);
        bay.name = "basement-parking-bay";
        bay.position.set(bxStart + c * layout.pitchX, topY + 0.05, bzStart + r * layout.pitchZ);
        g.add(bay);
      }
    }

    /* Lift lobby (centred on one side) */
    if (ug.liftLobby) {
      const lobby = prism(4, wallHeight, 3, material("#eceff1", { rough: 0.6 }));
      lobby.position.set(pit.x, topY + wallHeight / 2, pit.z + pit.d / 2 - 2);
      g.add(lobby);
      const liftHeight = Math.max(0.1, wallHeight - 0.2);
      const lift = prism(2.4, liftHeight, 2, material("#455a64", { metal: 0.5, rough: 0.4 }));
      lift.position.set(pit.x, topY + liftHeight / 2, pit.z + pit.d / 2 - 2.2);
      g.add(lift);
    }

    /* Stair lobby (opposite side) */
    if (ug.stairLobby) {
      const lobby = prism(3.4, wallHeight, 3.4, material("#f5f5f5", { rough: 0.6 }));
      lobby.position.set(pit.x, topY + wallHeight / 2, pit.z - pit.d / 2 + 2.4);
      g.add(lobby);
    }
  }

  // Shear each box along the travel axis so both end faces stay vertical and meet their landings.
  const rampPart = (width: number, height: number, offsetZ: number, topOffset: number, mat: THREE.Material) => {
    const mesh = prism(ramp.length, height, width, mat);
    const positions = mesh.geometry.getAttribute("position");
    for (let vertex = 0; vertex < positions.count; vertex++) {
      positions.setY(vertex, positions.getY(vertex) + positions.getX(vertex) * ramp.rise / ramp.length);
    }
    positions.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.position.set(rampStartX + ramp.length / 2, -ramp.rise / 2 + topOffset - height / 2, pit.z + offsetZ);
    return mesh;
  };
  const deck = rampPart(ramp.width, BASEMENT_RAMP_DECK_M, 0, 0, material("#bdbdbd", { rough: 0.7 }));
  deck.name = "basement-entry-ramp";
  g.add(deck);
  for (const side of [-1, 1]) {
    const edgeOffset = side * (ramp.width / 2 + BASEMENT_RAMP_EDGE_WIDTH_M / 2);
    g.add(rampPart(BASEMENT_RAMP_EDGE_WIDTH_M, BASEMENT_RAMP_EDGE_HEIGHT_M, edgeOffset, BASEMENT_RAMP_EDGE_HEIGHT_M, soilMat));
  }

  return g;
}

let labelCanvas: HTMLCanvasElement | null = null;
function labelSprite(text: string): THREE.Sprite {
  if (!labelCanvas) labelCanvas = document.createElement("canvas");
  const cv = labelCanvas;
  cv.width = 512;
  cv.height = 128;
  const ctx = cv.getContext("2d")!;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(15,23,42,0.82)";
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 112, 16);
  ctx.fill();
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cv.width / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(14, 3.5, 1);
  sprite.userData.noSelect = true;
  return sprite;
}

function selectionRing(w: number, d: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.78, 4),
    new THREE.MeshBasicMaterial({ color: "#34d399", transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  const r = Math.max(w, d) * 0.62;
  ring.scale.set(r, r, 1);
  ring.position.y = 0.3;
  ring.userData.noSelect = true;
  ring.userData.selectionRing = true;
  return ring;
}

export function buildCommunityScene(design: CommunityDesign, selectedId?: string | null, visualization?: VisualizationSettings): THREE.Group {
  const g = buildSite(design, selectedId, visualization);
  addTechnicalEdges(g, "#263746", 0.58);
  if (selectedId) {
    const target = g.children.find((c) => c.userData?.selectId === selectedId);
    if (target) {
      const w = (target.userData.selW as number) ?? 10;
      const d = (target.userData.selD as number) ?? 10;
      target.add(selectionRing(w, d));
    }
  }
  return g;
}

function updateCommunitySelection(root: THREE.Object3D, selectedId: string | null | undefined): void {
  const previous: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object.userData.selectionRing) previous.push(object);
  });
  for (const ring of previous) { disposeObject3D(ring, false); ring.removeFromParent(); }
  if (!selectedId) return;
  const targets: THREE.Object3D[] = [];
  root.traverse(object => { if (!targets.length && object.userData.selectId === selectedId) targets.push(object); });
  const target = targets[0];
  if (!target) return;
  const w = (target.userData.selW as number) ?? 10;
  const d = (target.userData.selD as number) ?? 10;
  const ring = selectionRing(w, d);
  ring.userData.selectionRing = true;
  target.add(ring);
}

/* --------------------------------- Component --------------------------------- */

export interface SceneContextTarget {
  kind: "tower" | "amenity" | "draft" | "room" | "ground";
  id?: string;
  x: number;
  z: number;
  clientX: number;
  clientY: number;
}

interface CommunitySceneProps {
  design: CommunityDesign;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (next: CommunityDesign) => void;
  onContextTarget?: (target: SceneContextTarget) => void;
  activeTool?: CadTool;
  visualization?: VisualizationSettings;
  onPresentationReady?: (api: PresentationApi | null) => void;
}

export function CommunityScene({ design, selectedId, onSelect, onChange, onContextTarget, activeTool = "select", visualization, onPresentationReady }: CommunitySceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const rebuildRef = useRef<(() => void) | null>(null);

  const [atmosphere, setAtmosphere] = useState<AtmospherePreset>("noon");
  const skyRef = useRef<Sky | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);

  const designRef = useRef(design);
  const selectedRef = useRef<string | null>(selectedId ?? null);
  const handlersRef = useRef({ onSelect, onChange, onContextTarget, onPresentationReady });
  const toolRef = useRef(activeTool);
  const visualizationRef = useRef(visualization);
  const mapToken = useRef(0);
  designRef.current = design;
  selectedRef.current = selectedId ?? null;
  handlersRef.current = { onSelect, onChange, onContextTarget, onPresentationReady };
  toolRef.current = activeTool;
  visualizationRef.current = visualization;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, container.clientWidth < 900 ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1220");
    scene.fog = new THREE.Fog("#0b1220", 900, 2200);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    pmrem.dispose();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 5000);
    const camHome = new THREE.Vector3(180, 150, 220);
    const camIntro = new THREE.Vector3(340, 280, 400);
    camera.position.copy(camIntro);
    scene.add(camera);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = 10;
    controls.maxDistance = 900;
    controls.enabled = false;
    controlsRef.current = controls;

    const { sky } = createAtmosphericSky();
    scene.add(sky);
    skyRef.current = sky;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334155, 0.9);
    scene.add(hemi);
    hemiLightRef.current = hemi;

    const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    sun.position.set(150, 260, 100);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.camera.near = 10;
    scene.add(sun);
    sunLightRef.current = sun;

    const fill = new THREE.DirectionalLight(0xa855f7, 0.5);
    fill.visible = false;
    scene.add(fill);
    fillLightRef.current = fill;

    applyAtmosphere(atmosphere, scene, sky, sun, hemi, renderer, fill);

    const grid = new THREE.GridHelper(600, 600, 0x1e293b, 0x1e293b);
    grid.position.y = -0.3;
    grid.material = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.35 });
    scene.add(grid);
    const updateGrid = () => {
      const settings = draftingSettings(designRef.current.drafting);
      grid.visible = settings.gridVisible;
      grid.scale.setScalar(settings.gridSize);
    };
    updateGrid();

    const fitShadows = () => {
      const { w: WW, d: DD } = landMeters(designRef.current.land);
      const s = Math.max(WW, DD) * 0.7 + 20;
      sun.shadow.camera.left = -s;
      sun.shadow.camera.right = s;
      sun.shadow.camera.top = s;
      sun.shadow.camera.bottom = -s;
      sun.shadow.camera.far = 1400;
      sun.shadow.camera.updateProjectionMatrix();
    };
    fitShadows();

    const group = new THREE.Group();
    const rebuild = () => {
      updateGrid();
      if (group.children.length) {
        for (const child of [...group.children]) disposeObject3D(child, false);
        group.clear();
      }
      renderer.clippingPlanes = sectionClippingPlanes(designRef.current.section);
       const root = buildCommunityScene(designRef.current, undefined, visualizationRef.current);
      updateCommunitySelection(root, selectedRef.current);
      group.add(root);
      if (!group.parent) scene.add(group);
      groupRef.current = group;
      fitShadows();
      const token = ++mapToken.current;
      const slot = root.getObjectByName("map-ground");
      if (slot) {
        for (const child of [...slot.children]) disposeObject3D(child, false);
        slot.clear();
        const loc = designRef.current.location;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
          buildMapGround(loc, designRef.current.land).then((map) => {
            if (mapToken.current !== token) { disposeObject3D(map, false); return; }
            for (const child of [...slot.children]) disposeObject3D(child, false);
            slot.clear();
            if (map.children.length) slot.add(map);
          }).catch(() => {});
        }
      }
    };
    rebuildRef.current = rebuild;
    rebuild();

    /* Intro fly-in */
    let introStart = performance.now();
    let introDone = false;
    const introDur = 1100;
    const finishIntro = () => { if (!introDone) { introDone = true; controls.enabled = true; } };
    const onSkip = () => { introStart = 0; finishIntro(); };
    const presentation = createPresentationController(renderer, scene, camera, controls, () => {
      const quality = visualizationRef.current?.renderQuality ?? "balanced";
      return { width: container.clientWidth || 1, height: container.clientHeight || 1, pixelRatio: quality === "performance" ? 1 : Math.min(window.devicePixelRatio || 1, quality === "presentation" ? 2 : 1.5) };
    });
    handlersRef.current.onPresentationReady?.({
      ...presentation.api,
      showCameraWaypoint(point) { finishIntro(); presentation.api.showCameraWaypoint(point); },
      playCameraPath(path, duration) { finishIntro(); presentation.api.playCameraPath(path, duration); },
      recordVideo(duration, fps, path) { finishIntro(); return presentation.api.recordVideo(duration, fps, path); },
    });
    renderer.domElement.addEventListener("pointerdown", onSkip, { once: true });
    renderer.domElement.addEventListener("wheel", onSkip, { once: true });

     let raf = 0;
     const reportMetrics = sceneMetricsReporter("community", renderer);
     const animate = () => {
       raf = requestAnimationFrame(animate);
       if (document.hidden) return;
       const authoredFrame = presentation.update();
       if (visualizationRef.current?.walkthrough && !authoredFrame) {
         const t = (visualizationRef.current.time / 100) * Math.PI * 2;
         camera.position.set(Math.cos(t) * 220, 110, Math.sin(t) * 220);
         controls.target.set(0, 20, 0);
       }
      if (!introDone) {
        const t = Math.min((performance.now() - introStart) / introDur, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(camIntro, camHome, ease);
        if (t >= 1) finishIntro();
      }
      controls.update();
      renderer.render(scene, camera);
      reportMetrics();
    };
    animate();

    /* --------------------------- Picking & dragging -------------------------- */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    const pick = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(group, true);
      for (const hit of hits) {
        if (!isSceneObjectVisible(hit.object)) continue;
        let node: THREE.Object3D | null = hit.object;
        while (node) {
           if (node.userData?.selectId) {
             return {
               id: node.userData.selectId as string,
               kind: node.userData.selectKind as string,
               node,
             };
           }
          node = node.parent;
        }
      }
      return null;
    };

    const groundAt = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(groundPlane, hitPoint) ? hitPoint.clone() : null;
    };

    let drag: { id: string; kind: string; node: THREE.Object3D; startX: number; startZ: number; grabX: number; grabZ: number; moved: boolean } | null = null;
    let draw: { kind: DraftElementKind; startX: number; startZ: number; endX: number; endZ: number; rotationDeg: number } | null = null;
    const drawTools = new Set(["line", "polyline", "arc", "spline", "rectangle", "circle", "dimension", "wall", "slab", "column", "roof"]);

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const tool = toolRef.current;
      if (drawTools.has(tool)) {
        const ground = groundAt(e.clientX, e.clientY);
        if (!ground) return;
        const settings = draftingSettings(designRef.current.drafting);
        const point = snapDraftPoint({ x: ground.x, z: ground.z }, settings, designRef.current);
        draw = { kind: tool as DraftElementKind, startX: point.x, startZ: point.z, endX: point.x, endZ: point.z, rotationDeg: 0 };
        controls.enabled = false;
        renderer.domElement.setPointerCapture?.(e.pointerId);
        return;
      }
      const target = pick(e.clientX, e.clientY);
      if (!target) {
        handlersRef.current.onSelect?.(null);
        return;
      }
      handlersRef.current.onSelect?.(target.id);
      const node = target.node;
      const ground = groundAt(e.clientX, e.clientY);
      if (!node || !ground || !handlersRef.current.onChange) return;
      drag = {
        id: target.id,
        kind: target.kind,
        node,
        startX: node.position.x,
        startZ: node.position.z,
        grabX: ground.x,
        grabZ: ground.z,
        moved: false,
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (draw) {
        const ground = groundAt(e.clientX, e.clientY);
        if (ground) {
          draw.endX = ground.x;
          draw.endZ = ground.z;
        }
        return;
      }
      if (!drag) return;
      const ground = groundAt(e.clientX, e.clientY);
      if (!ground) return;
      const settings = draftingSettings(designRef.current.drafting);
      const point = snapDraftPoint({ x: drag.startX + (ground.x - drag.grabX), z: drag.startZ + (ground.z - drag.grabZ) }, settings, designRef.current, { ignoreDraftId: drag.kind === "draft" ? drag.id : undefined });
      const nx = point.x;
      const nz = point.z;
      drag.node.position.x = nx;
      drag.node.position.z = nz;
      if (Math.abs(nx - drag.startX) > 0.01 || Math.abs(nz - drag.startZ) > 0.01) drag.moved = true;
    };

    const commitDrag = () => {
      if (!drag) return;
      const { id, kind, node, moved } = drag;
      drag = null;
      controls.enabled = true;
      if (!moved || !handlersRef.current.onChange) return;
      const x = Math.round(node.position.x * 10) / 10;
      const z = Math.round(node.position.z * 10) / 10;
      const current = designRef.current;
      if (kind === "tower") {
        handlersRef.current.onChange({ ...current, towers: current.towers.map((t) => (t.id === id ? { ...t, x, z } : t)) });
      } else if (kind === "amenity") {
        handlersRef.current.onChange({ ...current, amenities: current.amenities.map((a) => (a.id === id ? { ...a, x, z } : a)) });
      } else if (kind === "draft") {
        handlersRef.current.onChange({ ...current, drafts: solveDraftConstraintGraph(current.drafts ?? [], id, { x, z }) });
      } else if (kind === "room") {
        const room = current.interiors.find((candidate) => candidate.id === id);
        const tower = room && current.towers.find((candidate) => candidate.id === room.towerId);
        if (room) handlersRef.current.onChange({ ...current, interiors: current.interiors.map((candidate) => (candidate.id === id ? { ...candidate, x: x - (tower?.x ?? 0), z: z - (tower?.z ?? 0) } : candidate)) });
      }
    };

    const onPointerUp = () => {
      if (draw) {
        const current = designRef.current;
        const settings = draftingSettings(designRef.current.drafting);
        const constrained = constrainDraftEnd({ x: draw.startX, z: draw.startZ }, { x: draw.endX, z: draw.endZ }, draw.kind, settings, current);
        draw.endX = constrained.x;
        draw.endZ = constrained.z;
        const width = constrainedDraftSize(Math.abs(draw.endX - draw.startX), settings);
        const depth = constrainedDraftSize(Math.abs(draw.endZ - draw.startZ), settings);
        const draft: DraftElement = {
          id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          kind: draw.kind,
          x: (draw.startX + draw.endX) / 2,
          z: (draw.startZ + draw.endZ) / 2,
          w: draw.kind === "circle" || draw.kind === "arc" ? Math.max(width, depth) : width,
          d: draw.kind === "line" || draw.kind === "polyline" || draw.kind === "spline" || draw.kind === "dimension" ? 0.1 : draw.kind === "circle" || draw.kind === "arc" ? Math.max(width, depth) : draw.kind === "wall" ? 0.2 : depth,
          h: draw.kind === "wall" ? 2.7 : draw.kind === "column" ? 3 : draw.kind === "slab" || draw.kind === "roof" ? 0.25 : undefined,
          rotationDeg: draw.kind === "line" || draw.kind === "dimension" ? constrained.rotationDeg : 0,
          color: "#d6a84a",
          ...(draw.kind === "polyline" ? { points: [{ x: -width / 2, z: 0 }, { x: width / 2, z: 0 }] } : {}),
          ...(draw.kind === "spline" ? { points: [{ x: -width / 2, z: 0 }, { x: 0, z: Math.max(depth, width * 0.2) }, { x: width / 2, z: 0 }] } : {}),
          ...(draw.kind === "arc" ? { radiusM: Math.max(Math.max(width, depth) / 2, 0.1), startAngleDeg: 0, endAngleDeg: 180 } : {}),
          family: ["wall", "slab", "column", "roof"].includes(draw.kind) ? {
            ...familyMetadata(familyForId(`${draw.kind}-basic`)!),
            levelId: current.activeLevelId,
          } : undefined,
        };
        draw = null;
        controls.enabled = true;
        handlersRef.current.onChange?.({ ...current, drafts: [...(current.drafts ?? []), draft] });
        handlersRef.current.onSelect?.(draft.id);
        return;
      }
      commitDrag();
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const target = pick(e.clientX, e.clientY);
      const ground = groundAt(e.clientX, e.clientY);
      const x = ground ? Math.round(ground.x * 10) / 10 : 0;
      const z = ground ? Math.round(ground.z * 10) / 10 : 0;
      handlersRef.current.onContextTarget?.({
        kind: (target?.kind as SceneContextTarget["kind"]) ?? "ground",
        id: target?.id,
        x,
        z,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    const onResize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      presentation.dispose();
      handlersRef.current.onPresentationReady?.(null);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      scene.environment?.dispose();
      controls.dispose();
      renderer.dispose();
       for (const child of [...group.children]) disposeObject3D(child, false);
      group.clear();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Rebuild geometry only when the design changes; selection is a cheap overlay update. */
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!renderer || !scene) return;
    const quality = visualization?.renderQuality ?? "balanced";
    renderer.setPixelRatio(quality === "performance" ? 1 : quality === "presentation" ? Math.min(window.devicePixelRatio, 2) : Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = quality !== "performance";
    renderer.toneMappingExposure = quality === "presentation" ? 1.16 : quality === "performance" ? 1 : 1.08;
    scene.environmentIntensity = quality === "presentation" ? 0.68 : quality === "performance" ? 0.28 : 0.48;
  }, [visualization?.renderQuality]);

  useEffect(() => {
    rebuildRef.current?.();
  }, [design]);

  useEffect(() => {
    if (groupRef.current) updateScenePhaseVisibility(groupRef.current, visualization);
  }, [design, visualization]);

  useEffect(() => {
    const root = groupRef.current?.children[0];
    if (root) updateCommunitySelection(root, selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (sceneRef.current && sunLightRef.current && hemiLightRef.current && rendererRef.current) {
      applyAtmosphere(
        atmosphere,
        sceneRef.current,
        skyRef.current,
        sunLightRef.current,
        hemiLightRef.current,
        rendererRef.current,
        fillLightRef.current ?? undefined,
      );
    }
  }, [atmosphere]);

  const handleSetView = (view: "top" | "front" | "right" | "iso" | "reset") => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const target = new THREE.Vector3(0, 0, 0);
    controls.target.copy(target);
    if (view === "top") {
      camera.position.set(0, 320, 0);
    } else if (view === "front") {
      camera.position.set(0, 45, 240);
    } else if (view === "right") {
      camera.position.set(240, 45, 0);
    } else if (view === "iso") {
      camera.position.set(180, 150, 220);
    } else if (view === "reset") {
      camera.position.set(180, 150, 220);
    }
    camera.lookAt(target);
    controls.update();
  };

  return (
    <div className="relative h-full w-full overflow-hidden select-none" data-scene="community">
      <div ref={containerRef} className="h-full w-full" style={{ touchAction: "none" }} />

      {/* Real-time Atmospheric Lighting HUD (Open-World Gaming Graphics) */}
      <AtmosphereControls
        currentPreset={atmosphere}
        onPresetChange={setAtmosphere}
        className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20"
      />

      {/* 3D Orientation Gizmo & ViewCube */}
      <ViewportGizmo3D
        camera={cameraRef.current}
        onSetView={handleSetView}
        className="absolute top-4 right-4 z-20"
      />
    </div>
  );
}

