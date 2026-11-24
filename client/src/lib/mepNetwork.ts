import type { MepDesign, MepElement, MepSystemType } from "../types";
import { SpatialHash2D } from "./performance";

export interface MepNetworkNode {
  id: string;
  elementId: string;
  name: string;
  system: MepSystemType;
  degree: number;
  isSource: boolean;
  isTerminal: boolean;
}

export interface MepNetworkEdge {
  from: string;
  to: string;
  system: MepSystemType;
}

export interface MepNetworkReport {
  nodes: MepNetworkNode[];
  edges: MepNetworkEdge[];
  components: string[][];
  orphanIds: string[];
  cycles: string[][];
  systemContinuity: Record<string, { elements: number; components: number; connected: boolean }>;
  flow: { elementId: string; designFlow: number; capacity: number; utilization: number; unit: string }[];
  electrical: { connectedKw: number; demandKw: number; currentA: number; voltageDropPct: number; faultScreenKA: number };
  fire: { pipeCount: number; terminalCount: number; connected: boolean; warnings: string[] };
  warnings: string[];
}

const routeLength = (element: MepElement) => element.route.reduce((sum, point, index) => index ? sum + Math.hypot(point.x - element.route[index - 1].x, point.y - element.route[index - 1].y, point.z - element.route[index - 1].z) : 0, 0);

export function defaultSystem(element: Pick<MepElement, "kind" | "system">): MepSystemType {
  if (element.system) return element.system;
  if (element.kind === "duct") return "hvac-supply";
  if (element.kind === "pipe") return "plumbing-supply";
  if (element.kind === "cable-tray" || element.kind === "equipment") return "electrical-power";
  return "controls";
}

export function electricalPlanningLoads(elements: MepElement[], demandFactor: number) {
  const connectedKw = elements.reduce((sum, item) => sum + (item.ratedPowerKw ?? 0), 0);
  return { connectedKw, demandKw: connectedKw * Math.min(Math.max(demandFactor, 0), 1) };
}

export function analyzeMepNetwork(design: MepDesign | undefined): MepNetworkReport {
  // Hidden elements remain part of the engineering network.
  const elements = design?.elements ?? [];
  const byId = new Map(elements.map((item) => [item.id, item]));
  const adjacency = new Map<string, Set<string>>();
  for (const element of elements) adjacency.set(element.id, new Set());
  const edges: MepNetworkEdge[] = [];
  const invalidConnections: string[] = [];
  const edgeKeys = new Set<string>();

  for (const element of elements) {
    for (const targetId of element.connectedTo ?? []) {
      const target = byId.get(targetId);
      if (!target) { invalidConnections.push(`${element.name} references missing element ${targetId}.`); continue; }
      if (target.id === element.id) { invalidConnections.push(`${element.name} is connected to itself.`); continue; }
      if (defaultSystem(element) !== defaultSystem(target)) { invalidConnections.push(`${element.name} has a cross-system connection to ${target.name}; excluded from continuity.`); continue; }
      adjacency.get(element.id)?.add(targetId);
      adjacency.get(targetId)?.add(element.id);
      const edgeKey = JSON.stringify([element.id, targetId].sort());
      if (!edgeKeys.has(edgeKey)) { edgeKeys.add(edgeKey); edges.push({ from: element.id, to: targetId, system: defaultSystem(element) }); }
    }
  }

  const components: string[][] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id)) continue;
    const queue = [element.id];
    const component: string[] = [];
    seen.add(element.id);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      component.push(id);
      for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    components.push(component);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>(), active = new Set<string>();
  // Iterative DFS avoids overflowing the call stack on long routed networks.
  for (const element of elements) {
    if (visited.has(element.id)) continue;
    const stack: { id: string; parent?: string; neighbors: Iterator<string> }[] = [];
    const enter = (id: string, parent?: string) => {
      visited.add(id); active.add(id);
      stack.push({ id, parent, neighbors: (adjacency.get(id) ?? new Set<string>()).values() });
    };
    enter(element.id);
    while (stack.length) {
      const frame = stack[stack.length - 1], next = frame.neighbors.next();
      if (next.done) { active.delete(frame.id); stack.pop(); continue; }
      if (next.value === frame.parent) continue;
      if (!visited.has(next.value)) enter(next.value, frame.id);
      else if (active.has(next.value) && cycles.length < 100) {
        const start = stack.findIndex(item => item.id === next.value);
        if (start >= 0) cycles.push([...stack.slice(start).map(item => item.id), next.value]);
      }
    }
  }

  const systems = new Map<string, MepElement[]>();
  for (const element of elements) {
    const system = defaultSystem(element);
    const list = systems.get(system) ?? [];
    list.push(element);
    systems.set(system, list);
  }
  const systemContinuity: MepNetworkReport["systemContinuity"] = {};
  for (const [system, list] of systems) {
    const ids = new Set(list.map((item) => item.id));
    const componentCount = components.filter((component) => component.some((id) => ids.has(id))).length;
    systemContinuity[system] = { elements: list.length, components: componentCount, connected: list.length <= 1 || componentCount === 1 };
  }

  const p = design?.planning;
  const flow = elements.filter((element) => element.kind === "duct" || element.kind === "pipe").map((element) => {
    if (element.kind === "duct") {
      const velocity = Math.max(p?.designAirVelocityMps ?? 4, 0);
      const capacity = Math.max(element.width * element.height * velocity * 3600, 0);
      const totalTarget = Math.max((p?.areaM2 ?? 0) * (p?.ceilingHeightM ?? 0) * (p?.airChangesPerHour ?? 0), 0);
      const designFlow = totalTarget;
      return { elementId: element.id, designFlow, capacity, utilization: designFlow / Math.max(capacity, 0.001), unit: "m3/h" };
    }
    const velocity = Math.max(p?.pipeVelocityMps ?? 1.5, 0);
    const capacity = Math.PI * Math.max(element.diameter, 0) ** 2 / 4 * velocity * 1000;
    const designFlow = Math.max(p?.plumbingFlowLps ?? 0, 0);
    return { elementId: element.id, designFlow, capacity, utilization: designFlow / Math.max(capacity, 0.001), unit: "L/s" };
  });

  const electricalElements = elements.filter((item) => defaultSystem(item) === "electrical-power");
  const { connectedKw, demandKw } = electricalPlanningLoads(electricalElements, p?.electricalDemandFactor ?? 0.8);
  const voltage = Math.max(p?.designVoltageV ?? 230, 1);
  const currentA = demandKw * 1000 / voltage;
  const maxRoute = electricalElements.reduce((max, element) => Math.max(max, routeLength(element)), 0);
  const conductorResistanceOhmPerKm = 7.41; // conservative 2.5 mm2 copper planning reference.
  const voltageDropPct = currentA * conductorResistanceOhmPerKm * (maxRoute / 1000) * 2 / voltage * 100;
  const faultScreenKA = voltage / Math.max((conductorResistanceOhmPerKm / 1000) * Math.max(maxRoute, 1), 0.01) / 1000;

  const fire = elements.filter((item) => defaultSystem(item) === "fire-protection");
  const fireTerminals = fire.filter((item) => item.kind === "fixture");
  const firePipes = fire.filter((item) => item.kind === "pipe");
  const fireConnected = fire.length === 0 || (firePipes.length > 0 && fireTerminals.length > 0 && systemContinuity["fire-protection"]?.components === 1 && fire.some(item => item.kind === "equipment"));
  const fireWarnings = [
    ...(fire.length && !firePipes.length ? ["Fire-protection system contains no pipe network."] : []),
    ...(fire.length && !fireTerminals.length ? ["Fire-protection system contains no terminal/sprinkler fixtures."] : []),
    ...(fire.length && !fireConnected ? ["Fire-protection graph contains disconnected elements."] : []),
  ];

  const orphanIds = elements.filter((item) => elements.length > 1 && (adjacency.get(item.id)?.size ?? 0) === 0).map((item) => item.id);
  const warnings = [
    ...invalidConnections,
    "Per-route capacity is compared with full system demand; topology alone cannot determine branch flows.",
    "Electrical screens use a single-phase copper reference circuit and require verified conductor and protection inputs.",
    ...Object.entries(systemContinuity).filter(([, report]) => !report.connected).map(([system, report]) => `${system} is split across ${report.components} disconnected components.`),
    ...flow.filter((item) => item.utilization > 1).map((item) => `${byId.get(item.elementId)?.name ?? item.elementId} design flow exceeds the modeled route capacity.`),
    ...(voltageDropPct > 5 ? [`Electrical voltage-drop screen is ${voltageDropPct.toFixed(1)}%; conductor sizing requires review.`] : []),
    ...fireWarnings,
  ];
  const nodes = elements.map((element): MepNetworkNode => ({
    id: element.id,
    elementId: element.id,
    name: element.name,
    system: defaultSystem(element),
    degree: adjacency.get(element.id)?.size ?? 0,
    isSource: element.kind === "equipment",
    isTerminal: element.kind === "fixture" || (adjacency.get(element.id)?.size ?? 0) <= 1,
  }));
  return {
    nodes, edges, components, orphanIds, cycles, systemContinuity, flow,
    electrical: { connectedKw, demandKw, currentA, voltageDropPct, faultScreenKA },
    fire: { pipeCount: firePipes.length, terminalCount: fireTerminals.length, connected: fireConnected, warnings: fireWarnings },
    warnings,
  };
}

export function autoConnectMepSystem(design: MepDesign, system: MepSystemType, toleranceM = 0.2): MepDesign {
  if (!Number.isFinite(toleranceM) || toleranceM < 0) return design;
  const matching = design.elements.filter(element => defaultSystem(element) === system && element.route.length);
  const connections = new Map(design.elements.map(element => [element.id, new Set(element.connectedTo ?? [])]));
  const index = new SpatialHash2D<{ elementId: string; y: number }>(Math.max(1, toleranceM));
  for (const element of matching) for (const [i, point] of [element.route[0], element.route[element.route.length - 1]].entries()) {
    index.insert({ id: `${element.id}:${i}`, x: point.x, z: point.z, radius: 0, value: { elementId: element.id, y: point.y } });
  }
  for (const element of matching) for (const point of [element.route[0], element.route[element.route.length - 1]]) {
    for (const candidate of index.query(point.x, point.z, toleranceM)) {
      if (candidate.value.elementId === element.id || Math.hypot(candidate.x - point.x, candidate.value.y - point.y, candidate.z - point.z) > toleranceM) continue;
      connections.get(element.id)?.add(candidate.value.elementId);
      connections.get(candidate.value.elementId)?.add(element.id);
    }
  }
  return { ...design, elements: design.elements.map(element => ({ ...element, connectedTo: [...(connections.get(element.id) ?? [])] })) };
}

