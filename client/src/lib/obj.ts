import type { Design } from "../types";
import { catalogEntry, roomFurniturePose, ROOM_WALL_THICKNESS_MM } from "./catalog";
import * as THREE from "three";
import { cadLevels, cadObjects } from "./cadModel";
import { cadMep, cadNetworkState } from "./cadNetworks";
import { cadMepGeometry, cadObjectGeometry, disposeCadObject } from "./cadViewportGeometry";
import { quoteCsvCell } from "./csv";

const m = (v: number) => (v / 1000).toFixed(4);

function hexToRgbFloat(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function buildObjMtl(design: Design, materialLibraryName = "design.mtl"): { obj: string; mtl: string } {
  const { widthMm: W, depthMm: D, wallHeightMm: H } = design.room;
  const obj = [`mtllib ${materialLibraryName}`];
  const mtl: string[] = [];
  let nextBase = 0;

  const addBox = (
    label: string,
    color: string,
    cx: number,
    cy: number,
    cz: number,
    w: number,
    d: number,
    h: number,
    rotationY = 0,
  ) => {
    const rgb = hexToRgbFloat(color);
    const matName = label;
    mtl.push(
      `newmtl ${matName}`,
      `Kd ${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)}`,
      `Ka ${(rgb[0] * 0.1).toFixed(3)} ${(rgb[1] * 0.1).toFixed(3)} ${(rgb[2] * 0.1).toFixed(3)}`,
      "Ks 0.1 0.1 0.1",
      "Ns 10",
    );
    obj.push(`o ${label}`, `usemtl ${matName}`);
    const hw = w / 2, hd = d / 2, hh = h / 2;
    const pts = [
      [-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd],
      [-hw, hh, -hd], [hw, hh, -hd], [hw, hh, hd], [-hw, hh, hd],
    ];
    const base = nextBase, c = Math.cos(rotationY), s = Math.sin(rotationY);
    for (const [x, y, z] of pts) obj.push(`v ${m(cx + x * c + z * s)} ${m(cy + y)} ${m(cz - x * s + z * c)}`);
    nextBase += 8;
    /* Bottom, top, and 4 sides as quads */
    const faces = [
      [0, 1, 2, 3],
      [4, 7, 6, 5],
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ];
    for (const f of faces) {
      obj.push(`f ${f.map((i) => base + i + 1).join(" ")}`);
    }
  };

  /* Floor plate */
  addBox("floor", design.room.floorColor, 0, -10, 0, W, D, 20);
  /* Two visible walls (north +Z, east +X) */
  addBox("wall_north", design.room.wallColor, 0, H / 2, D / 2, W, ROOM_WALL_THICKNESS_MM, H);
  addBox("wall_east", design.room.wallColor, W / 2, H / 2, 0, ROOM_WALL_THICKNESS_MM, D, H);

  /* Furniture as footprint boxes (plan-level fidelity) */
  for (const item of design.furniture) {
    const entry = catalogEntry(item.type);
    if (!entry) continue;
    const pose = roomFurniturePose(item, design.room);
    addBox(
      `item_${item.id.slice(0, 6)}`,
      item.color,
      pose.xMm,
      pose.yMm + (entry.h * item.scale) / 2,
      pose.zMm,
      entry.w * item.scale,
      entry.d * item.scale,
      entry.h * item.scale,
      pose.rotationY,
    );
  }

  // Authored CAD/MEP uses the viewport geometry, including rotations, circular
  // sections, polygon footprints and real opening voids. Visibility is not scope.
  const appendMesh = (root: THREE.Group, id: string, color: string) => {
    try {
      root.updateMatrixWorld(true);
      const label = `cad_${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
      const rgb = hexToRgbFloat(color);
      obj.push(`# Groundwork source ${id} revision ${design.cad?.revision ?? 0} units m`, `o ${label}`, `usemtl ${label}`);
      mtl.push(`newmtl ${label}`, `Kd ${rgb.map(value => value.toFixed(4)).join(" ")}`, "Ka 0.05 0.05 0.05", "Ks 0.1 0.1 0.1", "Ns 10");
      root.traverse(node => {
        if (!(node instanceof THREE.Mesh) || node.userData.cadDecoration) return;
        const positions = node.geometry.getAttribute("position"), index = node.geometry.getIndex();
        if (!positions) return;
        const point = new THREE.Vector3();
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
          obj.push(`v ${point.x.toFixed(7)} ${point.y.toFixed(7)} ${point.z.toFixed(7)}`);
        }
        const count = index?.count ?? positions.count;
        for (let i = 0; i + 2 < count; i += 3) obj.push(`f ${[0,1,2].map(offset => nextBase + (index ? index.getX(i + offset) : i + offset) + 1).join(" ")}`);
        nextBase += positions.count;
      });
    } finally { disposeCadObject(root); }
  };
  for (const object of cadObjects(design)) appendMesh(cadObjectGeometry(object, cadLevels(design)), object.id, object.color);
  const orientations = new Map(cadNetworkState(design).equipment.map(item => [item.elementId, item.mountingRotationDeg ?? 0]));
  for (const element of cadMep(design).elements) appendMesh(cadMepGeometry(element, orientations.get(element.id) ?? 0), element.id, element.color);
  return { obj: obj.join("\n"), mtl: mtl.join("\n") };
}

export function buildBillOfMaterials(design: Design): string {
  const rows: Record<string, { qty: number; type: string; w: number; d: number; h: number; colors: string[] }> = {};
  for (const item of design.furniture) {
    const entry = catalogEntry(item.type);
    const dims = entry ? `${entry.w} x ${entry.d} x ${entry.h}` : "";
    const key = `${item.name}|${dims}`;
    const row = (rows[key] ??= {
      qty: 0,
      type: item.type,
      w: entry?.w ?? 0,
      d: entry?.d ?? 0,
      h: entry?.h ?? 0,
      colors: [],
    });
    row.qty += 1;
    row.colors.push(item.color);
  }
  const records = ["Qty,Item,Type,Size W x D x H (mm),Colours"];
  for (const row of Object.values(rows)) {
    const fields = [row.type, row.type, `${row.w} x ${row.d} x ${row.h}`, row.colors.join(", ")];
    records.push([row.qty, ...fields.map(quoteCsvCell)].join(","));
  }
  const curtains = design.curtains;
  if (curtains?.enabled) {
    records.push([1, ...["Curtains", curtains.style, "wall-mounted", curtains.color].map(quoteCsvCell)].join(","));
  }
  return records.join("\n") + "\n";
}
