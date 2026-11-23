import type { EngineeringCodeProfile, MepDesign, MepElement, MepPlanningInputs } from "../types";
import { defaultSystem, electricalPlanningLoads } from "./mepNetwork";

export interface MepCalculationReport { kind: "mep-planning"; hvac: { coolingLoadKw: number; airflowM3h: number; airflowLps: number }; capacity: { ductM3h: number; pipeLps: number; ductPressureLossPa: number; pipePressureLossPa: number }; electrical: { connectedLoadKw: number; demandLoadKw: number }; clearances: { minimumM: number; observedMinimumM: number }; supports: { required: number; missing: number }; warnings: string[]; validation: { valid: boolean; errors: string[] }; }
export const mepRouteLength = (element: MepElement) => element.route.reduce((sum, point, index) => index ? sum + Math.hypot(point.x - element.route[index - 1].x, point.y - element.route[index - 1].y, point.z - element.route[index - 1].z) : 0, 0);
export function mepPressureLosses(ductLengthM: number, pipeLengthM: number, planning: MepPlanningInputs) {
  return {
    ductPressureLossPa: ductLengthM * Math.max(planning.designAirVelocityMps, 0) ** 2 * 0.8,
    pipePressureLossPa: pipeLengthM * Math.max(planning.pipeVelocityMps, 0) ** 2 * 2,
  };
}

export function validateMepInputs(value: MepDesign | undefined): string[] { const errors: string[] = []; const planning = value?.planning; if (!planning) return ["planning inputs are required."]; for (const key of ["areaM2", "ceilingHeightM", "occupancy", "airChangesPerHour", "coolingLoadWPerM2"] as const) if (!Number.isFinite(Number(planning[key])) || Number(planning[key]) < 0) errors.push(`${key} must be a finite non-negative number.`); return errors; }
export function calculateMepPlan(value: MepDesign | undefined, profile: EngineeringCodeProfile): MepCalculationReport {
  const planning = value?.planning; const elements = value?.elements ?? []; const errors = validateMepInputs(value); const p = planning ?? { areaM2: 0, ceilingHeightM: 0, occupancy: 0, airChangesPerHour: 0, coolingLoadWPerM2: 0, designAirVelocityMps: profile.assumptions.designAirVelocityMps, pipeVelocityMps: profile.assumptions.pipeVelocityMps, plumbingFlowLps: 0, minimumClearanceM: 0.2, electricalDemandFactor: profile.assumptions.electricalDemandFactor };
  const ducts = elements.filter((item) => item.kind === "duct");
  const pipes = elements.filter((item) => item.kind === "pipe");
  const airflow = p.areaM2 * p.ceilingHeightM * p.airChangesPerHour;
  const ductM3h = ducts.reduce((sum, item) => sum + Math.max(item.width, 0) * Math.max(item.height, 0) * p.designAirVelocityMps * 3600, 0);
  const pipeLps = pipes.reduce((sum, item) => sum + Math.PI * Math.max(item.diameter, 0) ** 2 / 4 * p.pipeVelocityMps * 1000, 0);
  const ductLengthM = ducts.reduce((sum, item) => sum + mepRouteLength(item), 0);
  const pipeLengthM = pipes.reduce((sum, item) => sum + mepRouteLength(item), 0);
  const electricalElements = elements.filter((item) => defaultSystem(item) === "electrical-power");
  const { connectedKw, demandKw } = electricalPlanningLoads(electricalElements, p.electricalDemandFactor);
  const clearances = elements.flatMap((item) => item.route.map((point) => p.ceilingHeightM - point.y - (item.kind === "duct" ? item.height : item.diameter) / 2));
  const observed = clearances.length ? Math.min(...clearances) : p.ceilingHeightM;
  const missing = elements.filter((item) => ["duct", "pipe", "cable-tray"].includes(item.kind) && (!item.supportSpacingM || item.supportSpacingM <= 0)).length; const warnings = ["Preliminary MEP coordination screen only; not code-compliant engineering, fabrication design, certification, or a construction document.", "Confirm equipment schedules, diversity, velocities, pressure loss, voltage drop, fault current, fire/life safety, access, supports, and local code requirements with licensed discipline engineers."]; if (!ducts.length) warnings.push("No duct routes are modeled for HVAC capacity screening."); if (ductM3h < airflow) warnings.push("Modeled duct capacity is below the calculated airflow target."); if (observed < p.minimumClearanceM) warnings.push("A modeled route is below the minimum planning clearance."); if (missing) warnings.push(`${missing} routed element(s) have no support spacing input; restraint and hanger design are not screened.`);
  return { kind: "mep-planning", hvac: { coolingLoadKw: p.areaM2 * p.coolingLoadWPerM2 / 1000, airflowM3h: airflow, airflowLps: airflow / 3.6 }, capacity: { ductM3h, pipeLps, ...mepPressureLosses(ductLengthM, pipeLengthM, p) }, electrical: { connectedLoadKw: connectedKw, demandLoadKw: demandKw }, clearances: { minimumM: p.minimumClearanceM, observedMinimumM: observed }, supports: { required: elements.filter((item) => ["duct", "pipe", "cable-tray"].includes(item.kind)).length, missing }, warnings, validation: { valid: errors.length === 0, errors } };
}
