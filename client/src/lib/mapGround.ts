import * as THREE from "three";
import type { LandSite, SiteLocation } from "../types";
import { landMeters } from "./community";
import { toLocalMetres } from "./geo";

function makeSprite(text: string, w: number, h: number, bg: string, fg: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, 512, 128);
  context.fillStyle = bg;
  context.beginPath();
  context.roundRect(8, 8, 496, 112, 14);
  context.fill();
  context.fillStyle = fg;
  context.font = "bold 60px system-ui, sans-serif";
  const textWidth = context.measureText(text).width;
  if (textWidth > 464) context.font = "bold " + Math.floor(60 * 464 / textWidth) + "px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(w, h, 1);
  sprite.userData.noSelect = true;
  return sprite;
}

const validPoint = (point: { lat: number; lng: number }) =>
  Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

/** Local site context only. Saved/shared coordinates never trigger imagery requests. */
export async function buildMapGround(location: SiteLocation, land: LandSite): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.userData.noSelect = true;
  if (!validPoint(location)) return group;
  group.userData.reference = "local-coordinates-no-imagery";
  const { lat, lng } = location;
  const { w: width, d: depth } = landMeters(land);

  if (location.boundary && location.boundary.length >= 3 && location.boundary.every(validPoint)) {
    const points = location.boundary.map((point) => {
      const local = toLocalMetres(point, { lat, lng });
      return new THREE.Vector3(local.x, 0.09, -local.y);
    });
    points.push(points[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.95 }));
    line.name = "site-boundary-reference";
    line.userData.noSelect = true;
    group.add(line);
    const shape = new THREE.Shape();
    // ShapeGeometry's XY plane rotates into X/-Z; compensate so the fill and
    // boundary outline describe the same north/east coordinates.
    shape.moveTo(points[0].x, -points[0].z);
    for (let index = 1; index < points.length - 1; index++) shape.lineTo(points[index].x, -points[index].z);
    shape.closePath();
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    fill.name = "site-boundary-fill-reference";
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.025;
    fill.userData.noSelect = true;
    group.add(fill);
  }

  const northX = -width / 2 + 8, northZ = -depth / 2 - 12;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4, 16), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(northX, 0.08, northZ);
  arrow.userData.noSelect = true;
  group.add(arrow);
  const north = makeSprite("N", 4, 1.1, "rgba(15,23,42,0.88)", "#f8fafc");
  north.position.set(northX + 5, 0.08, northZ);
  group.add(north);
  const coordinates = makeSprite(lat.toFixed(5) + ", " + lng.toFixed(5), 18, 2.2, "rgba(15,23,42,0.88)", "#94a3b8");
  coordinates.position.set(0, 0.08, depth / 2 + 10);
  group.add(coordinates);
  const status = makeSprite("Coordinate reference · no imagery", 24, 1.6, "rgba(15,23,42,0.88)", "#cbd5e1");
  status.position.set(0, 0.08, depth / 2 + 14);
  group.add(status);
  return group;
}
