import { useEffect, useState, useCallback, useRef, useId } from "react";
import { Button, Card, Input, Modal } from "./ui";
import {
  cancelRenderJob,
  fetchRenderCapabilities,
  getRenderImageUrl,
  listRenderJobs,
  removeRenderHistoryEntry,
  retryRenderJob,
  submitRenderJob,
  type RenderCapabilities,
  type RenderJobSummary,
  type RenderPreset,
  type RenderSourceImage,
  type RenderSourceKind,
} from "../lib/renderApi";
import { downloadBlob } from "../lib/download";

interface RenderStudioModalProps {
  projectId: string;
  initialSourceImage?: RenderSourceImage | null;
  isOpen: boolean;
  onClose: () => void;
}

function sourceLabel(kind: RenderSourceKind, revision: number): string {
  switch (kind) {
    case "saved-viewport": return `Saved viewport · Rev ${revision}`;
    case "draft-viewport": return `Unsaved viewport · Based on Rev ${revision}`;
    case "reference": return "Reference image";
    default: return "Unverified source";
  }
}

export function RenderStudioModal({
  projectId,
  initialSourceImage,
  isOpen,
  onClose,
}: RenderStudioModalProps) {
  const [capabilities, setCapabilities] = useState<RenderCapabilities | null>(null);
  const [jobs, setJobs] = useState<RenderJobSummary[]>([]);
  const [canRemove, setCanRemove] = useState(false);
  const [currentProjectRevision, setCurrentProjectRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("photorealistic-daylight");
  const [sourceImage, setSourceImage] = useState<RenderSourceImage | null>(initialSourceImage ?? null);
  const [selectedPreviewJob, setSelectedPreviewJob] = useState<RenderJobSummary | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const aliveRef = useRef(false);
  const scopeRef = useRef({ projectId, isOpen });
  scopeRef.current = { projectId, isOpen };
  const scopeGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const promptId = useId();
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const busyJobRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; scopeGeneration.current += 1; requestGeneration.current += 1; fileReaderRef.current?.abort(); };
  }, []);

  useEffect(() => {
    scopeGeneration.current += 1;
    requestGeneration.current += 1;
    setCapabilities(null); setJobs([]); setSelectedPreviewJob(null); setError(null);
    setCanRemove(false);
    setCurrentProjectRevision(null); setLoading(false); setSubmitting(false);
    setBusyJob(null); busyJobRef.current = null;
    setSourceImage(initialSourceImage ?? null);
    fileReaderRef.current?.abort(); fileReaderRef.current = null;
    return () => { scopeGeneration.current += 1; requestGeneration.current += 1; };
  }, [projectId, isOpen]);

  const loadData = useCallback(async () => {
    if (!projectId || !scopeRef.current.isOpen) return;
    const scope = scopeGeneration.current;
    const request = ++requestGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current && request === requestGeneration.current;
    try {
      setLoading(true);
      const [caps, jobData] = await Promise.all([
        fetchRenderCapabilities(projectId),
        listRenderJobs(projectId),
      ]);
      if (!isCurrent()) return;
      setCapabilities(caps);
      setJobs(jobData.jobs);
      setCanRemove(jobData.project.role === "owner");
      setCurrentProjectRevision(jobData.project.revision);
      setError(null);
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Failed to load render studio data");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isOpen) {
      void loadData();
    } else {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
  }, [isOpen, loadData]);

  // Polling while any job is active
  useEffect(() => {
    const hasActiveJob = jobs.some((j) => j.status === "queued" || j.status === "running");
    if (isOpen && hasActiveJob) {
      const scope = scopeGeneration.current;
      const request = requestGeneration.current;
      const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current && request === requestGeneration.current;
      pollTimerRef.current = window.setTimeout(() => {
        void listRenderJobs(projectId).then((data) => {
          if (!isCurrent()) return;
          setJobs(data.jobs);
          setCanRemove(data.project.role === "owner");
          setCurrentProjectRevision(data.project.revision);
        }).catch((cause: unknown) => {
          if (isCurrent()) setError(cause instanceof Error ? cause.message : "Couldn't refresh rendering progress. Use Refresh to try again.");
        });
      }, 2500);
    }
    return () => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isOpen, jobs, projectId]);

  if (!isOpen) return null;

  const handleFileUpload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) {
      setError("Source image exceeds 32 MiB");
      return;
    }
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setError("Choose a PNG or JPEG source image.");
      return;
    }
    fileReaderRef.current?.abort();
    const scope = scopeGeneration.current;
    const reader = new FileReader();
    fileReaderRef.current = reader;
    reader.onload = () => {
      if (aliveRef.current && scope === scopeGeneration.current && scopeRef.current.isOpen && fileReaderRef.current === reader && typeof reader.result === "string") {
        setSourceImage({ base64: reader.result, kind: "reference" });
      }
    };
    reader.onerror = () => { if (aliveRef.current && scope === scopeGeneration.current && scopeRef.current.isOpen) setError("Couldn't read this image. Choose another file."); };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || loading) return;
    if (!prompt.trim()) {
      setError("Please describe the desired photorealistic architectural render.");
      return;
    }
    if (!sourceImage) {
      setError("Please provide a source design image from the viewport or file upload.");
      return;
    }
    if (currentProjectRevision === null) return;

    const scope = scopeGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current;
    try {
      setSubmitting(true);
      setError(null);
      const res = await submitRenderJob(projectId, {
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || undefined,
        stylePreset: selectedPreset,
        sourceRevision: sourceImage.revision ?? currentProjectRevision,
        sourceKind: sourceImage.kind,
        sourceImageBase64: sourceImage.base64,
      });
      if (!isCurrent()) return;
      requestGeneration.current += 1;
      setLoading(false);
      setPrompt("");
      setJobs((prev) => [res.job, ...prev]);
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      if (isCurrent()) setSubmitting(false);
    }
  };

  const handleRetry = async (jobId: string) => {
    if (busyJobRef.current) return;
    const scope = scopeGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current;
    busyJobRef.current = jobId; setBusyJob(jobId);
    try {
      setError(null);
      const res = await retryRenderJob(projectId, jobId);
      if (!isCurrent()) return;
      requestGeneration.current += 1;
      setLoading(false);
      setJobs((prev) => [res.job, ...prev]);
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      if (isCurrent()) { busyJobRef.current = null; setBusyJob(null); }
    }
  };

  const handleCancel = async (jobId: string) => {
    if (busyJobRef.current) return;
    const scope = scopeGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current;
    busyJobRef.current = jobId; setBusyJob(jobId);
    try {
      setError(null);
      const res = await cancelRenderJob(projectId, jobId);
      if (!isCurrent()) return;
      requestGeneration.current += 1;
      setLoading(false);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? res.job : j)));
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Cancellation failed");
    } finally {
      if (isCurrent()) { busyJobRef.current = null; setBusyJob(null); }
    }
  };

  const handleRemove = async (jobId: string) => {
    if (busyJobRef.current || !window.confirm("Remove this render from history and permanently delete its render images that aren't used elsewhere?")) return;
    const scope = scopeGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current;
    busyJobRef.current = jobId;
    setBusyJob(`remove-${jobId}`);
    try {
      setError(null);
      await removeRenderHistoryEntry(projectId, jobId, true);
      if (isCurrent()) {
        requestGeneration.current += 1;
        setLoading(false);
        setJobs((prev) => prev.filter((job) => job.id !== jobId));
      }
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Couldn't remove the render");
    } finally {
      if (isCurrent()) {
        busyJobRef.current = null;
        setBusyJob(null);
      }
    }
  };

  const handleDownload = async (job: RenderJobSummary) => {
    const scope = scopeGeneration.current;
    const isCurrent = () => aliveRef.current && scopeRef.current.projectId === projectId && scopeRef.current.isOpen && scope === scopeGeneration.current;
    try {
      const url = getRenderImageUrl(projectId, job.id, "output");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("Could not download rendered image");
      const blob = await resp.blob();
      if (!isCurrent()) return;
      const baseName = job.sourceKind === "saved-viewport" ? `render-rev${job.sourceRevision}` : "render";
      downloadBlob(`${baseName}-${job.id.slice(0, 8)}.png`, blob);
    } catch (err: unknown) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "Download failed");
    }
  };

  return (
    <>
      <Modal open={isOpen && !selectedPreviewJob} onClose={onClose} title="AI rendering studio" wide>
        <div className="space-y-6">
          <p className="text-xs leading-relaxed text-slate-400">Use a viewport capture or upload a reference image to create a photorealistic rendering.</p>
          {error && (
            <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          {/* Provider Gating Notice */}
          {capabilities && (
            <div
              className={`rounded-xl border p-3.5 text-xs flex flex-wrap gap-2 items-center justify-between ${
                capabilities.configured
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              }`}
            >
              <div>
                {capabilities.configured ? (
                  <><span className="font-semibold mr-2">Ready to render</span><span>{capabilities.provider} · {capabilities.model}</span></>
                ) : (
                  <><p className="font-semibold">Rendering is not connected yet.</p><p className="mt-1 leading-relaxed">Your workspace administrator can connect a rendering service to enable this feature.</p>{capabilities.unconfiguredReason && <details className="mt-2"><summary className="cursor-pointer">Connection details</summary><p className="mt-2 leading-relaxed">{capabilities.unconfiguredReason}</p></details>}</>
                )}
              </div>
              {currentProjectRevision !== null && <span className="text-[11px] opacity-75">Project Rev {currentProjectRevision}</span>}
            </div>
          )}

          {/* Submit New Render Form */}
          <Card className="p-4 border-slate-800 bg-slate-950/40">
            <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-200">Create a rendering</h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Source Viewport Thumbnail */}
              <div className="space-y-2">
                <p className="text-xs text-slate-400 font-medium">Source image</p>
                <div className="relative aspect-video rounded-xl border border-slate-800 bg-slate-900/60 flex items-center justify-center overflow-hidden">
                  {sourceImage ? (
                    <img
                      src={sourceImage.base64}
                      alt="Rendering source"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-xs text-slate-500">No source image provided</span>
                  )}
                  {sourceImage && <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-slate-950/80 text-[10px] text-slate-300">
                    {sourceLabel(sourceImage.kind, sourceImage.revision ?? 0)}
                  </span>}
                </div>
                <Input
                  aria-label="Upload source image as PNG or JPEG"
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    handleFileUpload(file);
                  }}
                  className="text-xs"
                />
              </div>

              {/* Style Presets and Prompts */}
              <div className="md:col-span-2 space-y-3">
                <div>
                  <p className="text-xs text-slate-400 font-medium block mb-1.5">Visual style</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="group" aria-label="Rendering visual style">
                    {capabilities?.presets.map((preset: RenderPreset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedPreset(preset.id)}
                        aria-pressed={selectedPreset === preset.id}
                        className={`text-left p-2 rounded-lg border text-xs transition ${
                          selectedPreset === preset.id
                            ? "border-emerald-500 bg-emerald-500/15 text-emerald-200 shadow-sm"
                            : "border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700"
                        }`}
                      >
                        <div className="font-medium text-slate-200">{preset.name}</div>
                        <div className="text-[10px] text-slate-400 line-clamp-1 mt-0.5">
                          {preset.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label htmlFor={promptId} className="text-xs text-slate-400 font-medium block mb-1">
                    Describe your design and lighting
                  </label>
                  <textarea
                    id={promptId}
                    rows={2}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. Modern glass curtain wall residence with timber louvers, landscaped reflecting pool, evening lights..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3 justify-between pt-1">
                  <input
                    aria-label="Details to avoid in the rendering (optional)"
                    type="text"
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    placeholder="Negative prompt (e.g. cartoon, blurry, distorted)"
                    className="gw-field min-w-0 flex-1 px-3 py-1.5 text-xs"
                  />
                  <Button
                    type="submit"
                    loading={submitting}
                    disabled={loading || !capabilities || currentProjectRevision === null || !sourceImage || !prompt.trim()}
                    className="text-xs px-4"
                  >
                    {submitting ? "Creating…" : "Create rendering"}
                  </Button>
                </div>
              </div>
            </div>
            </form>
          </Card>

          {/* Render History & Versioned Gallery */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">
                Your renderings ({jobs.length})
              </h3>
              <Button variant="ghost" size="sm" onClick={() => void loadData()} disabled={loading}>
                Refresh
              </Button>
            </div>

            {jobs.length === 0 ? (
              <div role="status" className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-500">
                {loading ? "Loading your renderings…" : "No renderings for this project yet."}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {jobs.map((job) => {
                  const isStale = job.sourceKind === "saved-viewport" && job.sourceRevision !== currentProjectRevision;
                  const unsuccessful = job.status === "failed" || job.status === "cancelled" || job.status === "unconfigured";
                  const removable = canRemove && job.completedAt !== null && (unsuccessful || job.status === "succeeded");
                  return (
                    <Card
                      key={job.id}
                      className="p-3 border-slate-800 bg-slate-950/60 space-y-3 flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        {/* Status Header */}
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${
                              job.status === "succeeded"
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                : job.status === "running"
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 animate-pulse"
                                : job.status === "queued"
                                ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/20"
                                : job.status === "unconfigured"
                                ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                : "bg-rose-500/15 text-rose-400 border border-rose-500/20"
                            }`}
                          >
                            {job.status}
                          </span>

                          <span className={`text-[10px] px-2 py-0.5 rounded ${isStale ? "bg-amber-500/10 text-amber-300 border border-amber-500/30" : "bg-slate-800 text-slate-300"}`}>
                            {sourceLabel(job.sourceKind, job.sourceRevision)}
                            {isStale && ` (now Rev ${currentProjectRevision})`}
                          </span>
                        </div>

                        {/* Image Preview */}
                        <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-800 bg-slate-900 flex items-center justify-center">
                          {job.status === "succeeded" && job.outputArtifactId ? (
                            <button type="button" className="h-full w-full" aria-label={`Preview rendering: ${job.prompt}`} onClick={() => setSelectedPreviewJob(job)}><img
                              src={getRenderImageUrl(projectId, job.id, "output")}
                              alt={job.prompt}
                              className="w-full h-full object-cover hover:scale-105 transition duration-300"
                            /></button>
                          ) : job.status === "running" ? (
                            <div className="text-center p-4 text-xs text-emerald-300">
                              <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent mb-2" />
                              <p>Synthesizing photorealistic output...</p>
                            </div>
                          ) : (
                            <img
                              src={getRenderImageUrl(projectId, job.id, "source")}
                              alt="Source thumbnail"
                              className="w-full h-full object-cover opacity-40 grayscale"
                            />
                          )}
                        </div>

                        {/* Prompt & Details */}
                        <div>
                          <p className="text-xs font-medium text-slate-200 line-clamp-2">{job.prompt}</p>
                          <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] text-slate-400">
                            <span>Preset: {job.stylePreset || "default"}</span>
                            <span>·</span>
                            <span>Model: {job.model}</span>
                            <span>·</span>
                            <span>{new Date(job.createdAt * 1000).toLocaleTimeString()}</span>
                          </div>
                          {job.errorMessage && (
                            <p className="text-[11px] text-rose-400 mt-1">{job.errorMessage}</p>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-2 text-xs">
                        {job.status === "succeeded" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDownload(job)}
                            className="text-xs h-7"
                          >
                            Export PNG
                          </Button>
                        )}
                        {(job.status === "queued" || job.status === "running") && (
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={Boolean(busyJob)}
                            loading={busyJob === job.id}
                            onClick={() => void handleCancel(job.id)}
                            className="text-xs h-7"
                          >
                            Cancel
                          </Button>
                        )}
                        {unsuccessful && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(busyJob)}
                            loading={busyJob === job.id}
                            onClick={() => void handleRetry(job.id)}
                            className="text-xs h-7"
                          >
                            Retry
                          </Button>
                        )}
                        {removable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(busyJob)}
                            loading={busyJob === `remove-${job.id}`}
                            onClick={() => void handleRemove(job.id)}
                            className="text-xs h-7"
                          >
                            {job.status === "succeeded" ? "Remove rendering" : "Remove attempt"}
                          </Button>
                        )}
                        <span className="ml-auto text-[10px] text-slate-500 font-mono">
                          ID: {job.id.slice(0, 8)}
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Lightbox Preview Modal */}
      {selectedPreviewJob && (
        <Modal open={isOpen} onClose={() => setSelectedPreviewJob(null)} title="Rendering preview" wide>
          <div className="flex flex-col items-center gap-3">
            {error && <p role="alert" className="w-full rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>}
            <img
              src={getRenderImageUrl(projectId, selectedPreviewJob.id, "output")}
              alt={selectedPreviewJob.prompt}
              className="max-h-[50vh] max-w-full rounded-xl border border-slate-700 object-contain"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 w-full text-xs text-slate-300">
              <p className="min-w-0 flex-1 break-words">{selectedPreviewJob.prompt}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDownload(selectedPreviewJob)}
              >
                Download Full PNG
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
