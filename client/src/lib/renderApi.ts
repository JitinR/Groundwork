import { getCsrfToken } from "../api";

export interface RenderPreset {
  id: string;
  name: string;
  description: string;
  promptEnhancement: string;
}

export interface RenderCapabilities {
  configured: boolean;
  provider: string;
  model: string;
  version: string;
  unconfiguredReason: string | null;
  presets: RenderPreset[];
}

export type RenderJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unconfigured";

export interface RenderJobSummary {
  id: string;
  projectId: string;
  sourceRevision: number;
  currentProjectRevision: number;
  isRevisionCurrent: boolean;
  revisionMismatch: boolean;
  sourceImageArtifactId: string;
  sourceImageSha256: string;
  prompt: string;
  negativePrompt: string | null;
  stylePreset: string | null;
  provider: string;
  model: string;
  version: string;
  status: RenderJobState;
  outputArtifactId: string | null;
  outputSha256: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  parameters: Record<string, unknown>;
}

export interface SubmitRenderJobPayload {
  prompt: string;
  negativePrompt?: string;
  stylePreset?: string;
  sourceRevision: number;
  sourceImageBase64?: string;
  sourceImageArtifactId?: string;
  parameters?: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-csrf-token": token } : {}),
  };
}

export async function fetchRenderCapabilities(projectId: string): Promise<RenderCapabilities> {
  const res = await fetch(`/api/projects/${projectId}/renders/capabilities`, {
    headers: { "x-csrf-token": getCsrfToken() || "" },
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to fetch rendering capabilities" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<RenderCapabilities>;
}

export async function listRenderJobs(projectId: string): Promise<{
  project: { id: string; name: string; revision: number; role: "owner" | "editor" | "viewer" };
  jobs: RenderJobSummary[];
  capabilities: RenderCapabilities;
}> {
  const res = await fetch(`/api/projects/${projectId}/renders`, {
    headers: { "x-csrf-token": getCsrfToken() || "" },
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to fetch render jobs" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getRenderJob(projectId: string, jobId: string): Promise<{ job: RenderJobSummary }> {
  const res = await fetch(`/api/projects/${projectId}/renders/${jobId}`, {
    headers: { "x-csrf-token": getCsrfToken() || "" },
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to fetch render job" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function submitRenderJob(
  projectId: string,
  payload: SubmitRenderJobPayload,
): Promise<{ job: RenderJobSummary }> {
  const res = await fetch(`/api/projects/${projectId}/renders`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to submit render job" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function retryRenderJob(projectId: string, jobId: string): Promise<{ job: RenderJobSummary }> {
  const res = await fetch(`/api/projects/${projectId}/renders/${jobId}/retry`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to retry render job" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function cancelRenderJob(projectId: string, jobId: string): Promise<{ job: RenderJobSummary }> {
  const res = await fetch(`/api/projects/${projectId}/renders/${jobId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to cancel render job" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function removeRenderHistoryEntry(projectId: string, jobId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/renders/${jobId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Failed to remove render attempt" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
}

export function getRenderImageUrl(projectId: string, jobId: string, type: "output" | "source" = "output"): string {
  return `/api/projects/${projectId}/renders/${jobId}/image?type=${type}`;
}
