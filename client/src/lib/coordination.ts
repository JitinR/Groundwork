import type { ReviewComment, ReviewMarker, ReviewViewpoint } from "../types";
import type { ReviewFinding } from "./review";
import { quoteCsvCell } from "./csv";

export const MAX_REVIEW_MARKERS = 2000;
export const MAX_REVIEW_COMMENTS = 100;
export type ReviewWorkflow = "open" | "in-progress" | "resolved";

const bounded = (value: unknown, maximum: number) => typeof value === "string" ? value.slice(0, maximum) : "";
const identifier = () => `issue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
export const reviewWorkflow = (marker: ReviewMarker): ReviewWorkflow => marker.status === "resolved" ? "resolved" : marker.workflowStatus === "in-progress" ? "in-progress" : "open";
export const reviewGroupKey = (targetIds: string[] | undefined, category: string | undefined) => JSON.stringify([category || "manual", [...new Set(targetIds ?? [])].sort()]);

export function validReviewDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function normalizeReviewViewpoint(value: unknown): ReviewViewpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ReviewViewpoint>;
  const vector = (tuple: unknown): tuple is [number, number, number] => Array.isArray(tuple) && tuple.length === 3 && tuple.every(number => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1e7);
  if (!vector(raw.position) || !vector(raw.direction) || !vector(raw.up) || Math.hypot(...raw.direction) < 1e-10 || Math.hypot(...raw.up) < 1e-10) return undefined;
  const directionLength = Math.hypot(...raw.direction), upLength = Math.hypot(...raw.up);
  const direction = raw.direction.map(number => number / directionLength) as [number, number, number];
  const up = raw.up.map(number => number / upLength) as [number, number, number];
  if (Math.abs(direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2]) > 0.9999) return undefined;
  return {
    position: [...raw.position], direction, up,
    cameraType: raw.cameraType === "orthographic" ? "orthographic" : "perspective",
    fieldOfView: typeof raw.fieldOfView === "number" && Number.isFinite(raw.fieldOfView) && raw.fieldOfView > 0 && raw.fieldOfView < 180 ? raw.fieldOfView : undefined,
    viewToWorldScale: typeof raw.viewToWorldScale === "number" && Number.isFinite(raw.viewToWorldScale) && raw.viewToWorldScale > 0 ? raw.viewToWorldScale : undefined,
    componentGuids: Array.isArray(raw.componentGuids) ? [...new Set(raw.componentGuids.filter((guid): guid is string => typeof guid === "string" && /^[0-9A-Za-z_$]{22}$/.test(guid)))].slice(0, 200) : undefined,
  };
}

export function normalizeReviewComment(value: unknown): ReviewComment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ReviewComment>;
  const text = bounded(raw.text, 4000).trim(), createdAt = timestamp(raw.createdAt);
  if (!text || !createdAt) return undefined;
  return { id: bounded(raw.id, 200) || identifier(), text, createdAt, author: bounded(raw.author, 120) || undefined };
}

/** Validates imported metadata and bounds stored fields without trusting ZIP/JSON shapes. */
export function normalizeReviewMarker(value: unknown): ReviewMarker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ReviewMarker>;
  const text = bounded(raw.text, 4000).trim(), id = bounded(raw.id, 200);
  if (!text || !id || typeof raw.x !== "number" || typeof raw.z !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.z) || Math.abs(raw.x) > 1e7 || Math.abs(raw.z) > 1e7) return undefined;
  const targetIds = Array.isArray(raw.targetIds) ? [...new Set(raw.targetIds.filter((target): target is string => typeof target === "string" && target.length > 0 && target.length <= 200))].slice(0, 200) : undefined;
  const status = raw.status === "resolved" || raw.workflowStatus === "resolved" ? "resolved" : "open";
  return {
    id, text, x: raw.x, z: raw.z, targetIds, status,
    severity: raw.severity === "blocker" ? "blocker" : raw.severity === "warning" ? "warning" : "note",
    workflowStatus: status === "resolved" ? "resolved" : raw.workflowStatus === "in-progress" ? "in-progress" : "open",
    category: bounded(raw.category, 100) || undefined, assignee: bounded(raw.assignee, 120) || undefined,
    dueDate: validReviewDate(raw.dueDate) ? raw.dueDate : undefined,
    createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt),
    sourceFindingId: bounded(raw.sourceFindingId, 500) || undefined, groupKey: bounded(raw.groupKey, 2000) || undefined,
    bcfTopicGuid: typeof raw.bcfTopicGuid === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw.bcfTopicGuid) ? raw.bcfTopicGuid.toLowerCase() : undefined,
    comments: Array.isArray(raw.comments) ? raw.comments.map(normalizeReviewComment).filter((comment): comment is ReviewComment => Boolean(comment)).slice(0, MAX_REVIEW_COMMENTS) : [],
    viewpoint: normalizeReviewViewpoint(raw.viewpoint),
  };
}

export function promoteReviewFindings(markers: ReviewMarker[], findings: ReviewFinding[]) {
  const next = [...markers], existingKeys = new Set(markers.filter(marker => marker.sourceFindingId || marker.groupKey).map(marker => marker.groupKey ?? reviewGroupKey(marker.targetIds, marker.category)));
  let added = 0, existing = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const finding of findings) {
    const groupKey = reviewGroupKey(finding.targetIds, finding.category);
    if (existingKeys.has(groupKey)) { existing++; continue; }
    if (next.length >= MAX_REVIEW_MARKERS || !Number.isFinite(finding.x) || !Number.isFinite(finding.z)) { skipped++; continue; }
    next.push({ id: identifier(), text: finding.text.slice(0, 4000), severity: finding.severity, status: "open", workflowStatus: "open", category: finding.category, x: finding.x, z: finding.z, targetIds: [...finding.targetIds], sourceFindingId: finding.id, groupKey, createdAt: now, updatedAt: now, comments: [] });
    existingKeys.add(groupKey); added++;
  }
  return { markers: next, added, existing, skipped };
}

export function mergeImportedReviewMarkers(current: ReviewMarker[], imported: ReviewMarker[]) {
  const next = [...current], ids = new Set(current.map(marker => marker.id)), topics = new Set(current.map(marker => marker.bcfTopicGuid?.toLowerCase()).filter(Boolean));
  let added = 0, existing = 0, skipped = 0;
  for (const raw of imported) {
    const marker = normalizeReviewMarker(raw);
    if (!marker || next.length >= MAX_REVIEW_MARKERS) { skipped++; continue; }
    if (ids.has(marker.id) || (marker.bcfTopicGuid && topics.has(marker.bcfTopicGuid))) { existing++; continue; }
    next.push(marker); ids.add(marker.id); if (marker.bcfTopicGuid) topics.add(marker.bcfTopicGuid); added++;
  }
  return { markers: next, added, existing, skipped };
}

export function reviewRegisterCsv(markers: ReviewMarker[]): string {
  const header = ["ID", "Issue", "Severity", "Workflow", "Category", "Assignee", "Due date", "Target IDs", "X (m)", "Z (m)", "Comments", "Created", "Updated", "BCF topic GUID"];
  return [header, ...markers.map(marker => [marker.id, marker.text, marker.severity, reviewWorkflow(marker), marker.category ?? "manual", marker.assignee ?? "", marker.dueDate ?? "", (marker.targetIds ?? []).join(";"), marker.x, marker.z, marker.comments?.length ?? 0, marker.createdAt ?? "", marker.updatedAt ?? "", marker.bcfTopicGuid ?? ""])].map(row => row.map(quoteCsvCell).join(",")).join("\r\n");
}

export function reviewRegisterJson(markers: ReviewMarker[]): string {
  return JSON.stringify({ version: 1, units: "metres", exportedAt: new Date().toISOString(), markers }, null, 2);
}
