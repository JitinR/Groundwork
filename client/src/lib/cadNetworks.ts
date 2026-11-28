import type { Design, MepDesign, MepElement, MepPoint } from "../types";
import { analyzeElectricalCircuit, solveFluidNetwork, type ElectricalCircuitInput, type FluidNetwork } from "./engineeringNetworks";

export type CadSystem = "electrical" | "cold-water" | "hot-water" | "sanitary" | "vent" | "stormwater" | "hvac";
export type CadDeviceType = "panel" | "light" | "switch" | "socket" | "junction" | "equipment" | "cable" | "conduit" | "tray" | "fixture" | "source" | "outlet" | "valve" | "bend" | "reducer" | "riser" | "access" | "pipe";
export interface CadPort { id: string; elementId: string; end: "start" | "end"; system: CadSystem; medium: "electrical" | "containment" | "fluid" | "air"; }
export interface CadEquipment { elementId: string; type: CadDeviceType; system: CadSystem; ports: CadPort[]; mountingRotationDeg?: number; hostId?: string; hostFingerprint?: string; demandLps?: number; fixedHeadM?: number; roughnessM?: number; minorLossK?: number; minimumSlopePct?: number; material?: string; }
export interface CadConnection { id: string; fromPortId: string; toPortId: string; }
export interface CadCircuit { id: string; name: string; panelId: string; deviceIds: string[]; cableIds: string[]; inputs: Partial<ElectricalCircuitInput> & { conductorResistanceOhmPerM?: number; conductorReactanceOhmPerM?: number }; basis: string; }
export interface CadNetworkCalculation { id: string; scope: "circuit" | "water" | "gravity"; targetId: string; sourceRevision: number; fingerprint: string; method: string; units: string; basis: string; inputs: unknown; result: unknown; warnings: string[]; }
export interface CadNetworkState { version: 1; equipment: CadEquipment[]; connections: CadConnection[]; circuits: CadCircuit[]; calculations: CadNetworkCalculation[]; fluidInputs?: { densityKgM3?: number; kinematicViscosityM2s?: number; basis?: string }; }
export interface CadNetworkIssue { objectId: string; kind: "open" | "broken" | "incompatible" | "unassigned" | "missing-input"; text: string; }
export const CAD_SYSTEM_LABELS: Record<CadSystem, string> = { electrical: "Electrical power", "cold-water": "Cold water", "hot-water": "Hot water", sanitary: "Sanitary drainage", vent: "Venting", stormwater: "Stormwater", hvac: "HVAC" };
export const CAD_DEVICE_LABELS: Record<CadDeviceType, string> = { panel: "Distribution panel", light: "Light", switch: "Switch", socket: "Socket", junction: "Junction box", equipment: "Equipment connection", cable: "Cable run", conduit: "Conduit", tray: "Cable tray", fixture: "Fixture", source: "Supply source", outlet: "Outlet", valve: "Valve", bend: "Bend", reducer: "Reducer", riser: "Riser", access: "Access point", pipe: "Pipe" };
const electricalTypes = new Set<CadDeviceType>(["panel", "light", "switch", "socket", "junction", "equipment", "cable", "conduit", "tray"]);
const routedTypes = new Set<CadDeviceType>(["cable", "conduit", "tray", "pipe", "riser"]);
const uuid = () => crypto.randomUUID();
const distance = (a: MepPoint, b: MepPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finite = (value: unknown, name: string, min = -1000000, max = 1000000): number => { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be finite and between ${min} and ${max}.`); return value; };
export function cadMep(design: Design): MepDesign { return design.community?.mep ?? design.infra?.mep ?? design.mep ?? { version: 1, enabled: true, elements: [] }; }
export function setCadMep(design: Design, mep: MepDesign): Design { return design.community ? { ...design, community: { ...design.community, mep } } : design.infra ? { ...design, infra: { ...design.infra, mep } } : { ...design, mep }; }
export function cadNetworkState(design: Design): CadNetworkState { return design.cadNetworks ?? { version: 1, equipment: [], connections: [], circuits: [], calculations: [] }; }
export function cadRouteLength(element: MepElement): number { return element.route.reduce((sum, point, index) => index ? sum + distance(point, element.route[index - 1]) : 0, 0); }
export function cadPortPoint(design: Design, port: CadPort): MepPoint | null { const item = cadMep(design).elements.find(element => element.id === port.elementId); return item?.route[port.end === "end" ? item.route.length - 1 : 0] ?? null; }
export function cadPorts(design: Design): CadPort[] { return cadNetworkState(design).equipment.flatMap(item => item.ports); }
export function cadPortsCompatible(a: CadPort, b: CadPort): boolean { return a.id !== b.id && a.elementId !== b.elementId && a.system === b.system && a.medium === b.medium; }

export function addCadNetworkElement(design: Design, type: CadDeviceType, system: CadSystem, point: MepPoint, options: { levelId?: string; name?: string; end?: MepPoint; diameterM?: number; rotationDeg?: number } = {}): { design: Design; element: MepElement } {
  finite(point.x, "X"); finite(point.y, "Elevation"); finite(point.z, "Z");
  if (system === "electrical" !== electricalTypes.has(type)) throw new Error("Device type is incompatible with the selected discipline/system.");
  const routed = routedTypes.has(type); const end = options.end;
  if (routed && (!end || distance(point, end) < .001)) throw new Error("A route requires a distinct end point, at least 1 mm from its start.");
  if (end) { finite(end.x, "End X"); finite(end.y, "End elevation"); finite(end.z, "End Z"); }
  const id = uuid(); const medium: CadPort["medium"] = ["conduit", "tray"].includes(type) ? "containment" : system === "electrical" ? "electrical" : system === "hvac" ? "air" : "fluid";
  const element: MepElement = { id, kind: type === "tray" || type === "cable" || type === "conduit" ? "cable-tray" : routed ? "pipe" : type === "panel" || type === "equipment" || type === "source" ? "equipment" : "fixture", name: options.name?.trim() || CAD_DEVICE_LABELS[type], route: routed ? [{ ...point }, { ...end! }] : [{ ...point }], width: type === "tray" ? .3 : .15, height: type === "tray" ? .08 : .15, diameter: finite(options.diameterM ?? .025, "Nominal diameter", .001, 5), color: system === "electrical" ? "#e7b85f" : system === "cold-water" ? "#65b9de" : system === "hot-water" ? "#e88977" : system === "sanitary" ? "#a5b386" : system === "vent" ? "#bfa0d5" : "#70c6b0", visible: true, levelId: options.levelId, system: system === "electrical" ? "electrical-power" : system === "hvac" ? "hvac-supply" : ["sanitary", "vent", "stormwater"].includes(system) ? "plumbing-drain" : "plumbing-supply", family: { family: "Groundwork MEP", type, metadata: { cadSystem: system } } };
  const ports: CadPort[] = [{ id: `${id}:start`, elementId: id, end: "start", system, medium }];
  if (routed || ["valve", "bend", "reducer", "junction", "access"].includes(type)) ports.push({ id: `${id}:end`, elementId: id, end: "end", system, medium });
  const state = cadNetworkState(design);
  const next = setCadMep(design, { ...cadMep(design), enabled: true, elements: [...cadMep(design).elements, element] });
  return { element, design: { ...next, cadNetworks: { ...state, equipment: [...state.equipment, { elementId: id, type, system, ports, mountingRotationDeg: options.rotationDeg ?? 0 } ] } } };
}

export function updateCadRoutePoint(design: Design, id: string, index: number, point: MepPoint): Design {
  finite(point.x, "X"); finite(point.y, "Elevation"); finite(point.z, "Z");
  const mep = cadMep(design); const element = mep.elements.find(item => item.id === id);
  if (!element || !Number.isInteger(index) || index < 0 || index >= element.route.length) throw new Error("Route point does not exist.");
  const route = element.route.map((existing, current) => current === index ? { ...point } : existing);
  if (route.some((p, i) => i && distance(p, route[i - 1]) < .001)) throw new Error("Route segments must remain at least 1 mm long.");
  return setCadMep(design, { ...mep, elements: mep.elements.map(item => item.id === id ? { ...item, route } : item) });
}
export function moveCadRouteSegment(design: Design, id: string, index: number, delta: MepPoint): Design {
  finite(delta.x, "X offset"); finite(delta.y, "Y offset"); finite(delta.z, "Z offset");
  const element = cadMep(design).elements.find(item => item.id === id);
  if (!element || index < 0 || index >= element.route.length - 1) throw new Error("Route segment does not exist.");
  const route = element.route.map((point, i) => i === index || i === index + 1 ? { x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z } : point);
  const next = setCadMep(design, { ...cadMep(design), elements: cadMep(design).elements.map(item => item.id === id ? { ...item, route } : item) }); validateCadNetworks(next); return next;
}
export function insertCadRouteBend(design: Design, id: string, index: number): Design {
  const mep = cadMep(design), element = mep.elements.find(item => item.id === id);
  if (!element || index < 0 || index >= element.route.length - 1) throw new Error("Choose an existing segment.");
  const first = element.route[index], second = element.route[index + 1];
  const route = [...element.route.slice(0, index + 1), { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, z: (first.z + second.z) / 2 }, ...element.route.slice(index + 1)];
  return setCadMep(design, { ...mep, elements: mep.elements.map(item => item.id === id ? { ...item, route } : item) });
}
export function removeCadRouteBend(design: Design, id: string, index: number): Design {
  const mep = cadMep(design), element = mep.elements.find(item => item.id === id);
  if (!element || index < 1 || index >= element.route.length - 1) throw new Error("Only internal bends can be removed.");
  const next = setCadMep(design, { ...mep, elements: mep.elements.map(item => item.id === id ? { ...item, route: item.route.filter((_, i) => i !== index) } : item) }); validateCadNetworks(next); return next;
}
export function connectCadPorts(design: Design, fromPortId: string, toPortId: string, options: { align?: boolean } = {}): Design {
  const state = cadNetworkState(design), ports = cadPorts(design), a = ports.find(port => port.id === fromPortId), b = ports.find(port => port.id === toPortId);
  if (!a || !b || !cadPortsCompatible(a, b)) throw new Error("Connectors are missing or incompatible. Cross-system and containment-to-conductor connections are prohibited.");
  if (state.connections.some(link => link.fromPortId === fromPortId && link.toPortId === toPortId || link.fromPortId === toPortId && link.toPortId === fromPortId)) throw new Error("Ports are already connected.");
  const pa = cadPortPoint(design, a), pb = cadPortPoint(design, b); if (!pa || !pb) throw new Error("Connector geometry is missing.");
  let next = design;
  if (distance(pa, pb) > .005) {
    if (!options.align) throw new Error("Ports are not coincident (5 mm tolerance). Use explicit Connect and align or edit their coordinates first.");
    const item = cadMep(design).elements.find(element => element.id === a.elementId)!;
    next = updateCadRoutePoint(design, item.id, a.end === "end" ? item.route.length - 1 : 0, pb);
  }
  const connection: CadConnection = { id: uuid(), fromPortId, toPortId };
  return { ...next, cadNetworks: { ...state, connections: [...state.connections, connection] } };
}
export function disconnectCadPorts(design: Design, connectionId: string): Design { const state = cadNetworkState(design); return { ...design, cadNetworks: { ...state, connections: state.connections.filter(link => link.id !== connectionId) } }; }
export function removeCadNetworkElement(design: Design, id: string): Design {
  const state = cadNetworkState(design); const ports = new Set(state.equipment.filter(item => item.elementId === id).flatMap(item => item.ports.map(port => port.id)));
  const next = setCadMep(design, { ...cadMep(design), elements: cadMep(design).elements.filter(item => item.id !== id) });
  return { ...next, cadNetworks: { ...state, equipment: state.equipment.filter(item => item.elementId !== id), connections: state.connections.filter(link => !ports.has(link.fromPortId) && !ports.has(link.toPortId)), circuits: state.circuits.map(circuit => ({ ...circuit, panelId: circuit.panelId === id ? "" : circuit.panelId, deviceIds: circuit.deviceIds.filter(value => value !== id), cableIds: circuit.cableIds.filter(value => value !== id) })) } };
}
export function validateCadNetworks(design: Design): void {
  const state = cadNetworkState(design), elements = cadMep(design).elements, ids = new Set(elements.map(item => item.id));
  if (state.version !== 1 || !Array.isArray(state.equipment) || !Array.isArray(state.connections) || !Array.isArray(state.circuits) || !Array.isArray(state.calculations)) throw new Error("Unsupported or malformed network metadata.");
  if (ids.size !== elements.length || elements.length > 10000) throw new Error("MEP elements require unique bounded identifiers.");
  const equipmentIds = new Set<string>(), portIds = new Set<string>(), linkIds = new Set<string>(), circuitIds = new Set<string>();
  for (const item of elements) {
    if (!item.id || !Array.isArray(item.route) || !item.route.length || item.route.length > 1000) throw new Error("MEP element geometry is missing or excessive.");
    item.route.forEach(point => { finite(point.x, "Route X"); finite(point.y, "Route Y"); finite(point.z, "Route Z"); });
    finite(item.width, "MEP width", item.kind === "duct" || item.kind === "cable-tray" ? .001 : 0, 100); finite(item.height, "MEP height", item.kind === "duct" || item.kind === "cable-tray" ? .001 : 0, 100); finite(item.diameter, "MEP diameter", item.kind === "pipe" ? .001 : 0, 100);
  }
  for (const item of state.equipment) {
    if (!ids.has(item.elementId) || equipmentIds.has(item.elementId)) throw new Error("Network metadata references a missing or duplicate element."); equipmentIds.add(item.elementId);
    if (!(item.system in CAD_SYSTEM_LABELS) || !(item.type in CAD_DEVICE_LABELS) || !Array.isArray(item.ports) || !item.ports.length || item.ports.length > 16) throw new Error("Equipment type/system/ports are invalid.");
    if ((item.system === "electrical") !== electricalTypes.has(item.type)) throw new Error("Equipment type crosses incompatible disciplines.");
    const expectedMedium = ["conduit", "tray"].includes(item.type) ? "containment" : item.system === "electrical" ? "electrical" : item.system === "hvac" ? "air" : "fluid";
    for (const port of item.ports) { if (!port.id || portIds.has(port.id) || port.elementId !== item.elementId || port.system !== item.system || port.medium !== expectedMedium || !["start", "end"].includes(port.end)) throw new Error("Connector identifiers/system metadata are invalid."); portIds.add(port.id); }
  }
  const ports = new Map(cadPorts(design).map(port => [port.id, port]));
  for (const link of state.connections) { const a = ports.get(link.fromPortId), b = ports.get(link.toPortId); if (!link.id || linkIds.has(link.id) || !a || !b || !cadPortsCompatible(a, b)) throw new Error("Explicit connection is invalid or crosses incompatible systems."); linkIds.add(link.id); }
  for (const circuit of state.circuits) { if (!circuit.id || circuitIds.has(circuit.id)) throw new Error("Circuit IDs must be unique."); circuitIds.add(circuit.id); if (circuit.deviceIds.some(id => !ids.has(id)) || circuit.cableIds.some(id => !ids.has(id))) throw new Error("Circuit references a missing element."); }
}
export function cadHostFingerprint(design: Design, id: string): string | undefined {
  const host = (design.community?.drafts ?? design.infra?.drafts ?? design.drafts ?? []).find(item => item.id === id);
  return host ? JSON.stringify({ ...host, label: undefined, color: undefined, visible: undefined, locked: undefined, locks: undefined, phaseId: undefined }) : undefined;
}
export function cadNetworkIssues(design: Design): CadNetworkIssue[] {
  const state = cadNetworkState(design), ports = cadPorts(design), portMap = new Map(ports.map(port => [port.id, port])), issues: CadNetworkIssue[] = [];
  const connected = new Set<string>();
  for (const link of state.connections) {
    const a = portMap.get(link.fromPortId), b = portMap.get(link.toPortId);
    if (!a || !b || !cadPortsCompatible(a, b)) { issues.push({ objectId: a?.elementId ?? b?.elementId ?? "", kind: "incompatible", text: "Connection references a missing or incompatible port." }); continue; }
    const pa = cadPortPoint(design, a), pb = cadPortPoint(design, b);
    if (!pa || !pb || distance(pa, pb) > .005) issues.push({ objectId: a.elementId, kind: "broken", text: "Connected ports are physically separated; review or explicitly realign the route." });
    else { connected.add(a.id); connected.add(b.id); }
  }
  for (const equipment of state.equipment) {
    const architectural = design.community?.drafts ?? design.infra?.drafts ?? design.drafts ?? [];
    const host = equipment.hostId ? architectural.find(item => item.id === equipment.hostId) : undefined;
    if (equipment.hostId && !host) issues.push({ objectId: equipment.elementId, kind: "broken", text: "Hosted object was removed. Review device mounting and affected routes." });
    else if (host && equipment.hostFingerprint && equipment.hostFingerprint !== cadHostFingerprint(design, host.id)) issues.push({ objectId: equipment.elementId, kind: "broken", text: "Hosting geometry changed. Device coordinates are preserved; review mounting and affected routes before accepting the new host." });
    const element = cadMep(design).elements.find(item => item.id === equipment.elementId);
    for (const port of equipment.ports) if (!connected.has(port.id)) issues.push({ objectId: equipment.elementId, kind: "open", text: `${element?.name ?? equipment.type}: open ${port.end} connector (${CAD_SYSTEM_LABELS[equipment.system]}).` });
    if (equipment.system === "electrical" && !["panel", "conduit", "tray"].includes(equipment.type) && !state.circuits.some(circuit => circuit.deviceIds.includes(equipment.elementId) || circuit.cableIds.includes(equipment.elementId))) issues.push({ objectId: equipment.elementId, kind: "unassigned", text: `${element?.name ?? equipment.type}: not assigned to a circuit.` });
  }
  return issues;
}
export function traceCadNetwork(design: Design, elementId: string, onlyConductors = false): string[] {
  const state = cadNetworkState(design), ports = new Map(cadPorts(design).map(port => [port.id, port]));
  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adjacency.has(a)) adjacency.set(a, new Set()); adjacency.get(a)!.add(b); };
  for (const link of state.connections) { const a = ports.get(link.fromPortId), b = ports.get(link.toPortId); if (!a || !b || !cadPortsCompatible(a, b) || onlyConductors && a.medium !== "electrical") continue; const pa = cadPortPoint(design, a), pb = cadPortPoint(design, b); if (!pa || !pb || distance(pa, pb) > .005) continue; add(a.elementId, b.elementId); add(b.elementId, a.elementId); }
  const visited = new Set([elementId]), queue = [elementId];
  for (let i = 0; i < queue.length; i++) for (const id of adjacency.get(queue[i]) ?? []) if (!visited.has(id)) { visited.add(id); queue.push(id); }
  return [...visited];
}
export function cadNetworkQuantities(design: Design) {
  const elements = cadMep(design).elements, metadata = new Map(cadNetworkState(design).equipment.map(item => [item.elementId, item]));
  const groups = new Map<string, { type: string; system: string; count: number; lengthM: number }>();
  for (const item of elements) { const authored = metadata.get(item.id); const key = `${authored?.system ?? item.system ?? "legacy"}/${authored?.type ?? item.kind}`; const group = groups.get(key) ?? { type: authored?.type ?? item.kind, system: authored?.system ?? item.system ?? "legacy", count: 0, lengthM: 0 }; group.count++; group.lengthM += cadRouteLength(item); groups.set(key, group); }
  return [...groups.values()];
}
export function cadNetworkFingerprint(design: Design): string {
  const state = cadNetworkState(design);
  const value = JSON.stringify({ elements: cadMep(design).elements.map(({ visible: _visible, color: _color, ...element }) => element), equipment: state.equipment, connections: state.connections, circuits: state.circuits, fluidInputs: state.fluidInputs, hosts: state.equipment.filter(item => item.hostId).map(item => ({ id: item.hostId, geometry: cadHostFingerprint(design, item.hostId!) })) });
  let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, "0");
}
export function assessCadCircuit(design: Design, circuitId: string): CadNetworkCalculation {
  const state = cadNetworkState(design), circuit = state.circuits.find(item => item.id === circuitId), metadata = new Map(state.equipment.map(item => [item.elementId, item])), elements = new Map(cadMep(design).elements.map(item => [item.id, item]));
  if (!circuit || !circuit.basis.trim() || metadata.get(circuit.panelId)?.type !== "panel") throw new Error("Assign a valid source panel and supply an engineering design basis.");
  if (!circuit.deviceIds.length || !circuit.cableIds.length) throw new Error("Circuit requires assigned terminal devices and physical cable runs.");
  const connected = new Set(traceCadNetwork(design, circuit.panelId, true));
  if ([...circuit.deviceIds, ...circuit.cableIds].some(id => !connected.has(id))) throw new Error("Circuit members are disconnected from the panel. Assigning a circuit does not physically connect ports.");
  let powerW = 0, lengthM = 0;
  for (const id of circuit.deviceIds) { const element = elements.get(id); if (!element || metadata.get(id)?.system !== "electrical" || ["conduit", "tray", "cable", "panel"].includes(metadata.get(id)!.type)) throw new Error("Circuit terminals must be electrical devices, not containment."); powerW += finite(element.ratedPowerKw, `${element.name} load kW`, 0, 1e7) * 1000; }
  for (const id of circuit.cableIds) { const element = elements.get(id); if (!element || metadata.get(id)?.type !== "cable") throw new Error("Only typed cable runs supply conductor lengths; trays and conduits are separate."); lengthM += cadRouteLength(element); }
  const resistance = finite(circuit.inputs.conductorResistanceOhmPerM, "Conductor resistance Ω/m", 0, 100), reactance = finite(circuit.inputs.conductorReactanceOhmPerM, "Conductor reactance Ω/m", 0, 100);
  const loop = circuit.inputs.phases === 1 ? 2 : 1;
  const inputs = { ...circuit.inputs, connectedPowerW: powerW, conductorResistanceOhm: resistance * lengthM * loop, conductorReactanceOhm: reactance * lengthM * loop } as ElectricalCircuitInput;
  const result = analyzeElectricalCircuit(inputs);
  return { id: `circuit-${circuitId}`, scope: "circuit", targetId: circuitId, sourceRevision: design.cad?.revision ?? 0, fingerprint: cadNetworkFingerprint(design), method: "Groundwork analyzeElectricalCircuit; supplied impedance/protection criteria", units: "V, A, W, m, Ω", basis: circuit.basis, inputs: { ...inputs, routeLengthM: lengthM, deviceIds: circuit.deviceIds, cableIds: circuit.cableIds, panelId: circuit.panelId }, result, warnings: [...result.warnings, "Circuit routes are aggregated; branched load distribution, discrimination and parallel conductors require a separately authored network."] };
}
export function assessCadWater(design: Design, system: "cold-water" | "hot-water"): CadNetworkCalculation {
  if (system !== "cold-water" && system !== "hot-water") throw new Error("Pressure analysis supports cold/hot pressure water only, not gravity drainage or venting.");
  const state = cadNetworkState(design), equipment = state.equipment.filter(item => item.system === system), elements = new Map(cadMep(design).elements.map(item => [item.id, item]));
  if (!state.fluidInputs?.basis?.trim()) throw new Error("Supply a fluid-property and demand design basis.");
  const ports = equipment.flatMap(item => item.ports); if (!ports.length) throw new Error("No typed pressure-water ports exist in this system.");
  const parent = new Map(ports.map(port => [port.id, port.id]));
  const root = (id: string): string => { let value = id; while (parent.get(value) !== value) value = parent.get(value)!; return value; };
  for (const link of state.connections) if (parent.has(link.fromPortId) && parent.has(link.toPortId)) { const a = ports.find(port => port.id === link.fromPortId)!, b = ports.find(port => port.id === link.toPortId)!; const pa = cadPortPoint(design, a)!, pb = cadPortPoint(design, b)!; if (distance(pa, pb) > .005) throw new Error("Pressure network has physically broken connections."); parent.set(root(a.id), root(b.id)); }
  for (const item of equipment.filter(item => !routedTypes.has(item.type))) if (item.ports.length > 1) parent.set(root(item.ports[0].id), root(item.ports[1].id));
  const nodeMap = new Map<string, FluidNetwork["nodes"][number]>();
  for (const port of ports) { const id = root(port.id), point = cadPortPoint(design, port); if (!point) throw new Error("Water connector geometry is missing."); if (!nodeMap.has(id)) nodeMap.set(id, { id, elevationM: point.y, demandM3s: 0 }); }
  for (const item of equipment) { const node = nodeMap.get(root(item.ports[0].id))!; if (item.type === "source") { const fixed = finite(item.fixedHeadM, "Source total head m", -1e5, 1e5); if (node.fixedPotential !== undefined && node.fixedPotential !== fixed) throw new Error("Conflicting source heads meet at one junction."); node.fixedPotential = fixed; } else if (["fixture", "outlet", "equipment"].includes(item.type)) node.demandM3s += finite(item.demandLps, `${elements.get(item.elementId)?.name ?? item.type} demand L/s`, 0, 10000) / 1000; }
  const links: FluidNetwork["links"] = equipment.filter(item => routedTypes.has(item.type)).map(item => { const element = elements.get(item.elementId)!; if (item.type !== "pipe" && item.type !== "riser") throw new Error("Unsupported water containment type."); return { id: element.id, from: root(item.ports[0].id), to: root(item.ports[1].id), lengthM: cadRouteLength(element), diameterM: finite(element.diameter, "Pipe diameter m", .001, 5), roughnessM: finite(item.roughnessM, "Pipe roughness m", 0, .1), minorLossK: finite(item.minorLossK, "Minor loss coefficient K", 0, 1e5) }; });
  const network: FluidNetwork = { version: 1, medium: "water", densityKgM3: finite(state.fluidInputs.densityKgM3, "Water density kg/m³", 1, 10000), kinematicViscosityM2s: finite(state.fluidInputs.kinematicViscosityM2s, "Kinematic viscosity m²/s", 1e-10, 1), nodes: [...nodeMap.values()], links };
  const result = solveFluidNetwork(network);
  return { id: `water-${system}`, scope: "water", targetId: system, sourceRevision: design.cad?.revision ?? 0, fingerprint: cadNetworkFingerprint(design), method: "Groundwork steady pressure-network solver; explicit water properties and demands", units: "m, m³/s, kg/m³", basis: state.fluidInputs.basis, inputs: network, result, warnings: result.warnings };
}
export function assessCadGravity(design: Design, system: "sanitary" | "stormwater") {
  if (system !== "sanitary" && system !== "stormwater") throw new Error("Only sanitary/stormwater geometry supports this gravity-slope review.");
  const state = cadNetworkState(design), elements = new Map(cadMep(design).elements.map(item => [item.id, item]));
  return state.equipment.filter(item => item.system === system && ["pipe", "riser"].includes(item.type)).map(item => {
    const element = elements.get(item.elementId)!; const start = element.route[0], end = element.route[element.route.length - 1];
    let slopePct: number | null = null;
    let reverseSlope = false;
    for (let i = 1; i < element.route.length; i++) {
      const a = element.route[i - 1], b = element.route[i];
      const drop = a.y - b.y;
      if (drop < -1e-6) reverseSlope = true;
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      if (run <= 1e-9) continue;
      const segmentSlope = drop / run * 100;
      slopePct = Math.min(slopePct ?? segmentSlope, segmentSlope);
    }
    const { minimumSlopePct } = item;
    const status = minimumSlopePct === undefined ? "incomplete"
      : reverseSlope || (slopePct !== null && slopePct + 1e-9 < minimumSlopePct) ? "review" : "satisfies-supplied-slope";
    return { elementId: item.elementId, name: element.name, invertStartM: start.y - element.diameter / 2, invertEndM: end.y - element.diameter / 2, slopePct, minimumSlopePct, status, scope: "Geometry slope only; no drainage capacity, venting, trap, surcharge or national-code assessment" };
  });
}
