import type {
  ConstructionPhase,
  ConstructionScheduleBaseline,
  ConstructionScheduleSettings,
} from "../types";
import { quoteCsvCell } from "./csv";

const MAX_PHASES = 1_000;
const MAX_DEPENDENCIES = 10_000;
const MAX_PROJECT_DAYS = 365_000;
const MAX_PHASE_DAYS = 36_500;
const MAX_CREW = 100_000;
const MAX_COST = 1_000_000_000_000_000;
const MAX_MESSAGES = 100;
const DAY_MS = 86_400_000;

export interface ScheduledConstructionPhase {
  phaseId: string;
  name: string;
  color?: string;
  dependsOn: string[];
  durationDays: number;
  earliestStartDay: number;
  crewSize: number;
  costEstimate: number;
  progressPercent: number;
  actualCost: number;
  startDay: number;
  endDay: number;
  latestStartDay: number;
  latestEndDay: number;
  totalFloatDays: number;
  critical: boolean;
  startDate?: string;
  /** Exclusive finish boundary: a one-day phase starting January 1 finishes January 2. */
  finishDate?: string;
  baselineStartDay?: number;
  baselineEndDay?: number;
  baselineCostEstimate?: number;
  startVarianceDays?: number;
  finishVarianceDays?: number;
  /** Current estimate minus the captured baseline estimate. */
  costVariance?: number;
}

export interface ConstructionResourceInterval {
  /** Calendar-day interval [startDay, endDay), measured from the project start. */
  startDay: number;
  endDay: number;
  crew: number;
  phaseIds: string[];
}

export interface ConstructionScheduleTotals {
  plannedCost: number;
  actualCost: number;
  earnedValue: number;
  /** Earned value minus reported actual cost. Positive means under budget. */
  costVariance: number;
  progressPercent: number;
  crewDays: number;
  peakCrew: number;
}

export interface ConstructionScheduleReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Controls 4D display only; both modes calculate the same dependency plan. */
  mode: "manual" | "dependency";
  projectStartDate?: string;
  durationDays: number;
  phases: ScheduledConstructionPhase[];
  totals: ConstructionScheduleTotals;
  resources: ConstructionResourceInterval[];
  baseline?: {
    capturedAt: string;
    projectStartDate?: string;
    durationDays: number;
    plannedCost: number;
    finishVarianceDays: number;
    costVariance: number;
  };
}

export interface ConstructionScheduleProgress {
  day: number;
  plannedValue: number;
  earnedValue: number;
  actualCost: number;
  plannedProgressPercent: number;
  progressPercent: number;
  scheduleVariance: number;
  costVariance: number;
  costPerformanceIndex?: number;
  schedulePerformanceIndex?: number;
}

interface NormalizedPhase {
  phase: ConstructionPhase;
  duration: number;
  crew: number;
  cost: number;
  progress: number;
  actualCost: number;
  earliestStart: number;
  dependencies: string[];
}

function emptyTotals(): ConstructionScheduleTotals {
  return { plannedCost: 0, actualCost: 0, earnedValue: 0, costVariance: 0, progressPercent: 0, crewDays: 0, peakCrew: 0 };
}

function boundedNumber(value: number, min: number, max: number, integer = false): boolean {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

function addMessage(messages: string[], message: string): void {
  if (messages.length < MAX_MESSAGES) messages.push(message);
  else if (messages.length === MAX_MESSAGES) messages.push("Additional validation messages were omitted.");
}

/** Parse the date without local timezone offsets or Date's two-digit-year conversion. */
function parseCalendarDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime();
}

function dateAtDay(startTimestamp: number, day: number): string | undefined {
  const date = new Date(startTimestamp + day * DAY_MS);
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9_999 ? date.toISOString().slice(0, 10) : undefined;
}

function validateBaseline(
  value: ConstructionScheduleBaseline | undefined,
  errors: string[],
): Map<string, ConstructionScheduleBaseline["entries"][number]> | undefined {
  if (value === undefined) return undefined;
  const entries = new Map<string, ConstructionScheduleBaseline["entries"][number]>();
  if (!value || typeof value !== "object" || !Array.isArray(value.entries)) {
    addMessage(errors, "The captured baseline must contain phase entries.");
    return entries;
  }
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) addMessage(errors, "The baseline capture timestamp is invalid.");
  if (value.projectStartDate !== undefined && (typeof value.projectStartDate !== "string" || parseCalendarDate(value.projectStartDate) === undefined)) addMessage(errors, "The baseline project start date is invalid.");
  const baselineStartTimestamp = typeof value.projectStartDate === "string" ? parseCalendarDate(value.projectStartDate) : undefined;
  if (value.entries.length === 0 || value.entries.length > MAX_PHASES) {
    addMessage(errors, `A baseline must contain between 1 and ${MAX_PHASES} phases.`);
    return entries;
  }
  let cost = 0;
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.phaseId !== "string" || !entry.phaseId.trim()) {
      addMessage(errors, "A baseline phase has an empty or invalid ID.");
      continue;
    }
    if (entries.has(entry.phaseId)) addMessage(errors, `The baseline repeats phase ID “${entry.phaseId}”.`);
    if (!boundedNumber(entry.startDay, 0, MAX_PROJECT_DAYS, true) || !boundedNumber(entry.endDay, 1, MAX_PROJECT_DAYS, true) || entry.endDay <= entry.startDay) addMessage(errors, `Baseline phase “${entry.phaseId}” has an invalid day range.`);
    else if (baselineStartTimestamp !== undefined && dateAtDay(baselineStartTimestamp, entry.endDay) === undefined) addMessage(errors, `Baseline phase “${entry.phaseId}” has a calendar finish beyond year 9999.`);
    if (!boundedNumber(entry.costEstimate, 0, MAX_COST)) addMessage(errors, `Baseline phase “${entry.phaseId}” has an invalid estimate.`);
    cost += entry.costEstimate;
    entries.set(entry.phaseId, entry);
  }
  if (!boundedNumber(cost, 0, MAX_COST)) addMessage(errors, "The baseline total cost exceeds the supported numeric range.");
  return entries;
}

/**
 * Calendar-day finish-to-start CPM. Dependencies have zero lag, resources do not
 * constrain dates, and reported progress is a status snapshot rather than a log.
 * All graph passes are iterative; invalid input never yields a partial plan.
 */
export function calculateConstructionSchedule(
  phases: ConstructionPhase[],
  settings?: ConstructionScheduleSettings,
): ConstructionScheduleReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mode = settings?.mode === "dependency" ? "dependency" : "manual";
  const invalid = (): ConstructionScheduleReport => ({ valid: false, errors, warnings, mode, durationDays: 0, phases: [], totals: emptyTotals(), resources: [] });
  if (settings?.mode !== undefined && settings.mode !== "manual" && settings.mode !== "dependency") addMessage(errors, "The schedule mode is invalid.");
  const projectStartDate = settings?.startDate;
  const startTimestamp = typeof projectStartDate === "string" ? parseCalendarDate(projectStartDate) : undefined;
  if (projectStartDate !== undefined && startTimestamp === undefined) addMessage(errors, "Project start date must be a valid YYYY-MM-DD calendar date.");
  const baselineEntries = validateBaseline(settings?.baseline, errors);
  if (!Array.isArray(phases) || phases.length === 0 || phases.length > MAX_PHASES) {
    addMessage(errors, `A schedule must contain between 1 and ${MAX_PHASES} phases.`);
    return invalid();
  }

  const normalized = new Map<string, NormalizedPhase>();
  let linkCount = 0;
  let fallbackDurations = 0;
  let plannedCost = 0;
  let actualCost = 0;
  for (const phase of phases) {
    if (!phase || typeof phase !== "object" || typeof phase.id !== "string" || !phase.id.trim()) {
      addMessage(errors, "A phase has an empty or invalid ID.");
      continue;
    }
    if (normalized.has(phase.id)) addMessage(errors, `Phase ID “${phase.id}” appears more than once.`);
    const label = typeof phase.name === "string" && phase.name.trim() ? phase.name : phase.id;
    if (typeof phase.name !== "string") addMessage(errors, `Phase “${phase.id}” has an invalid name.`);
    if (!Number.isFinite(phase.start) || !Number.isFinite(phase.end)) addMessage(errors, `${label}: manual timeline percentages must be finite numbers.`);
    else if (!boundedNumber(phase.start, 0, 100) || !boundedNumber(phase.end, 0, 100) || phase.start >= phase.end) {
      const message = `${label}: manual timeline must have an increasing range from 0 to 100%.`;
      if (phase.durationDays === undefined) addMessage(errors, message);
      else addMessage(warnings, `${message} The dependency plan uses the explicit duration.`);
    }
    const duration = phase.durationDays ?? Math.max(1, Math.round((phase.end - phase.start) * 2));
    if (phase.durationDays === undefined) fallbackDurations++;
    const crew = phase.crewSize ?? 1;
    const cost = phase.costEstimate ?? 0;
    const progress = phase.progressPercent ?? 0;
    const spent = phase.actualCost ?? 0;
    const earliestStart = phase.earliestStartDay ?? 0;
    if (!boundedNumber(duration, 1, MAX_PHASE_DAYS, true)) addMessage(errors, `${label}: duration must be a whole number from 1 to ${MAX_PHASE_DAYS} calendar days.`);
    if (!boundedNumber(crew, 1, MAX_CREW, true)) addMessage(errors, `${label}: crew must be a whole number from 1 to ${MAX_CREW}.`);
    if (!boundedNumber(cost, 0, MAX_COST)) addMessage(errors, `${label}: estimate must be finite, nonnegative and no greater than ${MAX_COST}.`);
    if (!boundedNumber(spent, 0, MAX_COST)) addMessage(errors, `${label}: actual cost must be finite, nonnegative and no greater than ${MAX_COST}.`);
    if (!boundedNumber(progress, 0, 100)) addMessage(errors, `${label}: reported progress must be from 0 to 100%.`);
    if (!boundedNumber(earliestStart, 0, MAX_PROJECT_DAYS, true)) addMessage(errors, `${label}: earliest start must be a whole nonnegative calendar day.`);
    const dependencies = phase.dependsOn ?? [];
    if (!Array.isArray(dependencies)) {
      addMessage(errors, `${label}: dependencies must be phase IDs.`);
      continue;
    }
    linkCount += dependencies.length;
    if (linkCount > MAX_DEPENDENCIES) {
      addMessage(errors, `Schedules support at most ${MAX_DEPENDENCIES} dependency links.`);
      return invalid();
    }
    const uniqueDependencies = new Set<string>();
    for (const dependency of dependencies) {
      if (typeof dependency !== "string" || !dependency.trim()) addMessage(errors, `${label}: a dependency has an empty or invalid ID.`);
      else if (dependency === phase.id) addMessage(errors, `${label}: a phase cannot depend on itself.`);
      else if (uniqueDependencies.has(dependency)) addMessage(errors, `${label}: dependency “${dependency}” is repeated.`);
      uniqueDependencies.add(dependency);
    }
    plannedCost += cost;
    actualCost += spent;
    normalized.set(phase.id, { phase, duration, crew, cost, progress, actualCost: spent, earliestStart, dependencies: [...uniqueDependencies] });
  }
  if (fallbackDurations > 0) addMessage(warnings, `${fallbackDurations} phase(s) use legacy duration estimates from their manual percentage ranges; enter calendar-day durations for a reliable plan.`);
  if (!boundedNumber(plannedCost, 0, MAX_COST) || !boundedNumber(actualCost, 0, MAX_COST)) addMessage(errors, "Total estimated or actual cost exceeds the supported numeric range.");

  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of normalized.keys()) successors.set(id, []);
  for (const [id, value] of normalized) {
    indegree.set(id, value.dependencies.length);
    for (const dependency of value.dependencies) {
      const targets = successors.get(dependency);
      if (!targets) addMessage(errors, `${value.phase.name}: dependency “${dependency}” refers to a missing phase.`);
      else targets.push(id);
    }
  }
  if (errors.length > 0) return invalid();

  const queue = [...normalized.keys()].filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    order.push(id);
    for (const successor of successors.get(id) ?? []) {
      const remaining = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0) queue.push(successor);
    }
  }
  if (order.length !== normalized.size) {
    const unresolved = [...normalized.keys()].filter((id) => (indegree.get(id) ?? 0) > 0);
    addMessage(errors, `Dependencies contain a cycle; ${unresolved.length} phase(s) cannot be scheduled (${unresolved.slice(0, 8).join(", ")}${unresolved.length > 8 ? ", …" : ""}).`);
    return invalid();
  }

  const early = new Map<string, { start: number; end: number }>();
  let durationDays = 0;
  for (const id of order) {
    const value = normalized.get(id)!;
    let start = value.earliestStart;
    for (const dependency of value.dependencies) start = Math.max(start, early.get(dependency)!.end);
    const end = start + value.duration;
    if (!boundedNumber(end, 1, MAX_PROJECT_DAYS, true)) addMessage(errors, `${value.phase.name}: calculated finish exceeds ${MAX_PROJECT_DAYS} calendar days.`);
    early.set(id, { start, end });
    durationDays = Math.max(durationDays, end);
  }
  if (startTimestamp !== undefined && dateAtDay(startTimestamp, durationDays) === undefined) addMessage(errors, "Calculated calendar dates exceed the supported year range 0001 to 9999.");
  if (errors.length > 0) return invalid();

  const late = new Map<string, { start: number; end: number }>();
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index];
    let end = durationDays;
    for (const successor of successors.get(id) ?? []) end = Math.min(end, late.get(successor)!.start);
    late.set(id, { start: end - normalized.get(id)!.duration, end });
  }

  const baselineTimestamp = settings?.baseline?.projectStartDate ? parseCalendarDate(settings.baseline.projectStartDate) : undefined;
  const baselineShiftDays = startTimestamp !== undefined && baselineTimestamp !== undefined ? (startTimestamp - baselineTimestamp) / DAY_MS : 0;
  const scheduled: ScheduledConstructionPhase[] = order.map((id) => {
    const value = normalized.get(id)!;
    const timing = early.get(id)!;
    const latest = late.get(id)!;
    const baseline = baselineEntries?.get(id);
    return {
      phaseId: id, name: value.phase.name, color: value.phase.color,
      dependsOn: value.dependencies, durationDays: value.duration, earliestStartDay: value.earliestStart, crewSize: value.crew,
      costEstimate: value.cost, progressPercent: value.progress, actualCost: value.actualCost,
      startDay: timing.start, endDay: timing.end, latestStartDay: latest.start, latestEndDay: latest.end,
      totalFloatDays: latest.start - timing.start, critical: latest.start === timing.start,
      startDate: startTimestamp !== undefined ? dateAtDay(startTimestamp, timing.start) : undefined,
      finishDate: startTimestamp !== undefined ? dateAtDay(startTimestamp, timing.end) : undefined,
      ...(baseline ? { baselineStartDay: baseline.startDay, baselineEndDay: baseline.endDay, baselineCostEstimate: baseline.costEstimate, startVarianceDays: timing.start + baselineShiftDays - baseline.startDay, finishVarianceDays: timing.end + baselineShiftDays - baseline.endDay, costVariance: value.cost - baseline.costEstimate } : {}),
    };
  });

  const events = new Map<number, { entering: ScheduledConstructionPhase[]; leaving: ScheduledConstructionPhase[] }>();
  let earnedValue = 0;
  let crewDays = 0;
  let phaseDays = 0;
  let completedPhaseDays = 0;
  for (const phase of scheduled) {
    earnedValue += phase.costEstimate * phase.progressPercent / 100;
    crewDays += phase.crewSize * phase.durationDays;
    phaseDays += phase.durationDays;
    completedPhaseDays += phase.durationDays * phase.progressPercent / 100;
    if (!events.has(phase.startDay)) events.set(phase.startDay, { entering: [], leaving: [] });
    if (!events.has(phase.endDay)) events.set(phase.endDay, { entering: [], leaving: [] });
    events.get(phase.startDay)!.entering.push(phase);
    events.get(phase.endDay)!.leaving.push(phase);
  }
  const resources: ConstructionResourceInterval[] = [];
  const eventDays = [...events.keys()].sort((a, b) => a - b);
  const active = new Set<string>();
  let crew = 0;
  let peakCrew = 0;
  for (let index = 0; index < eventDays.length - 1; index++) {
    const startDay = eventDays[index];
    const event = events.get(startDay)!;
    for (const phase of event.leaving) { active.delete(phase.phaseId); crew -= phase.crewSize; }
    for (const phase of event.entering) { active.add(phase.phaseId); crew += phase.crewSize; }
    peakCrew = Math.max(peakCrew, crew);
    if (crew > 0) resources.push({ startDay, endDay: eventDays[index + 1], crew, phaseIds: [...active] });
  }
  const totals: ConstructionScheduleTotals = {
    plannedCost, actualCost, earnedValue, costVariance: earnedValue - actualCost,
    progressPercent: plannedCost > 0 ? earnedValue / plannedCost * 100 : completedPhaseDays / phaseDays * 100,
    crewDays, peakCrew,
  };
  let baseline: ConstructionScheduleReport["baseline"];
  if (baselineEntries && settings?.baseline) {
    let baselineFinish = 0;
    let baselineCost = 0;
    for (const entry of baselineEntries.values()) {
      baselineFinish = Math.max(baselineFinish, entry.endDay);
      baselineCost += entry.costEstimate;
      if (!normalized.has(entry.phaseId)) addMessage(warnings, `Baseline phase “${entry.phaseId}” is no longer in the current plan.`);
    }
    for (const id of normalized.keys()) if (!baselineEntries.has(id)) addMessage(warnings, `Phase “${id}” was added after the baseline and has no phase variance.`);
    if (settings.baseline.projectStartDate !== projectStartDate) {
      addMessage(warnings, startTimestamp !== undefined && baselineTimestamp !== undefined
        ? "The project start date differs from the baseline. Start and finish variances include the calendar-date shift."
        : "The project start date differs from the baseline and one plan has no calendar date. Variances compare relative day offsets only.");
    }
    baseline = {
      capturedAt: settings.baseline.capturedAt, projectStartDate: settings.baseline.projectStartDate,
      durationDays: baselineFinish, plannedCost: baselineCost,
      finishVarianceDays: durationDays + baselineShiftDays - baselineFinish, costVariance: plannedCost - baselineCost,
    };
  }
  return { valid: true, errors, warnings, mode, projectStartDate, durationDays, phases: scheduled, totals, resources, baseline };
}

export function captureConstructionBaseline(
  report: ConstructionScheduleReport,
  capturedAt: string,
): ConstructionScheduleBaseline | null {
  if (!report.valid || report.phases.length === 0 || !Number.isFinite(Date.parse(capturedAt))) return null;
  return {
    capturedAt,
    projectStartDate: report.projectStartDate,
    entries: report.phases.map((phase) => ({ phaseId: phase.phaseId, startDay: phase.startDay, endDay: phase.endDay, costEstimate: phase.costEstimate })),
  };
}

export function constructionScheduleDayAtTime(report: ConstructionScheduleReport, time: number): number {
  return report.valid && Number.isFinite(time) ? Math.min(100, Math.max(0, time)) / 100 * report.durationDays : 0;
}

export function constructionPhaseStartPercent(report: ConstructionScheduleReport, id: string): number | undefined {
  if (!report.valid || report.durationDays <= 0) return undefined;
  const phase = report.phases.find((item) => item.phaseId === id);
  return phase ? phase.startDay / report.durationDays * 100 : undefined;
}

/** Linear planned-value accrual; actual values are the latest entered status snapshot. */
export function constructionScheduleProgressAtDay(report: ConstructionScheduleReport, day: number): ConstructionScheduleProgress {
  const boundedDay = report.valid && Number.isFinite(day) ? Math.max(0, Math.min(report.durationDays, day)) : 0;
  let plannedValue = 0;
  let plannedPhaseDays = 0;
  let phaseDays = 0;
  if (report.valid) {
    for (const phase of report.phases) {
      const plannedFraction = Math.max(0, Math.min(1, (boundedDay - phase.startDay) / phase.durationDays));
      plannedValue += phase.costEstimate * plannedFraction;
      plannedPhaseDays += phase.durationDays * plannedFraction;
      phaseDays += phase.durationDays;
    }
  }
  const totals = report.valid ? report.totals : emptyTotals();
  return {
    day: boundedDay, plannedValue, earnedValue: totals.earnedValue, actualCost: totals.actualCost,
    plannedProgressPercent: totals.plannedCost > 0 ? plannedValue / totals.plannedCost * 100 : phaseDays > 0 ? plannedPhaseDays / phaseDays * 100 : 0,
    progressPercent: totals.progressPercent, scheduleVariance: totals.earnedValue - plannedValue, costVariance: totals.costVariance,
    costPerformanceIndex: totals.actualCost > 0 ? totals.earnedValue / totals.actualCost : undefined,
    schedulePerformanceIndex: plannedValue > 0 ? totals.earnedValue / plannedValue : undefined,
  };
}

function csvCell(value: string | number | undefined): string {
  return typeof value === "number" ? String(value) : quoteCsvCell(value);
}

export function constructionScheduleCsv(report: ConstructionScheduleReport): string {
  if (!report.valid) return ["Status,Message", ...report.errors.map((error) => ["Invalid", error].map(csvCell).join(","))].join("\r\n");
  const rows: Array<Array<string | number | undefined>> = [[
    "Phase ID", "Phase", "Dependencies", "Start day", "Finish day (exclusive)", "Start date", "Finish date (exclusive)",
    "Duration days", "Earliest start day", "Latest start day", "Latest finish day", "Float days", "Critical", "Crew", "Estimated cost", "Reported progress %", "Actual cost",
    "Baseline start day", "Baseline finish day", "Baseline estimate", "Start variance days", "Finish variance days", "Estimate variance",
  ]];
  for (const phase of report.phases) rows.push([
    phase.phaseId, phase.name, phase.dependsOn.join("; "), phase.startDay, phase.endDay, phase.startDate, phase.finishDate,
    phase.durationDays, phase.earliestStartDay, phase.latestStartDay, phase.latestEndDay, phase.totalFloatDays, phase.critical ? "Yes" : "No", phase.crewSize, phase.costEstimate, phase.progressPercent, phase.actualCost,
    phase.baselineStartDay, phase.baselineEndDay, phase.baselineCostEstimate, phase.startVarianceDays, phase.finishVarianceDays, phase.costVariance,
  ]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function constructionScheduleJson(report: ConstructionScheduleReport): string {
  return JSON.stringify({ schemaVersion: 1, units: { time: "calendar days", cost: "project currency", work: "person calendar-days" }, assumptions: ["Finish-to-start links with zero lag", "Continuous calendar days without holidays", "Fixed durations without resource leveling", "Linear planned-value accrual", "Reported progress and actual cost are a status snapshot"], report }, null, 2);
}
