import * as THREE from "three";
import type { Design, FurnitureItem } from "../types";

export const ROOM_WALL_THICKNESS_MM = 120;

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  w: number;
  d: number;
  h: number;
  defaultColor: string;
  build: (color: string) => THREE.Group;
}

function mat(color: string, opts: { roughness?: number; metalness?: number; flat?: boolean } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.75,
    metalness: opts.metalness ?? 0.05,
    flatShading: opts.flat ?? false,
  });
}

function groupOf(meshes: { mesh: THREE.Mesh; noTint?: boolean }[]): THREE.Group {
  const g = new THREE.Group();
  const tintables: THREE.MeshStandardMaterial[] = [];
  for (const { mesh, noTint } of meshes) {
    g.add(mesh);
    mesh.userData.tintable = !noTint;
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (!noTint) tintables.push(m);
  }
  g.userData.tintables = tintables;
  return g;
}

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardMaterial,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const box = (w: number, d: number, h: number) => new THREE.BoxGeometry(w, h, d);

function fixtureBox(color: string, w: number, d: number, h: number, accent = "#d7dce0"): THREE.Group {
  return groupOf([
    { mesh: mesh(box(w, d, h), mat(color, { roughness: 0.7 }), 0, h / 2, 0) },
    { mesh: mesh(box(w * 0.82, 20, h * 0.55), mat(accent, { roughness: 0.3, metalness: 0.15 }), 0, h * 0.52, d / 2 + 12), noTint: true },
  ]);
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "sofa",
    name: "Sofa",
    category: "Seating",
    w: 2200, d: 950, h: 820,
    defaultColor: "#7c8a99",
    build: (color) => {
      const base = mat(color, { roughness: 0.85 });
      const accent = mat("#e8e6e0", { roughness: 0.95 });
      return groupOf([
        { mesh: mesh(box(2000, 280, 420), base, 0, 210, 0) },
        { mesh: mesh(box(2000, 200, 260), base, 0, 480, -150) },
        { mesh: mesh(box(180, 760, 540), base, -910, 270, 0) },
        { mesh: mesh(box(180, 760, 540), base, 910, 270, 0) },
        { mesh: mesh(box(900, 120, 180), accent, -500, 250, 330) },
        { mesh: mesh(box(900, 120, 180), accent, 500, 250, 330) },
      ]);
    },
  },
  {
    id: "armchair",
    name: "Armchair",
    category: "Seating",
    w: 860, d: 820, h: 800,
    defaultColor: "#a4714f",
    build: (color) => {
      const base = mat(color, { roughness: 0.85 });
      const cushion = mat("#f0ede6", { roughness: 0.95 });
      return groupOf([
        { mesh: mesh(box(760, 240, 380), base, 0, 190, 0) },
        { mesh: mesh(box(760, 160, 220), base, 0, 500, -80) },
        { mesh: mesh(box(140, 660, 480), base, -310, 300, 0) },
        { mesh: mesh(box(140, 660, 480), base, 310, 300, 0) },
        { mesh: mesh(box(560, 90, 140), cushion, 0, 220, 300) },
      ]);
    },
  },
  {
    id: "coffee-table",
    name: "Coffee Table",
    category: "Tables",
    w: 1100, d: 600, h: 420,
    defaultColor: "#8a6a45",
    build: (color) => {
      const top = mat(color);
      const leg = mat("#3a342c", { metalness: 0.3, roughness: 0.5 });
      const gl = groupOf([
        { mesh: mesh(box(1100, 520, 50), top, 0, 395, 0) },
        { mesh: mesh(box(60, 60, 360), leg, -490, 180, -220) },
        { mesh: mesh(box(60, 60, 360), leg, 490, 180, -220) },
        { mesh: mesh(box(60, 60, 360), leg, -490, 180, 220) },
        { mesh: mesh(box(60, 60, 360), leg, 490, 180, 220) },
      ]);
      return gl;
    },
  },
  {
    id: "dining-table",
    name: "Dining Table",
    category: "Tables",
    w: 1800, d: 900, h: 740,
    defaultColor: "#7d5a36",
    build: (color) => {
      const top = mat(color);
      const leg = mat("#4a3a2a");
      return groupOf([
        { mesh: mesh(box(1800, 900, 60), top, 0, 710, 0) },
        { mesh: mesh(box(80, 80, 680), leg, -820, 340, -390) },
        { mesh: mesh(box(80, 80, 680), leg, 820, 340, -390) },
        { mesh: mesh(box(80, 80, 680), leg, -820, 340, 390) },
        { mesh: mesh(box(80, 80, 680), leg, 820, 340, 390) },
      ]);
    },
  },
  {
    id: "dining-chair",
    name: "Dining Chair",
    category: "Seating",
    w: 460, d: 520, h: 900,
    defaultColor: "#5d7b8a",
    build: (color) => {
      const seat = mat(color);
      return groupOf([
        { mesh: mesh(box(420, 60, 40), seat, 0, 470, 0) },
        { mesh: mesh(box(420, 380, 50), seat, 0, 630, -200) },
        { mesh: mesh(box(40, 420, 40), mat("#2e2a24"), -180, 210, -210) },
        { mesh: mesh(box(40, 420, 40), mat("#2e2a24"), 180, 210, -210) },
        { mesh: mesh(box(40, 420, 40), mat("#2e2a24"), -180, 210, 210) },
        { mesh: mesh(box(40, 420, 40), mat("#2e2a24"), 180, 210, 210) },
      ]);
    },
  },
  {
    id: "bed",
    name: "Double Bed",
    category: "Sleeping",
    w: 1600, d: 2000, h: 1100,
    defaultColor: "#6b5542",
    build: (color) => {
      const frame = mat(color, { roughness: 0.9 });
      const mattress = mat("#f7f3ec", { roughness: 0.95 });
      const pillow = mat("#ffffff", { roughness: 0.95 });
      const blanket = mat("#4c7a9c", { roughness: 0.9 });
      return groupOf([
        { mesh: mesh(box(1600, 2000, 300), frame, 0, 150, 0) },
        { mesh: mesh(box(1500, 120, 240), mat("#8a8a8a"), 0, 330, -20) }, // base
        { mesh: mesh(box(1400, 1900, 220), mattress, 0, 470, 20), noTint: true },
        { mesh: mesh(box(520, 380, 160), pillow, -430, 570, -760), noTint: true },
        { mesh: mesh(box(520, 380, 160), pillow, 430, 570, -760), noTint: true },
        { mesh: mesh(box(1390, 1100, 80), blanket, 0, 510, 470) },
        { mesh: mesh(box(90, 1960, 840), mat("#5a4630"), -755, 420, 10) },
        { mesh: mesh(box(90, 1960, 840), mat("#5a4630"), 755, 420, 10) },
      ]);
    },
  },
  {
    id: "wardrobe",
    name: "Wardrobe",
    category: "Storage",
    w: 2000, d: 600, h: 2200,
    defaultColor: "#b8926a",
    build: (color) => {
      const body = mat(color, { roughness: 0.6 });
      const door = mat("#caa87d", { roughness: 0.55, metalness: 0.05 });
      const handle = mat("#2c2721", { metalness: 0.6, roughness: 0.4 });
      return groupOf([
        { mesh: mesh(box(2000, 80, 2200), body, 0, 1100, 0) },
        { mesh: mesh(box(980, 40, 2150), door, -500, 1100, 20) },
        { mesh: mesh(box(980, 40, 2150), door, 500, 1100, 20) },
        { mesh: mesh(box(20, 300, 40), handle, 10, 950, 60) },
        { mesh: mesh(box(20, 300, 40), handle, 10, 1250, 60) },
      ]);
    },
  },
  {
    id: "bookshelf",
    name: "Bookshelf",
    category: "Storage",
    w: 1000, d: 350, h: 1800,
    defaultColor: "#9c7b52",
    build: (color) => {
      const wood = mat(color, { roughness: 0.7 });
      const items = [
        mat("#c0392b"), mat("#2980b9"), mat("#27ae60"), mat("#8e44ad"),
        mat("#d35400"), mat("#7f8c8d"), mat("#f1c40f"), mat("#16a085"),
      ];
      const parts: { mesh: THREE.Mesh; noTint?: boolean }[] = [
        { mesh: mesh(box(1000, 40, 1800), wood, 0, 900, 0) },
        { mesh: mesh(box(1000, 40, 1800), wood, 0, 900, 0) },
        { mesh: mesh(box(40, 1800, 350), wood, -480, 900, 0) },
        { mesh: mesh(box(40, 1800, 350), wood, 480, 900, 0) },
        { mesh: mesh(box(960, 40, 350), wood, 0, 300, 0) },
        { mesh: mesh(box(960, 40, 350), wood, 0, 700, 0) },
        { mesh: mesh(box(960, 40, 350), wood, 0, 1100, 0) },
        { mesh: mesh(box(960, 40, 350), wood, 0, 1500, 0) },
      ];
      for (let r = 0; r < 3; r++) {
        const y = 450 + r * 400;
        items.slice(r * 3, r * 3 + 3).forEach((c, i) => {
          parts.push({ mesh: mesh(box(180, 160, 140), c, -330 + i * 330, y, 60), noTint: true });
        });
      }
      return groupOf(parts);
    },
  },
  {
    id: "desk",
    name: "Desk",
    category: "Workspace",
    w: 1400, d: 700, h: 740,
    defaultColor: "#96a5b0",
    build: (color) => {
      const top = mat(color);
      const metal = mat("#373737", { metalness: 0.55, roughness: 0.35 });
      const parts: { mesh: THREE.Mesh; noTint?: boolean }[] = [
        { mesh: mesh(box(1400, 700, 40), top, 0, 720, 0) },
        { mesh: mesh(box(50, 50, 700), metal, -620, 350, -300) },
        { mesh: mesh(box(50, 50, 700), metal, 620, 350, -300) },
        { mesh: mesh(box(50, 50, 700), metal, -620, 350, 300) },
        { mesh: mesh(box(50, 50, 700), metal, 620, 350, 300) },
        { mesh: mesh(box(1400, 20, 600), metal, 0, 745, 10), noTint: true },
      ];
      return groupOf(parts);
    },
  },
  {
    id: "office-chair",
    name: "Office Chair",
    category: "Workspace",
    w: 600, d: 600, h: 1000,
    defaultColor: "#2f4050",
    build: (color) => {
      const seat = mat(color, { roughness: 0.8 });
      const metal = mat("#333333", { metalness: 0.6, roughness: 0.3 });
      const parts: { mesh: THREE.Mesh; noTint?: boolean }[] = [
        { mesh: mesh(box(500, 80, 480), seat, 0, 480, 0) },
        { mesh: mesh(box(480, 420, 110), seat, 0, 680, -220) },
        { mesh: mesh(box(55, 360, 55), metal, -250, 650, 0) },
        { mesh: mesh(box(55, 360, 55), metal, 250, 650, 0) },
        { mesh: mesh(box(520, 55, 55), metal, 0, 820, 0) },
        { mesh: mesh(box(60, 60, 440), metal, 0, 180, 0) },
        { mesh: mesh(cylinder(40, 800), metal, 0, 130, 0), noTint: true },
      ];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        parts.push({
          mesh: mesh(box(420, 40, 50), metal, Math.cos(a) * 150, 40, Math.sin(a) * 150),
          noTint: true,
        });
      }
      return groupOf(parts);
    },
  },
  {
    id: "tv-unit",
    name: "TV Unit",
    category: "Media",
    w: 1800, d: 450, h: 500,
    defaultColor: "#4f5b66",
    build: (color) => {
      const body = mat(color, { roughness: 0.6 });
      const screen = mat("#0b0d12", { metalness: 0.2, roughness: 0.1 });
      return groupOf([
        { mesh: mesh(box(1800, 450, 500), body, 0, 250, 0) },
        { mesh: mesh(box(1720, 380, 60), body, 0, 190, 0) },
        { mesh: mesh(box(1100, 420, 80), screen, 0, 630, 80), noTint: true },
        { mesh: mesh(box(80, 250, 400), mat("#2c2c2c"), 0, 140, 30), noTint: true },
      ]);
    },
  },
  {
    id: "rug",
    name: "Rug",
    category: "Decor",
    w: 2400, d: 1600, h: 15,
    defaultColor: "#b45f5f",
    build: (color) => {
      const rug = mat(color, { roughness: 1 });
      return groupOf([
        { mesh: mesh(box(2400, 1600, 12), rug, 0, 6, 0) },
      ]);
    },
  },
  {
    id: "floor-lamp",
    name: "Floor Lamp",
    category: "Lighting",
    w: 420, d: 420, h: 1700,
    defaultColor: "#333a42",
    build: (color) => {
      const metal = mat(color, { metalness: 0.5, roughness: 0.4 });
      const shade = mat("#f4ead2", { roughness: 0.9 });
      const bulb = new THREE.MeshStandardMaterial({ color: "#fff8e0", emissive: "#ffdf9e", emissiveIntensity: 0.7 });
      return groupOf([
        { mesh: mesh(cylinder(30, 1500), metal, 0, 750, 0) },
        { mesh: mesh(cylinder(230, 20), metal, 0, 10, 0), noTint: true },
        { mesh: mesh(cone(230, 320), shade, 0, 1620, 0) },
        { mesh: mesh(box(90, 80, 90), bulb, 0, 1530, 0), noTint: true },
      ]);
    },
  },
  {
    id: "plant",
    name: "Indoor Plant",
    category: "Decor",
    w: 500, d: 500, h: 1200,
    defaultColor: "#4d7a35",
    build: (color) => {
      const pot = mat("#b07d52", { roughness: 0.8 });
      const foliage = mat(color, { roughness: 0.9 });
      const parts: { mesh: THREE.Mesh; noTint?: boolean }[] = [
        { mesh: mesh(cylinder(150, 320), pot, 0, 150, 0), noTint: true },
        { mesh: mesh(sphere(260), foliage, 0, 620, 0) },
        { mesh: mesh(sphere(200), foliage, 120, 430, -100) },
        { mesh: mesh(sphere(210), foliage, -130, 480, 40) },
        { mesh: mesh(cylinder(360, 40), foliage, 0, 990, 0) },
      ];
      return groupOf(parts);
    },
  },
  {
    id: "kitchen-island",
    name: "Kitchen Island",
    category: "Kitchen",
    w: 2000, d: 900, h: 900,
    defaultColor: "#a8a29a",
    build: (color) => {
      const top = mat("#d8d4cc", { roughness: 0.4 });
      const body = mat(color, { roughness: 0.8 });
      const parts: { mesh: THREE.Mesh; noTint?: boolean }[] = [
        { mesh: mesh(box(2000, 900, 880), body, 0, 440, 0) },
        { mesh: mesh(box(1980, 850, 80), top, 0, 880, 15), noTint: true },
      ];
      return groupOf(parts);
    },
  },
  {
    id: "refrigerator",
    name: "Refrigerator",
    category: "Kitchen appliances",
    w: 900, d: 750, h: 2000,
    defaultColor: "#b8c2c9",
    build: (color) => fixtureBox(color, 900, 750, 2000, "#e9eef1"),
  },
  {
    id: "oven",
    name: "Built-in Oven",
    category: "Kitchen appliances",
    w: 600, d: 650, h: 900,
    defaultColor: "#4f5b66",
    build: (color) => fixtureBox(color, 600, 650, 900, "#111820"),
  },
  {
    id: "kitchen-sink",
    name: "Kitchen Sink",
    category: "Kitchen appliances",
    w: 900, d: 600, h: 900,
    defaultColor: "#a8a29a",
    build: (color) => fixtureBox(color, 900, 600, 900, "#dce3e7"),
  },
  {
    id: "microwave",
    name: "Microwave",
    category: "Kitchen appliances",
    w: 600, d: 450, h: 400,
    defaultColor: "#37474f",
    build: (color) => fixtureBox(color, 600, 450, 400, "#101820"),
  },
  {
    id: "cooktop",
    name: "Cooktop",
    category: "Kitchen appliances",
    w: 900, d: 600, h: 100,
    defaultColor: "#252a30",
    build: (color) => fixtureBox(color, 900, 600, 100, "#111820"),
  },
  {
    id: "toilet",
    name: "Toilet",
    category: "Bathroom",
    w: 700, d: 1200, h: 800,
    defaultColor: "#f1f3f4",
    build: (color) => fixtureBox(color, 700, 1200, 800, "#ffffff"),
  },
  {
    id: "vanity-sink",
    name: "Vanity Sink",
    category: "Bathroom",
    w: 900, d: 500, h: 850,
    defaultColor: "#a1887f",
    build: (color) => fixtureBox(color, 900, 500, 850, "#f1f3f4"),
  },
  {
    id: "bathtub",
    name: "Bathtub",
    category: "Bathroom",
    w: 1700, d: 750, h: 600,
    defaultColor: "#e7edf0",
    build: (color) => fixtureBox(color, 1700, 750, 600, "#ffffff"),
  },
  {
    id: "shower",
    name: "Shower Enclosure",
    category: "Bathroom",
    w: 1000, d: 1000, h: 2200,
    defaultColor: "#7fb6c9",
    build: (color) => fixtureBox(color, 1000, 1000, 2200, "#c8f1ff"),
  },
  {
    id: "air-conditioner",
    name: "Air Conditioner",
    category: "HVAC & electrical",
    w: 1000, d: 250, h: 300,
    defaultColor: "#e5e7e9",
    build: (color) => fixtureBox(color, 1000, 250, 300, "#f8fafc"),
  },
  {
    id: "ceiling-fan",
    name: "Ceiling Fan",
    category: "HVAC & electrical",
    w: 1400, d: 1400, h: 350,
    defaultColor: "#78909c",
    build: (color) => fixtureBox(color, 1400, 1400, 350, "#d8e0e5"),
  },
  {
    id: "wall-mirror",
    name: "Wall Mirror",
    category: "Bathroom",
    w: 800, d: 80, h: 1200,
    defaultColor: "#b7d5df",
    build: (color) => fixtureBox(color, 800, 80, 1200, "#b7e3f2"),
  },
  {
    id: "mirror-stand",
    name: "Mirror Stand",
    category: "Bedroom & decor",
    w: 900, d: 450, h: 1800,
    defaultColor: "#9c7b52",
    build: (color) => fixtureBox(color, 900, 450, 1800, "#b7d5df"),
  },
];

function cylinder(radius: number, height: number, radialSegments = 24): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, height, radialSegments);
}

function cone(radius: number, height: number, radialSegments = 24): THREE.ConeGeometry {
  return new THREE.ConeGeometry(radius, height, radialSegments);
}

function sphere(radius: number, widthSegments = 20, heightSegments = 16): THREE.SphereGeometry {
  return new THREE.SphereGeometry(radius, widthSegments, heightSegments);
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}

export function furnitureMount(type: string): "unassigned" | "floor" | "wall" | "ceiling" {
  if (type === "ceiling-fan") return "ceiling";
  if (type === "air-conditioner") return "wall";
  if (type === "wall-mirror" || type === "vanity-sink") return "unassigned";
  return "floor";
}

/** Shared pose for the legacy room viewport and its geometry export. */
export function roomFurniturePose(item: FurnitureItem, room: Design["room"]) {
  const mount = item.mount ?? furnitureMount(item.type);
  const wall = item.mountWall ?? "north";
  const heightMm = (catalogEntry(item.type)?.h ?? 0) * item.scale;
  const mountHeightMm = item.mountHeightM == null ? undefined : item.mountHeightM * 1000;
  let xMm = item.x, yMm = 0, zMm = item.z;
  let rotationY = item.rotationDeg * Math.PI / 180;
  if (mount === "ceiling") {
    yMm = mountHeightMm ?? Math.max(room.wallHeightMm - heightMm, 200);
  } else if (mount === "wall") {
    yMm = mountHeightMm ?? Math.max(room.wallHeightMm - heightMm - 250, 300);
    if (wall === "north" || wall === "south") {
      zMm = (room.depthMm / 2 - 160) * (wall === "north" ? 1 : -1);
    } else {
      xMm = (room.widthMm / 2 - 160) * (wall === "east" ? 1 : -1);
      rotationY += Math.PI / 2;
    }
  }
  return { xMm, yMm, zMm, rotationY };
}

export function applyFinish(group: THREE.Group, color: string) {
  const tintables = (group.userData.tintables ?? []) as THREE.MeshStandardMaterial[];
  for (const m of tintables) m.color.set(color);
}

export type FurnitureFinish = "matte" | "satin" | "glossy" | "metallic" | "glass";

export function buildFurniture(item: { type: string; color: string; scale: number; finish?: FurnitureFinish }): THREE.Group {
  const entry = catalogEntry(item.type) ?? CATALOG[0];
  const group = entry.build(item.color);
  group.scale.setScalar(item.scale * 0.001);
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      const finish = item.finish ?? "satin";
      const values: Record<FurnitureFinish, { roughness: number; metalness: number; envMapIntensity: number }> = {
        matte: { roughness: 0.92, metalness: 0.02, envMapIntensity: 0.25 },
        satin: { roughness: 0.58, metalness: 0.08, envMapIntensity: 0.55 },
        glossy: { roughness: 0.2, metalness: 0.12, envMapIntensity: 1 },
        metallic: { roughness: 0.28, metalness: 0.78, envMapIntensity: 1.1 },
        glass: { roughness: 0.08, metalness: 0.15, envMapIntensity: 1.2 },
      };
      const finishValues = values[finish];
      for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
        const standard = material as THREE.MeshStandardMaterial;
        if ("roughness" in standard) {
          standard.roughness = finishValues.roughness;
          standard.metalness = finishValues.metalness;
          standard.envMapIntensity = finishValues.envMapIntensity;
          standard.needsUpdate = true;
        }
      }
    }
  });
  return group;
}
