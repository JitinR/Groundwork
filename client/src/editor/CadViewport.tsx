import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Design, DraftElement, MepElement } from "../types";
import { cadObjects, cadLevels, setCadObjects, resizeDraft, resolveCadSnap, validateCadObject } from "../lib/cadModel";
import { cadMep, updateCadRoutePoint, moveCadRouteSegment, cadNetworkState, cadPorts, cadPortPoint } from "../lib/cadNetworks";
import { resolveDraft } from "../lib/parametric";
import { cadObjectGeometry, cadMepGeometry, disposeCadObject, localCadAxis, rayAxisParameter, type CadAxis } from "../lib/cadViewportGeometry";
import { buildCommunityScene } from "./CommunityScene";
import { buildRoomParts, buildCurtainParts } from "./Canvas3D";
import { buildFurniture } from "../lib/catalog";
import { buildInfraScene } from "../lib/infra";

import type { CadView } from "../lib/cadWorkspaceContext";

export interface CadViewportApi {
  focus(): void;
  setDragValue(value: number): void;
  commitDrag(): void;
  cancelDrag(): void;
  fit(selection?: boolean): void;
  setView(view: CadView): void;
  setProjection(projection: "perspective" | "orthographic"): void;
  exportGlb(): Promise<Blob>;
}
interface Props {
  design: Design; selectedId: string | null;
  onSelect: (id: string | null) => void; onPreview: (next: Design | null) => void; onCommit: (next: Design, label: string) => void;
  onRequestNumericFocus: () => void;
  tool: string; discipline: string; levelId?: string; workingElevation: number;
  displayMode: "shaded" | "edges" | "wireframe"; projection: "perspective" | "orthographic";
  snapEnabled: boolean; gridM: number; symmetric: boolean; readOnly: boolean;
  onStatus: (message: string) => void; onApiReady: (api: CadViewportApi | null) => void;
  onPlace?: (point: { x: number; y: number; z: number }) => void; sectionElevation?: number | null;
  activeSystem?: string; highlightedIds?: string[];
}
type Grip = { id: string; axis?: CadAxis; side?: -1 | 1; point?: number; segment?: number; vertex?:number; world: THREE.Vector3; object: THREE.Mesh };
type Drag = { kind: "resize" | "move" | "rotate" | "route-point" | "route-segment" | "footprint"; id: string; base: Design; draft?: DraftElement; mep?: MepElement; pointerId: number; axis?: CadAxis; side: -1 | 1; axisWorld: THREE.Vector3; origin: THREE.Vector3; parameter: number | null; startPoint: THREE.Vector3; plane: THREE.Plane; size: number; angle: number; moved: boolean; preview?: Design; previews?: WeakSet<Design>; point?: number; segment?: number; vertex?:number; startTool:string;startDiscipline:string;startSystem?:string };
type Retained = { object: THREE.Group; signature: string };
const axisColor = { x: "#ee927c", y: "#a5ca7c", z: "#7bb9e2" };
const asPoint = (point: THREE.Vector3) => ({ x: point.x, y: point.y, z: point.z });

export function CadViewport(props: Props) {
  const container = useRef<HTMLDivElement>(null), dimensionOverlay = useRef<HTMLDivElement>(null), cube = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const controller = useRef<{ sync(): void; api: CadViewportApi } | null>(null);
  const [unavailable, setUnavailable] = useState("");
  const [contextLost, setContextLost] = useState(false);
  useEffect(() => {
    const host = container.current; if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" }); }
    catch { setUnavailable("The 3D viewport needs WebGL. Your model and exact property editing remain available."); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.localClippingEnabled = true;
    renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute("aria-label", "3D architectural modeling canvas");
    renderer.domElement.style.touchAction = "none"; host.prepend(renderer.domElement);
    const scene = new THREE.Scene(), geometry = new THREE.Group(), context = new THREE.Group(), overlays = new THREE.Group();
    scene.add(context, geometry, overlays); scene.add(new THREE.HemisphereLight("#e4efff", "#687567", 2.5));
    const key = new THREE.DirectionalLight("#ffffff", 2.3); key.position.set(8, 14, 10); scene.add(key);
    const perspective = new THREE.PerspectiveCamera(45, 1, .01, 100000);
    const orthographic = new THREE.OrthographicCamera(-10, 10, 10, -10, .01, 100000);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = latest.current.projection === "orthographic" ? orthographic : perspective;
    camera.position.set(10, 9, 12); camera.up.set(0,1,0);
    let controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0,1,0); controls.enableDamping = false; controls.minDistance = .03; controls.maxDistance = 50000;
    // Left pointer is reserved for selection/modeling. Right orbit, middle pan, wheel zoom.
    controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
    let width = 1, height = 1, orthoHalf = 8, stopped = false, lost = false, frame = 0;
    let design = latest.current.design, drag: Drag | null = null, previewFrame = 0, pendingPreview: Design | null = null;
    let grids: THREE.GridHelper[] = [], gridSignature = "", contextSignature = "";
    let portMarkers: {id:string;status:string;object:THREE.Mesh;world:THREE.Vector3;billboard:boolean}[] = [];
    let flowArrows: THREE.ArrowHelper[] = [];
    const entries = new Map<string, Retained>(), routeEntries = new Map<string, Retained>();
    let grips: Grip[] = [], hoverId: string | null = null;
    const raycaster = new THREE.Raycaster(); raycaster.params.Line = { threshold: .08 };
    const selectionBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#dceeb1")); selectionBox.visible = false; selectionBox.renderOrder = 15;
    (selectionBox.material as THREE.LineBasicMaterial).depthTest = false; scene.add(selectionBox);
    const hoverBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#89b4c7")); hoverBox.visible = false; hoverBox.renderOrder = 13; scene.add(hoverBox);
    const axes = new THREE.AxesHelper(2); axes.position.set(0,.005,0); scene.add(axes);
    const snapMarker = new THREE.Mesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({color:"#e5b86c",depthTest:false})); snapMarker.visible = false; snapMarker.renderOrder = 30; overlays.add(snapMarker);
    const dimensionLabels: HTMLButtonElement[] = [];
    for (const axis of ["x","y","z"] as const) { const label=document.createElement("button"); label.type="button";label.dataset.cadDimension=axis;label.style.cssText="position:absolute;pointer-events:auto;cursor:text;transform:translate(-50%,-50%);padding:3px 5px;background:var(--cad-panel,#162126);border:1px solid var(--cad-line,#596c7299);color:var(--cad-ink,#e6efdc);font:10px ui-monospace,monospace;white-space:nowrap;border-radius:2px;display:none";label.addEventListener("click",()=>beginNumericResize(axis));dimensionOverlay.current?.append(label); dimensionLabels.push(label); }
    const clip = new THREE.Plane(new THREE.Vector3(0,-1,0),0);
    const unitsPerPixel = (point: THREE.Vector3) => camera instanceof THREE.OrthographicCamera ? (camera.top-camera.bottom)/camera.zoom/height : 2 * Math.tan(camera.fov*Math.PI/360) * camera.position.distanceTo(point) / height;
    function project(point: THREE.Vector3) { const screen=point.clone().project(camera); return { x:(screen.x*.5+.5)*width, y:(-.5*screen.y+.5)*height, visible:screen.z>=-1&&screen.z<=1 }; }
    function redraw() { if (stopped || lost || frame) return; frame=requestAnimationFrame(() => { frame=0; if(stopped||lost)return; updateAdaptiveGrid();updateScreenOverlays(); renderer.render(scene,camera); }); }
    function updateScreenOverlays() {
      for (const grip of grips) grip.object.scale.setScalar(unitsPerPixel(grip.world)*6);
      snapMarker.scale.setScalar(unitsPerPixel(snapMarker.position)*5);
      for(const marker of portMarkers){marker.object.scale.setScalar(unitsPerPixel(marker.world)*4);if(marker.billboard)marker.object.quaternion.copy(camera.quaternion);}
      for(const arrow of flowArrows){const length=Math.max(.05,unitsPerPixel(arrow.position)*22);arrow.setLength(length,length*.35,length*.22);}
      if (cube.current) { const euler=new THREE.Euler().setFromQuaternion(camera.quaternion,"YXZ"); cube.current.style.transform=`rotateX(${euler.x*180/Math.PI-20}deg) rotateY(${-euler.y*180/Math.PI+35}deg)`; }
      const selected=cadObjects(design).find(item=>item.id===latest.current.selectedId);
      if (!selected) { dimensionLabels.forEach(label=>label.style.display="none"); return; }
      const r=resolveDraft(selected,cadLevels(design)), angle=selected.rotationDeg*Math.PI/180;
      const footprint=["slab","roof"].includes(selected.kind)&&selected.points?.length?selected.points:undefined,minX=footprint?Math.min(...footprint.map(point=>point.x)):-r.width/2,maxX=footprint?Math.max(...footprint.map(point=>point.x)):r.width/2,minZ=footprint?Math.min(...footprint.map(point=>point.z)):-r.depth/2,maxZ=footprint?Math.max(...footprint.map(point=>point.z)):r.depth/2,cx=(minX+maxX)/2,cz=(minZ+maxZ)/2;const local=[new THREE.Vector3(cx,r.height+.25,minZ),new THREE.Vector3(maxX+.25,r.height/2,cz),new THREE.Vector3(cx,.1,maxZ+.25)];
      const labels=[`${selected.family?.type==="circular-column"?"Ø":"X"} ${(maxX-minX).toFixed(3)} m`,`H ${r.height.toFixed(3)} m`,`Z ${(maxZ-minZ).toFixed(3)} m`];
      local.forEach((point,index)=>{point.applyAxisAngle(new THREE.Vector3(0,1,0),angle).add(new THREE.Vector3(selected.x,r.elevation,selected.z));const p=project(point),label=dimensionLabels[index];label.style.display=p.visible&&!(index===2&&selected.family?.type==="circular-column")?"block":"none";label.style.left=`${p.x}px`;label.style.top=`${p.y}px`;label.textContent=labels[index];label.disabled=latest.current.readOnly||Boolean(selected.locked)||!architectureActive();label.setAttribute("aria-label",`${["Width","Height","Depth"][index]} dimension ${(index===0?r.width:index===1?r.height:r.depth).toFixed(3)} metres`);});
    }
    function applyAppearance(root: THREE.Object3D, ghost: boolean) {
      const settings=latest.current, clipping=settings.sectionElevation===null||settings.sectionElevation===undefined?[]:[clip];
      if(clipping.length)clip.constant=settings.sectionElevation!;
      root.traverse(node=>{
        if(node.userData.cadEdge)node.visible=settings.displayMode==="edges";
        if(node instanceof THREE.Mesh)for(const material of Array.isArray(node.material)?node.material:[node.material]) { if(material instanceof THREE.MeshStandardMaterial||material instanceof THREE.MeshBasicMaterial){material.transparent=ghost;material.opacity=ghost ? .16 : 1;material.depthWrite=!ghost;material.wireframe=settings.displayMode==="wireframe";material.clippingPlanes=clipping;if(material instanceof THREE.MeshStandardMaterial){const highlighted=settings.highlightedIds?.includes(String(root.userData.cadId));material.emissive.set(highlighted?"#bda044":"#000000");material.emissiveIntensity=highlighted ? .65 : 0;}material.needsUpdate=true;} }
      });
    }
    const architectureActive=()=>["architecture","structure","coordination"].includes(latest.current.discipline);
    const mepActive=(element:MepElement)=>{const p=latest.current,system=cadNetworkState(design).equipment.find(item=>item.elementId===element.id)?.system;if(p.activeSystem&&system&&p.activeSystem!==system&&p.discipline!=="coordination")return false;return p.discipline==="coordination"||(p.discipline==="electrical"&&(element.system==="electrical-power"||element.system==="controls"))||(p.discipline==="plumbing"&&(element.system??"").startsWith("plumbing"));};
    function buildContext() {
      const d=design, key=JSON.stringify({community:d.community?{...d.community,drafts:undefined,mep:undefined}:undefined,infra:d.infra?{...d.infra,drafts:undefined,mep:undefined}:undefined,room:d.room,furniture:d.furniture,curtains:d.curtains});
      if(key!==contextSignature){contextSignature=key;for(const child of [...context.children])disposeCadObject(child);
        try{
          if(d.community)context.add(buildCommunityScene({...d.community,drafts:[],mep:undefined}));
          else if(d.infra)context.add(buildInfraScene({...d.infra,drafts:[],mep:undefined}));
          else{
            // Preserve the original interior model. It is reference context beside explicit CAD members.
            if(!cadObjects(d).length||d.furniture.length){context.add(buildRoomParts(d));const curtains=buildCurtainParts(d);if(curtains)context.add(curtains);}
            for(const item of d.furniture){const group=buildFurniture(item);group.position.set(item.x*.001,(item.mountHeightM??0),item.z*.001);group.rotation.y=item.rotationDeg*Math.PI/180;context.add(group);}
          }
        }catch{latest.current.onStatus("Some legacy reference geometry could not be displayed; project data is preserved in Project modules.");}
      }
      applyAppearance(context,true);
    }
    function sync() {
      if(drag&&(latest.current.readOnly||latest.current.selectedId!==drag.id||latest.current.tool!==drag.startTool||latest.current.discipline!==drag.startDiscipline||latest.current.activeSystem!==drag.startSystem||(latest.current.design.cad?.revision??0)!==(drag.base.cad?.revision??0)||(latest.current.design!==drag.base&&!drag.previews?.has(latest.current.design))))endDrag(false);
      design=latest.current.design;syncDesign(design);
    }
    function updateAdaptiveGrid(){
      const p=latest.current,dark=document.documentElement.dataset.theme!=="light",pixelWorld=Math.max(.00001,unitsPerPixel(controls.target)),visibleSpan=pixelWorld*Math.max(width,height),base=Math.max(.001,p.gridM);
      // The displayed grid is an exact power-of-ten multiple of the authored snap step.
      // Zooming never claims 1 mm lines while drawing 100 mm spacing.
      const multiplier=10**Math.max(0,Math.ceil(Math.log10(pixelWorld*12/base))),minor=base*multiplier;
      const halfCells=Math.max(10,Math.min(100,Math.ceil(visibleSpan/minor*.7/5)*5)),extent=halfCells*2*minor;
      const centerX=Math.round(controls.target.x/(minor*10))*minor*10,centerZ=Math.round(controls.target.z/(minor*10))*minor*10;
      const signature=`${minor}:${extent}:${centerX}:${centerZ}:${dark}:${p.workingElevation}`;
      if(signature===gridSignature)return;gridSignature=signature;
      for(const grid of grids)disposeCadObject(grid);grids=[];
      for(const[step,color]of [[minor,dark?"#303b44":"#d1d9dc"],[minor*10,dark?"#617178":"#a5b2b8"]] as const){const divisions=Math.max(2,Math.round(extent/step));const grid=new THREE.GridHelper(extent,divisions,color,color);grid.position.set(centerX,p.workingElevation-.004,centerZ);scene.add(grid);grids.push(grid);}
      host!.dataset.gridMinorMetres=String(minor);host!.dataset.snapIncrementMetres=String(base);
    }
    function updateNetworkMarkers(){
      const existingMarkers=new Map(portMarkers.map(marker=>[marker.id,marker])),existingArrows=new Map(flowArrows.map(arrow=>[arrow.name,arrow]));portMarkers=[];flowArrows=[];
      const p=latest.current;if(!["electrical","plumbing","coordination"].includes(p.discipline)){for(const marker of existingMarkers.values())disposeCadObject(marker.object);for(const arrow of existingArrows.values())disposeCadObject(arrow);return;}
      const state=cadNetworkState(design),ports=cadPorts(design),byId=new Map(ports.map(port=>[port.id,port])),statuses=new Map<string,"connected"|"broken">();
      for(const connection of state.connections){const a=byId.get(connection.fromPortId),b=byId.get(connection.toPortId);if(!a||!b)continue;const pa=cadPortPoint(design,a),pb=cadPortPoint(design,b),valid=pa&&pb&&Math.hypot(pa.x-pb.x,pa.y-pb.y,pa.z-pb.z)<=.005;statuses.set(a.id,valid?"connected":"broken");statuses.set(b.id,valid?"connected":"broken");}
      const elements=cadMep(design).elements,byElement=new Map(elements.map(element=>[element.id,element]));
      for(const port of ports.slice(0,1500)){const element=byElement.get(port.elementId),point=cadPortPoint(design,port);if(!element||!point||element.visible===false||!mepActive(element))continue;const status=statuses.get(port.id)??"open",world=new THREE.Vector3(point.x,point.y,point.z);let retained=existingMarkers.get(port.id);existingMarkers.delete(port.id);if(retained&&retained.status!==status){disposeCadObject(retained.object);retained=undefined;}if(!retained){const shape=status==="connected"?new THREE.SphereGeometry(1,10,8):status==="broken"?new THREE.OctahedronGeometry(1.5):new THREE.TorusGeometry(1,.22,6,14),marker=new THREE.Mesh(shape,new THREE.MeshBasicMaterial({color:status==="connected"?"#a5d68d":status==="broken"?"#efb375":"#dce5e9",depthTest:false}));marker.renderOrder=18;marker.userData.portStatus=status;overlays.add(marker);retained={id:port.id,status,object:marker,world,billboard:status==="open"};}retained.object.position.copy(world);retained.world.copy(world);portMarkers.push(retained);}
      for(const element of elements){const equipment=state.equipment.find(item=>item.elementId===element.id);if(!equipment||!["cold-water","hot-water","sanitary","vent","stormwater"].includes(equipment.system)||!mepActive(element)||element.visible===false)continue;for(let i=1;i<element.route.length&&flowArrows.length<500;i++){const a=element.route[i-1],b=element.route[i],direction=new THREE.Vector3(b.x-a.x,b.y-a.y,b.z-a.z),length=direction.length();if(length<.02)continue;const point=new THREE.Vector3((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2),id=`${element.id}:${i}`;let arrow=existingArrows.get(id);existingArrows.delete(id);if(!arrow){arrow=new THREE.ArrowHelper(direction.clone().normalize(),point,Math.min(length*.3,.3),"#e5ebcf");arrow.name=id;for(const material of [...(Array.isArray(arrow.line.material)?arrow.line.material:[arrow.line.material]),...(Array.isArray(arrow.cone.material)?arrow.cone.material:[arrow.cone.material])])material.depthTest=false;arrow.renderOrder=17;overlays.add(arrow);}arrow.position.copy(point);arrow.setDirection(direction.normalize());flowArrows.push(arrow);}}
      for(const marker of existingMarkers.values())disposeCadObject(marker.object);for(const arrow of existingArrows.values())disposeCadObject(arrow);
    }
    function syncDesign(next:Design) {
      design=next;
      const levels=cadLevels(next), objects=cadObjects(next), ids=new Set(objects.map(item=>item.id));
      for(const[id,item]of entries)if(!ids.has(id)){disposeCadObject(item.object);entries.delete(id);}
      for(const object of objects){
        const signature=JSON.stringify([object.kind,object.w,object.d,object.h,object.color,object.family,object.openings,object.points,object.radiusM,object.gradePct,levels]);
        let entry=entries.get(object.id);
        if(!entry||entry.signature!==signature){if(entry)disposeCadObject(entry.object);entry={object:cadObjectGeometry(object,levels),signature};geometry.add(entry.object);entries.set(object.id,entry);}
        const resolved=resolveDraft(object,levels);entry.object.position.set(object.x,resolved.elevation,object.z);entry.object.rotation.y=object.rotationDeg*Math.PI/180;entry.object.visible=object.visible!==false;
        const otherLevel=Boolean(latest.current.levelId&&object.family?.levelId&&object.family.levelId!==latest.current.levelId);
        applyAppearance(entry.object,!architectureActive()||otherLevel);
      }
      const elements=cadMep(next).elements, routeIds=new Set(elements.map(item=>item.id));
      for(const[id,item]of routeEntries)if(!routeIds.has(id)){disposeCadObject(item.object);routeEntries.delete(id);}
      for(const element of elements){const mountingRotation=cadNetworkState(next).equipment.find(item=>item.elementId===element.id)?.mountingRotationDeg??0;const signature=JSON.stringify([element,mountingRotation]);let entry=routeEntries.get(element.id);if(!entry||entry.signature!==signature){if(entry)disposeCadObject(entry.object);entry={object:cadMepGeometry(element,mountingRotation),signature};geometry.add(entry.object);routeEntries.set(element.id,entry);}entry.object.visible=element.visible!==false;applyAppearance(entry.object,!mepActive(element)||Boolean(latest.current.levelId&&element.levelId&&element.levelId!==latest.current.levelId));}
      const dark=document.documentElement.dataset.theme!=="light";scene.background=new THREE.Color(dark?"#192128":"#e9eeee");
      buildContext();updateSelection();updateNetworkMarkers();redraw();
    }
    function clearGrips(){for(const grip of grips)disposeCadObject(grip.object);grips=[];}
    function updateSelection(){
      clearGrips(); const p=latest.current, draft=cadObjects(design).find(item=>item.id===p.selectedId), mep=cadMep(design).elements.find(item=>item.id===p.selectedId), entry=entries.get(p.selectedId??"")??routeEntries.get(p.selectedId??"");
      selectionBox.visible=Boolean(entry&&entry.object.visible);if(entry)selectionBox.box.setFromObject(entry.object);
      if(p.readOnly)return;
      const add=(world:THREE.Vector3,info:Omit<Grip,"world"|"object"|"id">,color:string)=>{const mesh=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicMaterial({color,depthTest:false,transparent:true,opacity:.94}));mesh.position.copy(world);mesh.renderOrder=20;overlays.add(mesh);grips.push({id:p.selectedId!,world,object:mesh,...info});};
      if(draft&&!draft.locked&&draft.visible!==false&&architectureActive()){
        const r=resolveDraft(draft,cadLevels(design)), rotation=draft.rotationDeg*Math.PI/180,footprint=["slab","roof"].includes(draft.kind)&&draft.points?.length?draft.points:undefined,minX=footprint?Math.min(...footprint.map(point=>point.x)):-r.width/2,maxX=footprint?Math.max(...footprint.map(point=>point.x)):r.width/2,minZ=footprint?Math.min(...footprint.map(point=>point.z)):-r.depth/2,maxZ=footprint?Math.max(...footprint.map(point=>point.z)):r.depth/2,cx=(minX+maxX)/2,cz=(minZ+maxZ)/2;
        for(const axis of ["x","y","z"] as CadAxis[]){if(draft.family?.type==="circular-column"&&axis==="z")continue;for(const side of [-1,1] as const){const point=new THREE.Vector3(axis==="x"?(side===1?maxX:minX):cx,axis==="y"?(side===1?r.height:0):r.height/2,axis==="z"?(side===1?maxZ:minZ):cz).applyAxisAngle(new THREE.Vector3(0,1,0),rotation).add(new THREE.Vector3(draft.x,r.elevation,draft.z));add(point,{axis,side},axisColor[axis]);}}
        if(footprint)footprint.forEach((point,index)=>{if(index===footprint.length-1&&point.x===footprint[0].x&&point.z===footprint[0].z)return;const world=new THREE.Vector3(point.x,r.height,point.z).applyAxisAngle(new THREE.Vector3(0,1,0),rotation).add(new THREE.Vector3(draft.x,r.elevation,draft.z));add(world,{vertex:index},"#d9b8f0");});
      }else if(mep&&mepActive(mep)&&mep.visible!==false){mep.route.forEach((point,index)=>add(new THREE.Vector3(point.x,point.y,point.z),{point:index},index===0?"#e9b66b":"#8bd9d4"));for(let i=0;i<mep.route.length-1;i++){const a=mep.route[i],b=mep.route[i+1];add(new THREE.Vector3((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2),{segment:i},"#c4a6ed");}}
    }
    function cast(event:PointerEvent){const rect=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);return raycaster.ray;}
    function worldAt(event:PointerEvent,plane:THREE.Plane){cast(event);return raycaster.ray.intersectPlane(plane,new THREE.Vector3());}
    function pickGrip(event:PointerEvent):Grip|undefined{const rect=renderer.domElement.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;return grips.map(grip=>({grip,p:project(grip.world)})).filter(({p})=>p.visible&&Math.hypot(p.x-x,p.y-y)<12).sort((a,b)=>Math.hypot(a.p.x-x,a.p.y-y)-Math.hypot(b.p.x-x,b.p.y-y))[0]?.grip;}
    function pick(event:PointerEvent):string|null{cast(event);const eligible=[...entries].filter(([id,entry])=>{const object=cadObjects(design).find(item=>item.id===id);return entry.object.visible&&architectureActive()&&(!latest.current.levelId||!object?.family?.levelId||object.family.levelId===latest.current.levelId);}).map(([,entry])=>entry.object);for(const[id,entry]of routeEntries){const item=cadMep(design).elements.find(element=>element.id===id);if(item&&entry.object.visible&&mepActive(item))eligible.push(entry.object);}for(const hit of raycaster.intersectObjects(eligible,true)){let object:THREE.Object3D|null=hit.object;while(object&&!object.userData.cadId)object=object.parent;if(object?.userData.cadId)return String(object.userData.cadId);}return null;}
    function snapPoint(point:THREE.Vector3,ignoreId?:string):THREE.Vector3{
      snapMarker.visible=false;if(!latest.current.snapEnabled)return point;
      const snap=resolveCadSnap(asPoint(point),design,{enabled:true,gridM:latest.current.gridM,toleranceM:unitsPerPixel(point)*12,ignoreId});
      if(!snap)return point;const snapped=new THREE.Vector3(snap.point.x,snap.point.y,snap.point.z);snapMarker.position.copy(snapped);snapMarker.visible=true;host!.dataset.snapKind=snap.kind;return snapped;
    }
    function beginNumericResize(axis:CadAxis){
      const p=latest.current;if(drag)endDrag(false);const draft=cadObjects(design).find(item=>item.id===p.selectedId);if(!draft||draft.locked||p.readOnly||!architectureActive())return;
      const r=resolveDraft(draft,cadLevels(design)),size=axis==="x"?r.width:axis==="y"?r.height:r.depth,origin=new THREE.Vector3(draft.x,r.elevation+r.height/2,draft.z);
      drag={kind:"resize",id:draft.id,base:design,draft,pointerId:-1,axis,side:1,axisWorld:localCadAxis(axis,draft.rotationDeg),origin,parameter:null,startPoint:origin.clone(),plane:new THREE.Plane(new THREE.Vector3(0,1,0),-origin.y),size,angle:0,moved:false,startTool:p.tool,startDiscipline:p.discipline,startSystem:p.activeSystem};controls.enabled=false;p.onPreview(design);p.onRequestNumericFocus();p.onStatus(`Enter exact ${axis==="y"?"height":axis==="x"?"width":"depth"}. Opposite face fixed; Enter commits, Escape restores.`);
    }
    function queuePreview(next:Design){pendingPreview=next;if(!previewFrame)previewFrame=requestAnimationFrame(()=>{previewFrame=0;if(drag&&pendingPreview){latest.current.onPreview(pendingPreview);pendingPreview=null;}});}
    function showPreview(next:Design){if(!drag)return;(drag.previews??=new WeakSet()).add(next);drag.preview=next;drag.moved=JSON.stringify(next)!==JSON.stringify(drag.base);syncDesign(next);queuePreview(next);}
    function resizeTo(value:number){if(!drag?.draft||!drag.axis)return;try{const changed=resizeDraft(drag.draft,drag.axis,drag.side,value,latest.current.symmetric,cadLevels(drag.base));showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===drag!.id?changed:item)));latest.current.onStatus(`${drag.axis.toUpperCase()} ${value.toFixed(3)} m · ${latest.current.symmetric?"center fixed":"opposite face fixed"} · Enter accept / Escape cancel`);}catch(e){latest.current.onStatus(e instanceof Error?e.message:"Dimension rejected");}}
    function endDrag(commit:boolean){const current=drag;if(!current)return;drag=null;if(previewFrame)cancelAnimationFrame(previewFrame);previewFrame=0;pendingPreview=null;controls.enabled=true;renderer.domElement.style.cursor="default";try{if(renderer.domElement.hasPointerCapture(current.pointerId))renderer.domElement.releasePointerCapture(current.pointerId);}catch{/* Pointer may already be released by the browser. */}if(commit&&current.moved&&current.preview){latest.current.onCommit(current.preview,current.kind==="resize"?"Face dimension changed":current.kind==="rotate"?"Object rotated":current.kind.startsWith("route")?"Route edited; explicit connectivity retained":"Object moved");}else{latest.current.onPreview(null);syncDesign(current.base);if(!commit)latest.current.onStatus("Operation cancelled. Geometry and connections restored.");}snapMarker.visible=false;redraw();}
    function focus(){renderer.domElement.focus({ preventScroll: true });}
    function down(event:PointerEvent){if(event.button!==0||event.isPrimary===false)return;const p=latest.current;
      focus();
      if(p.tool.startsWith("place:")){const point=worldAt(event,new THREE.Plane(new THREE.Vector3(0,1,0),-p.workingElevation));if(point&&!p.readOnly){const snapped=snapPoint(point);p.onPlace?.(asPoint(snapped));}return;}
      const grip=pickGrip(event),id=grip?.id??pick(event);if(!id){p.onSelect(null);return;}p.onSelect(id);
      if(p.readOnly)return;
      const draft=cadObjects(design).find(item=>item.id===id),mep=cadMep(design).elements.find(item=>item.id===id);if(draft?.locked)return;
      if(!grip&&p.tool==="select")return;
      const r=draft?resolveDraft(draft,cadLevels(design)):undefined,origin=grip?.world.clone()??new THREE.Vector3(draft?.x??mep?.route[0]?.x??0,r?.elevation??mep?.route[0]?.y??p.workingElevation,draft?.z??mep?.route[0]?.z??0);
      const plane=new THREE.Plane(new THREE.Vector3(0,1,0),-origin.y),start=worldAt(event,plane)??origin.clone(),axis=grip?.axis??"x",axisWorld=draft?localCadAxis(axis,draft.rotationDeg):new THREE.Vector3(1,0,0);cast(event);
      const kind=grip?.vertex!==undefined?"footprint":grip?.point!==undefined?"route-point":grip?.segment!==undefined?"route-segment":p.tool==="rotate"?"rotate":grip&&p.tool!=="move"?"resize":"move";
      const footprint=draft&&["slab","roof"].includes(draft.kind)&&draft.points?.length?draft.points:undefined;const size=footprint&&axis!=="y"?Math.max(...footprint.map(point=>point[axis as "x"|"z"]))-Math.min(...footprint.map(point=>point[axis as "x"|"z"])):r?(axis==="x"?r.width:axis==="y"?r.height:r.depth):0;
      drag={kind,id,base:design,draft,mep,pointerId:event.pointerId,axis:grip?.axis,side:grip?.side??1,axisWorld,origin,parameter:rayAxisParameter(raycaster.ray,origin,axisWorld),startPoint:start,plane,size,angle:Math.atan2(start.z-origin.z,start.x-origin.x),moved:false,point:grip?.point,segment:grip?.segment,vertex:grip?.vertex,startTool:p.tool,startDiscipline:p.discipline,startSystem:p.activeSystem};
      if(kind==="rotate"&&draft){drag.origin.set(draft.x,r!.elevation+r!.height/2,draft.z);drag.plane.set(new THREE.Vector3(0,1,0),-drag.origin.y);const point=worldAt(event,drag.plane)??start;drag.angle=Math.atan2(point.z-drag.origin.z,point.x-drag.origin.x);}
      controls.enabled=false;renderer.domElement.setPointerCapture(event.pointerId);renderer.domElement.style.cursor=kind==="resize"?"ew-resize":"grabbing";event.preventDefault();
      p.onStatus(kind==="resize"&&drag.parameter===null?"Axis points into the screen. Use Exact value, or switch to an alternate view.":`${kind.replace("-"," ")} · model-space ${grip?.axis?.toUpperCase()??"working plane"} · Escape restores original`);
    }
    function move(event:PointerEvent){
      if(!drag){const grip=pickGrip(event);renderer.domElement.style.cursor=grip?"crosshair":pick(event)?"pointer":"default";const id=pick(event);if(id!==hoverId){hoverId=id;const entry=entries.get(id??"")??routeEntries.get(id??"");hoverBox.visible=Boolean(entry&&id!==latest.current.selectedId);if(entry)hoverBox.box.setFromObject(entry.object);redraw();}return;}
      if(event.pointerId!==drag.pointerId)return;cast(event);
      if(drag.kind==="resize"&&drag.axis){const parameter=rayAxisParameter(raycaster.ray,drag.origin,drag.axisWorld);if(parameter===null||drag.parameter===null)return;const delta=(parameter-drag.parameter)*drag.side*(latest.current.symmetric?2:1);let value=drag.size+delta;if(latest.current.snapEnabled)value=Math.round(value/latest.current.gridM)*latest.current.gridM;resizeTo(value);return;}
      const point=worldAt(event,drag.plane);if(!point)return;
      if(drag.kind==="rotate"&&drag.draft){let value=drag.draft.rotationDeg-(Math.atan2(point.z-drag.origin.z,point.x-drag.origin.x)-drag.angle)*180/Math.PI;if(latest.current.snapEnabled)value=Math.round(value/15)*15;const changed={...drag.draft,rotationDeg:value};showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===drag!.id?changed:item)));latest.current.onStatus(`Rotation ${value.toFixed(2)}° · Enter accept / Escape cancel`);return;}
      let delta=point.clone().sub(drag.startPoint);
      if(drag.kind==="footprint"&&drag.draft?.points&&drag.vertex!==undefined){try{const original=drag.draft,footprint=original.points!,index=drag.vertex,r=resolveDraft(original,cadLevels(drag.base)),world=new THREE.Vector3(footprint[index].x,r.height,footprint[index].z).applyAxisAngle(new THREE.Vector3(0,1,0),original.rotationDeg*Math.PI/180).add(new THREE.Vector3(original.x,r.elevation,original.z)).add(delta),snapped=snapPoint(world,original.id),local=snapped.sub(new THREE.Vector3(original.x,r.elevation,original.z)).applyAxisAngle(new THREE.Vector3(0,1,0),-original.rotationDeg*Math.PI/180),closed=footprint.length>1&&footprint[0].x===footprint[footprint.length-1].x&&footprint[0].z===footprint[footprint.length-1].z,points=footprint.map((vertex,i)=>i===index||closed&&index===0&&i===footprint.length-1?{x:local.x,z:local.z}:{...vertex}),w=Math.max(...points.map(vertex=>vertex.x))-Math.min(...points.map(vertex=>vertex.x)),d=Math.max(...points.map(vertex=>vertex.z))-Math.min(...points.map(vertex=>vertex.z)),changed={...original,points,w,d,family:original.family?{...original.family,typeParameters:{...original.family.typeParameters,width:w,depth:d}}:undefined};validateCadObject(changed,cadLevels(drag.base));showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===original.id?changed:item)));latest.current.onStatus(`Footprint vertex ${index+1} · local X ${local.x.toFixed(3)}, Z ${local.z.toFixed(3)} m · Enter accepts / Escape restores`);}catch(e){latest.current.onStatus(e instanceof Error?e.message:"Footprint edit rejected");}return;}
      if(drag.axis){const parameter=rayAxisParameter(raycaster.ray,drag.origin,drag.axisWorld);if(parameter===null||drag.parameter===null)return;delta=drag.axisWorld.clone().multiplyScalar(parameter-drag.parameter);}
      if(drag.kind==="move"&&drag.draft){const target=snapPoint(new THREE.Vector3(drag.draft.x,resolveDraft(drag.draft,cadLevels(drag.base)).elevation,drag.draft.z).add(delta),drag.id),r=resolveDraft(drag.draft,cadLevels(drag.base));const changed={...drag.draft,x:target.x,z:target.z,elevationM:target.y,family:{...drag.draft.family,instanceParameters:{...drag.draft.family?.instanceParameters,baseOffset:drag.draft.family?.levelId?target.y-(cadLevels(drag.base).find(level=>level.id===drag!.draft!.family?.levelId)?.elevation??0):0}}};showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===drag!.id?changed:item)));latest.current.onStatus(`Move X ${target.x.toFixed(3)}, Y ${r.elevation.toFixed(3)}, Z ${target.z.toFixed(3)} m`);}
      else if(drag.mep){try{if(drag.kind==="route-point"&&drag.point!==undefined){const original=drag.mep.route[drag.point],target=snapPoint(new THREE.Vector3(original.x,original.y,original.z).add(delta),drag.id);showPreview(updateCadRoutePoint(drag.base,drag.id,drag.point,asPoint(target)));}else if(drag.kind==="route-segment"&&drag.segment!==undefined){if(latest.current.snapEnabled)delta.set(Math.round(delta.x/latest.current.gridM)*latest.current.gridM,Math.round(delta.y/latest.current.gridM)*latest.current.gridM,Math.round(delta.z/latest.current.gridM)*latest.current.gridM);showPreview(moveCadRouteSegment(drag.base,drag.id,drag.segment,asPoint(delta)));}else{let next=drag.base;for(let i=0;i<drag.mep.route.length;i++){const original=drag.mep.route[i];next=updateCadRoutePoint(next,drag.id,i,{x:original.x+delta.x,y:original.y+delta.y,z:original.z+delta.z});}showPreview(next);}latest.current.onStatus("Route geometry edited; connection ports are checked independently. Exact node elevations are available in Systems.");}catch(e){latest.current.onStatus(e instanceof Error?e.message:"Route edit rejected");}}
    }
    const up=(event:PointerEvent)=>{if(drag&&event.pointerId===drag.pointerId)endDrag(true);};
    const cancel=()=>endDrag(false),keyDown=(event:KeyboardEvent)=>{if(event.key==="Escape"){endDrag(false);}else if(event.key==="Enter"&&drag&&!(event.target instanceof HTMLInputElement)){event.preventDefault();endDrag(true);}};
    const suppressContext=(event:Event)=>event.preventDefault();
    function fit(selection=false){const id=latest.current.selectedId,entry=id?(entries.get(id)??routeEntries.get(id)):undefined;let box:THREE.Box3;if(selection&&entry)box=new THREE.Box3().setFromObject(entry.object);else{box=new THREE.Box3().setFromObject(geometry);if(box.isEmpty())box.setFromObject(context);}if(box.isEmpty())box.set(new THREE.Vector3(-4,0,-4),new THREE.Vector3(4,3,4));const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),radius=Math.max(size.length()/2,.5);let direction=camera.position.clone().sub(controls.target).normalize();if(!direction.lengthSq())direction=new THREE.Vector3(1,1,1).normalize();controls.target.copy(center);camera.position.copy(center).addScaledVector(direction,radius/Math.sin(Math.PI/8)*1.15);orthoHalf=radius*1.3;resize();camera.lookAt(center);controls.update();redraw();}
    function setView(view:CadView){endDrag(false);const distance=Math.max(camera.position.distanceTo(controls.target),1);const directions:Record<CadView,[number,number,number]>={top:[0,1,.00001],bottom:[0,-1,.00001],front:[0,0,1],back:[0,0,-1],left:[-1,0,0],right:[1,0,0],iso:[1,.85,1]};const direction=new THREE.Vector3(...directions[view]).normalize();camera.up.set(0,1,0);if(view==="top")camera.up.set(0,0,-1);if(view==="bottom")camera.up.set(0,0,1);camera.position.copy(controls.target).addScaledVector(direction,distance);camera.lookAt(controls.target);controls.update();redraw();}
    function setProjection(projection:"perspective"|"orthographic"){const next=projection==="orthographic"?orthographic:perspective;if(camera===next)return;const previous=camera,target=controls.target.clone(),distance=previous.position.distanceTo(target);if(next instanceof THREE.OrthographicCamera)orthoHalf=Math.max(.05,Math.tan(perspective.fov*Math.PI/360)*distance);next.position.copy(previous.position);next.quaternion.copy(previous.quaternion);next.up.copy(previous.up);controls.removeEventListener("change",redraw);controls.dispose();camera=next;controls=new OrbitControls(camera,renderer.domElement);controls.target.copy(target);controls.enableDamping=false;controls.mouseButtons={LEFT:null as unknown as THREE.MOUSE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};controls.touches={ONE:null as unknown as THREE.TOUCH,TWO:THREE.TOUCH.DOLLY_PAN};controls.addEventListener("change",redraw);resize();controls.update();redraw();}
    function resize(){width=Math.max(host!.clientWidth,1);height=Math.max(host!.clientHeight,1);renderer.setSize(width,height,false);perspective.aspect=width/height;perspective.updateProjectionMatrix();orthographic.left=-orthoHalf*width/height;orthographic.right=orthoHalf*width/height;orthographic.top=orthoHalf;orthographic.bottom=-orthoHalf;orthographic.updateProjectionMatrix();redraw();}
    const api:CadViewportApi={focus,cancelDrag:()=>endDrag(false),commitDrag:()=>endDrag(true),fit,setView,setProjection,
      setDragValue(value){if(!drag||!Number.isFinite(value))return;if(drag.kind==="resize")resizeTo(value);else if(drag.kind==="rotate"&&drag.draft){showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===drag!.id?{...item,rotationDeg:value}:item)));}else if(drag.kind==="footprint"&&drag.draft?.points&&drag.vertex!==undefined){try{const original=drag.draft,index=drag.vertex,current=cadObjects(drag.preview??drag.base).find(item=>item.id===original.id)?.points??original.points!,closed=original.points![0].x===original.points![original.points!.length-1].x&&original.points![0].z===original.points![original.points!.length-1].z,points=current.map((point,i)=>i===index||closed&&index===0&&i===current.length-1?{x:value,z:current[index].z}:{...point}),w=Math.max(...points.map(point=>point.x))-Math.min(...points.map(point=>point.x)),d=Math.max(...points.map(point=>point.z))-Math.min(...points.map(point=>point.z)),changed={...original,points,w,d,family:original.family?{...original.family,typeParameters:{...original.family.typeParameters,width:w,depth:d}}:undefined};validateCadObject(changed,cadLevels(drag.base));showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===original.id?changed:item)));latest.current.onStatus(`Vertex ${index+1} local X ${value.toFixed(3)} m; local Z ${current[index].z.toFixed(3)} m retained. Enter commits.`);}catch(e){latest.current.onStatus(e instanceof Error?e.message:"Footprint coordinate rejected");}}else if(drag.draft){const axis=drag.axis??"x",direction=localCadAxis(axis,drag.draft.rotationDeg),r=resolveDraft(drag.draft,cadLevels(drag.base)),target=new THREE.Vector3(drag.draft.x,r.elevation,drag.draft.z).addScaledVector(direction,value),changed={...drag.draft,x:target.x,z:target.z,elevationM:target.y,family:{...drag.draft.family,instanceParameters:{...drag.draft.family?.instanceParameters,baseOffset:drag.draft.family?.levelId?target.y-(cadLevels(drag.base).find(level=>level.id===drag!.draft!.family?.levelId)?.elevation??0):0}}};showPreview(setCadObjects(drag.base,cadObjects(drag.base).map(item=>item.id===drag!.id?changed:item)));}},
      async exportGlb(){const output=new THREE.Group();for(const object of cadObjects(latest.current.design))output.add(cadObjectGeometry(object,cadLevels(latest.current.design)));for(const element of cadMep(latest.current.design).elements)output.add(cadMepGeometry(element,cadNetworkState(latest.current.design).equipment.find(item=>item.elementId===element.id)?.mountingRotationDeg??0));output.updateMatrixWorld(true);try{const result=await new GLTFExporter().parseAsync(output,{binary:true});if(!(result instanceof ArrayBuffer))throw new Error("Binary geometry export unavailable");return new Blob([result],{type:"model/gltf-binary"});}finally{disposeCadObject(output);}}
    };
    controller.current={sync,api};latest.current.onApiReady(api);
    controls.addEventListener("change",redraw);
    renderer.domElement.addEventListener("pointerdown",down);renderer.domElement.addEventListener("pointermove",move);renderer.domElement.addEventListener("pointerup",up);renderer.domElement.addEventListener("pointercancel",cancel);renderer.domElement.addEventListener("lostpointercapture",()=>{if(drag)endDrag(false);});renderer.domElement.addEventListener("contextmenu",suppressContext);
    window.addEventListener("pointerup",up);window.addEventListener("blur",cancel);window.addEventListener("keydown",keyDown);
    const lostContext=(event:Event)=>{event.preventDefault();lost=true;endDrag(false);setContextLost(true);};
    const restoredContext=()=>{lost=false;renderer.resetState();setContextLost(false);sync();redraw();};
    renderer.domElement.addEventListener("webglcontextlost",lostContext);renderer.domElement.addEventListener("webglcontextrestored",restoredContext);
    const observer=new ResizeObserver(resize);observer.observe(host);resize();sync();fit();
    const themeObserver=new MutationObserver(()=>sync());themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
    return()=>{stopped=true;controller.current=null;latest.current.onApiReady(null);cancelAnimationFrame(frame);cancelAnimationFrame(previewFrame);observer.disconnect();themeObserver.disconnect();window.removeEventListener("pointerup",up);window.removeEventListener("blur",cancel);window.removeEventListener("keydown",keyDown);controls.removeEventListener("change",redraw);controls.dispose();for(const object of [...scene.children])disposeCadObject(object);renderer.dispose();renderer.domElement.remove();dimensionLabels.forEach(label=>label.remove());};
  },[]);
  useEffect(()=>{controller.current?.sync();},[props.design,props.selectedId,props.discipline,props.levelId,props.workingElevation,props.displayMode,props.snapEnabled,props.gridM,props.symmetric,props.readOnly,props.sectionElevation,props.tool,props.activeSystem,props.highlightedIds]);
  useEffect(()=>{controller.current?.api.setProjection(props.projection);},[props.projection]);
  return <div className="cad-viewport" ref={container} style={{position:"absolute",inset:"35px 0 0",overflow:"hidden"}}>
    <div ref={dimensionOverlay} style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3}} />
    {["electrical","plumbing","coordination"].includes(props.discipline)&&<div aria-label="Connection symbol legend" style={{position:"absolute",top:10,left:10,zIndex:4,pointerEvents:"none",fontSize:9,lineHeight:1.65,color:"var(--cad-ink,#dce5e9)",background:"var(--cad-panel,#192128)",padding:"5px 7px",border:"1px solid var(--cad-line,#46555d)",opacity:.92}}><div><span style={{color:"#a5d68d"}}>●</span> Connected junction · <span>○</span> Open endpoint</div><div><span style={{color:"#efb375"}}>◆</span> Broken connection · crossing alone ≠ connection</div>{props.discipline!=="electrical"&&<div>→ Authored route direction, not solved hydraulic flow</div>}</div>}
    <div aria-label="Viewport orientation cube" style={{position:"absolute",right:14,top:14,zIndex:4,display:"flex",flexDirection:"column",alignItems:"center",gap:7,color:"#bfd0d9",fontSize:9}}>
      <div style={{width:62,height:62,perspective:250,display:"grid",placeItems:"center"}}><div ref={cube} style={{width:34,height:34,transformStyle:"preserve-3d",position:"relative"}}>
        {([['front','FRONT','translateZ(17px)'],['right','RIGHT','rotateY(90deg) translateZ(17px)'],['top','TOP','rotateX(90deg) translateZ(17px)']] as const).map(([view,label,transform])=><button key={view} aria-label={`${view} view`} onClick={()=>controller.current?.api.setView(view)} style={{position:"absolute",inset:0,transform,width:34,height:34,background:"#2c3e49",border:"1px solid #72909e",color:"#d4e1e6",fontSize:7,padding:0,cursor:"pointer",backfaceVisibility:"hidden"}}>{label}</button>)}
      </div></div><button onClick={()=>controller.current?.api.setView("iso")} style={{background:"#24343edb",border:"1px solid #61727d",color:"#d6e1e5",fontSize:9,padding:"4px 8px",cursor:"pointer"}}>Isometric</button><div style={{display:"flex",gap:6}}><span style={{color:axisColor.x}}>X</span><span style={{color:axisColor.y}}>Y ↑</span><span style={{color:axisColor.z}}>Z</span></div>
    </div>
    {(unavailable||contextLost)&&<div role="alert" style={{position:"absolute",left:20,right:20,top:"40%",padding:16,background:"#172126",color:"#ecd29e",border:"1px solid #997946",fontSize:12,zIndex:10}}>{unavailable||"WebGL context lost. Editing is paused; the model is preserved. The viewport will restore when graphics resources return."}</div>}
  </div>;
}
