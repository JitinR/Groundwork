import { useState } from "react";
import type { ConstructionPhase, MepDesign, MepElement, MepElementKind, MepSystemType } from "../types";
import { Button, Input, Select, Toggle } from "./ui";
import { DEFAULT_MEP_PLANNING, MEP_KINDS, buildMepReport, makeMepElement, mepClashWarnings, mepPlanningSummary, normalizeMep } from "../lib/mep";
import { familyForId, familyForMepKind, familyMetadata } from "../lib/families";
import { analyzeMepNetwork, autoConnectMepSystem, defaultSystem } from "../lib/mepNetwork";

export function MepPanel({ value, onChange, phases }: { value: MepDesign | undefined; onChange: (value: MepDesign) => void; phases?: ConstructionPhase[] }) {
  const mep = normalizeMep(value);
  const phaseOptions = phases?.slice(0, 1000);
  const [kind, setKind] = useState<MepElementKind>("duct");
  const [connectSystem, setConnectSystem] = useState<MepSystemType>("hvac-supply");
  const planning = mep.planning ?? DEFAULT_MEP_PLANNING;
  const summary = mepPlanningSummary(mep);
  const network = analyzeMepNetwork(mep);
  const patchPlanning = (key: keyof typeof planning, next: number) => onChange({ ...mep, planning: { ...planning, [key]: Math.max(next, 0) } });
  const exportReport = () => {
    const blob = new Blob([buildMepReport(mep)], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "preliminary-mep-report.txt"; link.click(); URL.revokeObjectURL(url);
  };
  const patch = (id: string, next: Partial<MepElement>) => onChange({ ...mep, elements: mep.elements.map((item) => item.id === id ? { ...item, ...next } : item) });
  return <div className="space-y-3">
    <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">Preliminary MEP planning only. These rule-of-thumb screens are not code-compliant engineering or a construction document.</p>
    <Toggle checked={mep.enabled} onChange={(enabled) => onChange({ ...mep, enabled })} label="Show MEP layer" />
     <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-200">Planning inputs</p><Button size="sm" variant="secondary" onClick={exportReport}>Download report</Button></div>
      <div className="grid grid-cols-2 gap-2"><Input label="Area (m²)" type="number" min={0} step={1} value={planning.areaM2} onChange={(e) => patchPlanning("areaM2", Number(e.target.value) || 0)} /><Input label="Ceiling (m)" type="number" min={0} step={0.1} value={planning.ceilingHeightM} onChange={(e) => patchPlanning("ceilingHeightM", Number(e.target.value) || 0)} /><Input label="Occupants" type="number" min={0} step={1} value={planning.occupancy} onChange={(e) => patchPlanning("occupancy", Number(e.target.value) || 0)} /><Input label="Air changes / h" type="number" min={0} step={0.5} value={planning.airChangesPerHour} onChange={(e) => patchPlanning("airChangesPerHour", Number(e.target.value) || 0)} /><Input label="Cooling W/m²" type="number" min={0} step={5} value={planning.coolingLoadWPerM2} onChange={(e) => patchPlanning("coolingLoadWPerM2", Number(e.target.value) || 0)} /><Input label="Duct velocity (m/s)" type="number" min={0} step={0.5} value={planning.designAirVelocityMps} onChange={(e) => patchPlanning("designAirVelocityMps", Number(e.target.value) || 0)} /><Input label="Pipe flow (L/s)" type="number" min={0} step={0.5} value={planning.plumbingFlowLps} onChange={(e) => patchPlanning("plumbingFlowLps", Number(e.target.value) || 0)} /><Input label="Pipe velocity (m/s)" type="number" min={0} step={0.1} value={planning.pipeVelocityMps} onChange={(e) => patchPlanning("pipeVelocityMps", Number(e.target.value) || 0)} /><Input label="Min clearance (m)" type="number" min={0} step={0.05} value={planning.minimumClearanceM} onChange={(e) => patchPlanning("minimumClearanceM", Number(e.target.value) || 0)} /><Input label="Demand factor" type="number" min={0} max={1} step={0.05} value={planning.electricalDemandFactor} onChange={(e) => patchPlanning("electricalDemandFactor", Number(e.target.value) || 0)} /></div>
       <div className="grid grid-cols-2 gap-2 text-xs text-slate-400"><p>Airflow <strong className="text-slate-200">{summary.airflowM3h.toFixed(0)} m³/h</strong></p><p>Cooling <strong className="text-slate-200">{summary.coolingLoadKw.toFixed(2)} kW</strong></p><p>Electrical <strong className="text-slate-200">{summary.demandLoadKw.toFixed(2)} kW demand</strong></p><p>Duct capacity <strong className="text-slate-200">{summary.ductCapacityM3h.toFixed(0)} m³/h</strong></p><p>Pipe capacity <strong className="text-slate-200">{summary.pipeCapacityLps.toFixed(1)} L/s</strong></p><p>Duct loss screen <strong className="text-slate-200">{summary.ductPressureLossPa.toFixed(0)} Pa</strong></p><p>Pipe loss screen <strong className="text-slate-200">{summary.pipePressureLossPa.toFixed(0)} Pa</strong></p><p>Connected routes <strong className="text-slate-200">{summary.connectedSystems}</strong></p></div>
    </div>
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-200">Connected-system graph</p><Button size="sm" variant="outline" onClick={() => onChange(autoConnectMepSystem(mep, connectSystem))} disabled={mep.elements.length < 2}>Connect touching endpoints</Button></div>
      <Select label="System to connect (within 0.20 m)" value={connectSystem} onChange={e => setConnectSystem(e.target.value as MepSystemType)}>{["hvac-supply", "hvac-return", "plumbing-supply", "plumbing-drain", "electrical-power", "fire-protection", "controls"].map(system => <option key={system} value={system}>{system}</option>)}</Select>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
        <p>Graph components <strong className="text-slate-200">{network.components.length}</strong></p>
        <p>Orphans <strong className={network.orphanIds.length ? "text-amber-300" : "text-emerald-300"}>{network.orphanIds.length}</strong></p>
        <p>Electrical demand <strong className="text-slate-200">{network.electrical.demandKw.toFixed(2)} kW</strong></p>
        <p>Voltage drop screen <strong className={network.electrical.voltageDropPct > 5 ? "text-amber-300" : "text-slate-200"}>{network.electrical.voltageDropPct.toFixed(2)}%</strong></p>
        <p>Fire pipes <strong className="text-slate-200">{network.fire.pipeCount}</strong></p>
        <p>Fire terminals <strong className="text-slate-200">{network.fire.terminalCount}</strong></p>
      </div>
      {network.warnings.map((warning) => <p key={warning} className="text-[11px] text-amber-300">• {warning}</p>)}
    </div>
    <div className="flex gap-2"><Select label="Element" value={kind} onChange={(event) => setKind(event.target.value as MepElementKind)}>{MEP_KINDS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</Select><Button size="sm" className="mt-6" onClick={() => onChange({ ...mep, elements: [...mep.elements, makeMepElement(kind, mep.elements.length)] })}>+ Add {MEP_KINDS.find((item) => item.kind === kind)?.label.toLowerCase()}</Button></div>
    {mep.elements.map((item) => <div key={item.id} className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold text-slate-200">{item.name}</span><button className="text-xs text-rose-400" onClick={() => onChange({ ...mep, elements: mep.elements.filter((candidate) => candidate.id !== item.id).map(candidate => ({ ...candidate, connectedTo: candidate.connectedTo?.filter(id => id !== item.id) })) })}>Remove</button></div>
      {phaseOptions && <Select label="Construction phase" value={item.phaseId ?? ""} onChange={(e) => patch(item.id, { phaseId: e.target.value || undefined })}>
        <option value="">Unassigned / always visible</option>
        {item.phaseId && !phaseOptions.some((phase) => phase.id === item.phaseId) && <option value={item.phaseId}>Missing or outside selection limit ({item.phaseId})</option>}
        {phaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
      </Select>}
         <div className="grid grid-cols-2 gap-2"><Input label="Name" value={item.name} onChange={(e) => patch(item.id, { name: e.target.value })} /><Select label="Type" value={item.kind} onChange={(e) => patch(item.id, { kind: e.target.value as MepElementKind })}>{MEP_KINDS.map((kind) => <option key={kind.kind} value={kind.kind}>{kind.label}</option>)}</Select><Select label="Family" value={item.family?.libraryId ?? ""} onChange={(e) => { const family = familyForId(e.target.value); if (family) patch(item.id, { family: familyMetadata(family) }); }}><option value="">Legacy / untyped</option>{familyForMepKind(item.kind).map((family) => <option key={family.id} value={family.id}>{family.name}</option>)}</Select><Select label="System" value={defaultSystem(item)} onChange={(e) => patch(item.id, { system: e.target.value as MepSystemType })}>{["hvac-supply", "hvac-return", "plumbing-supply", "plumbing-drain", "electrical-power", "fire-protection", "controls"].map((system) => <option key={system} value={system}>{system}</option>)}</Select><div className="col-span-2 space-y-1"><p className="text-[11px] text-slate-400">Connections (same system)</p>{mep.elements.filter(candidate => candidate.id !== item.id && defaultSystem(candidate) === defaultSystem(item)).map(candidate => <label key={candidate.id} className="mr-3 inline-flex items-center gap-1 text-xs text-slate-300"><input type="checkbox" checked={Boolean(item.connectedTo?.includes(candidate.id) || candidate.connectedTo?.includes(item.id))} onChange={e => {
          const checked = e.target.checked;
          onChange({ ...mep, elements: mep.elements.map(element => {
            if (element.id !== item.id && element.id !== candidate.id) return element;
            const other = element.id === item.id ? candidate.id : item.id;
            const connected = new Set(element.connectedTo ?? []);
            if (checked) connected.add(other); else connected.delete(other);
            return { ...element, connectedTo: [...connected] };
          }) });
        }} />{candidate.name}</label>)}</div><Input label="Width" type="number" min={0.05} step={0.05} value={item.width} onChange={(e) => patch(item.id, { width: Math.max(Number(e.target.value) || 0.05, 0.05) })} /><Input label="Height / diameter" type="number" min={0.05} step={0.05} value={item.height} onChange={(e) => patch(item.id, { height: Math.max(Number(e.target.value) || 0.05, 0.05), diameter: Math.max(Number(e.target.value) || 0.05, 0.05) })} /><Input label="Rated power (kW)" type="number" min={0} step={0.1} value={item.ratedPowerKw ?? ""} onChange={(e) => patch(item.id, { ratedPowerKw: Math.max(Number(e.target.value) || 0, 0) })} /><Input label="Support spacing (m)" type="number" min={0} step={0.5} value={item.supportSpacingM ?? ""} onChange={(e) => patch(item.id, { supportSpacingM: Math.max(Number(e.target.value) || 0, 0) })} /></div>
      <div className="space-y-2"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Editable route points (m)</p>{item.route.map((point, index) => <div key={`${item.id}-${index}`} className="grid grid-cols-3 gap-2"><Input label={`P${index + 1} X`} type="number" step={0.1} value={point.x} onChange={(e) => patch(item.id, { route: item.route.map((candidate, pointIndex) => pointIndex === index ? { ...candidate, x: Number(e.target.value) || 0 } : candidate) })} /><Input label={`P${index + 1} Y`} type="number" step={0.1} value={point.y} onChange={(e) => patch(item.id, { route: item.route.map((candidate, pointIndex) => pointIndex === index ? { ...candidate, y: Number(e.target.value) || 0 } : candidate) })} /><Input label={`P${index + 1} Z`} type="number" step={0.1} value={point.z} onChange={(e) => patch(item.id, { route: item.route.map((candidate, pointIndex) => pointIndex === index ? { ...candidate, z: Number(e.target.value) || 0 } : candidate) })} /></div>)}</div>
      <Button size="sm" variant="secondary" onClick={() => patch(item.id, { route: item.route.map((point) => ({ ...point, y: point.y + 0.1 })) })}>Raise route 0.1 m</Button>
    </div>)}
      {[...mepClashWarnings(mep).map((warning) => `Clash: ${warning}`), ...summary.warnings, ...summary.connectivityWarnings].map((warning) => <p key={warning} className="text-xs text-amber-300">Preliminary warning: {warning}</p>)}
  </div>;
}
