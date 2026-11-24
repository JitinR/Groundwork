import type {
  AuditEvent,
  AuditStats,
  PaymentMethodInfo,
  PaymentRecord,
  Plan,
  Project,
  ProjectDetail,
  SessionInfo,
  User,
  AssistantPlanResponse,
  AssistantAction,
  AssistantPlan,
  ProjectRevision,
  ProjectShareLink,
  Design,
  SharedProject,
  CollaborationItem,
  CollaborationPresence,
  ProjectMember,
  ProjectObjectLock,
} from "./types";
import type { NativeCapability } from "./lib/jobsApi";
import { readResponseJson, retryAfterDelay, withRequestTimeout } from "./lib/requestResilience";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string, public readonly retryAfterMs?: number, public readonly code?: string) {
    super(message);
    this.status = status;
  }
}

const HOSTED_REQUEST_MAX_BYTES = 4_000_000;

/** Leave room beneath the hosting platform limit for multipart boundaries and headers. */
export function assertHostedRequestSize(
  body: BodyInit | null | undefined,
  method: string,
  hostingMode: string | undefined,
): void {
  if (hostingMode !== "vercel" || !["POST", "PUT", "PATCH"].includes(method.toUpperCase()) || body == null) return;
  const encodedBytes = (value: string) => new TextEncoder().encode(value).byteLength;
  let bytes = 0;
  if (body instanceof FormData) {
    bytes = 8 * 1024;
    for (const [name, value] of body.entries()) {
      bytes += encodedBytes(name) + (typeof value === "string" ? encodedBytes(value) : value.size);
    }
  } else if (typeof body === "string") bytes = encodedBytes(body);
  else if (body instanceof Blob) bytes = body.size;
  else if (body instanceof URLSearchParams) bytes = encodedBytes(body.toString());
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) bytes = body.byteLength;
  if (bytes > HOSTED_REQUEST_MAX_BYTES) {
    throw new ApiError(413, "This hosted demo accepts requests up to 4 MB. Use a smaller file or design and try again.");
  }
}

export interface CadProviderStatus {
  providerName: string;
  licenseStatus: "licensed" | "unlicensed" | "unknown";
  endpointConfigured: boolean;
  sdkCapability: boolean;
  supportedFormats: string[];
  available: boolean;
  message: string;
}

export interface CadExchangeStatusResponse {
  providers: CadProviderStatus[];
  nativeCapabilities?: NativeCapability[];
  openFallbacks: string[];
  message: string;
}

export function getCadExchangeStatus(): Promise<CadExchangeStatusResponse> {
  return request<CadExchangeStatusResponse>("/api/cad-exchange/status");
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export interface AssistantPlanRequest {
  message: string;
  context: unknown;
}

export function requestAssistantPlan(input: AssistantPlanRequest): Promise<AssistantPlanResponse> {
  return request<AssistantPlanResponse>("/api/assistant/plan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface AssistantPlanPreview {
  plan: AssistantPlan;
  actionCount: number;
  requiresProfessionalReview: boolean;
}

export function createAssistantPlanPreview(plan: AssistantPlan): AssistantPlanPreview {
  return { plan, actionCount: plan.actions.length, requiresProfessionalReview: true };
}

/* The editor supplies the apply callback after user review; this never calls the persistence API. */
export function applyAssistantPlanPreview(preview: AssistantPlanPreview, apply: (actions: AssistantAction[]) => void): void {
  apply([...preview.plan.actions]);
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { skipCsrf?: boolean } = {},
): Promise<T> {
  assertHostedRequestSize(init.body, init.method || "GET", import.meta.env?.VITE_HOSTING_MODE);
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
  };
  if (!(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const needsCsrf = !opts.skipCsrf && !["GET", "HEAD", "OPTIONS"].includes((init.method || "GET").toUpperCase());
  if (needsCsrf && csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }
  return withRequestTimeout(async signal => {
    const res = await fetch(path, { ...init, headers, credentials: "same-origin", signal });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let code: string | undefined;
      try {
        const body = await readResponseJson<{ error?: string; code?: string }>(res, signal);
        if (body.error) message = body.error;
        if (typeof body.code === "string") code = body.code;
      } catch (error) { if (signal.aborted) throw error; /* no json body */ }
      throw new ApiError(res.status, message, retryAfterDelay(res.headers.get("retry-after")), code);
    }
    return readResponseJson<T>(res, signal);
  }, init.signal);
}

/* ---------------------------------- Auth ---------------------------------- */

export interface MeResponse {
  user: User & { plan?: string; plan_expires_at?: number | null };
  csrfToken: string;
}

export async function bootstrap(): Promise<{ csrfToken: string }> {
  const res = await request<{ csrfToken: string }>("/api/auth/bootstrap", { method: "GET" });
  setCsrfToken(res.csrfToken);
  return res;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    const res = await request<MeResponse>("/api/auth/me", { method: "GET" });
    setCsrfToken(res.csrfToken);
    return res;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export interface SignupExtras {
  username?: string;
  country?: string;
  phone?: string;
  accountType?: "individual" | "business";
  gstin?: string;
}

export interface SignupResult {
  needsEmailVerification?: boolean;
  message?: string;
  emailDelivered?: boolean;
  mailError?: string;
  devOtp?: string;
  user?: User;
  csrfToken?: string;
}

export async function signup(email: string, password: string, confirmPassword: string, extras: SignupExtras = {}) {
  const res = await request<SignupResult>("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, confirmPassword, ...extras }),
  });
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  return res;
}

export interface VerifyEmailResult {
  user?: User;
  csrfToken?: string;
  alreadyVerified?: boolean;
  error?: string;
}

export async function verifyEmail(email: string, code: string): Promise<VerifyEmailResult> {
  const res = await request<VerifyEmailResult>("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  return res;
}

export function resendOtp(email: string) {
  return request<{ ok: boolean; message?: string; delivered?: boolean; mailError?: string; devOtp?: string }>("/api/auth/resend-otp", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function login(email: string, password: string) {
  const res = await request<{ user?: User; csrfToken?: string; needsTwoFactor?: boolean }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
  );
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  return res;
}

export interface OtpLoginRequestResult {
  ok?: boolean;
  message?: string;
  delivered?: boolean;
  mailError?: string;
  devOtp?: string;
}

export function requestOtpLogin(email: string): Promise<OtpLoginRequestResult> {
  return request<OtpLoginRequestResult>("/api/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export interface OtpLoginResult {
  user?: User;
  csrfToken?: string;
  needsTwoFactor?: boolean;
}

export async function loginWithOtp(email: string, code: string): Promise<OtpLoginResult> {
  const res = await request<OtpLoginResult>("/api/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  return res;
}

export function verifyTwoFactor(code: string) {
  return request<{ user: User; csrfToken: string }>("/api/auth/verify-2fa", {
    method: "POST",
    body: JSON.stringify({ code }),
  }).then((r) => {
    setCsrfToken(r.csrfToken);
    return r;
  });
}

export async function logout() {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Sign-out timed out. Check your connection and retry.")), 20_000);
  try {
    return await request<{ ok: boolean }>("/api/auth/logout", { method: "POST", signal: controller.signal });
  } finally { clearTimeout(deadline); }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await request<{ sessions: SessionInfo[] }>("/api/auth/sessions", { method: "GET" });
  return res.sessions;
}

export function revokeSession(id: string) {
  return request<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: "DELETE" });
}

export function revokeOthers() {
  return request<{ ok: boolean; revoked: number }>("/api/auth/revoke-others", { method: "POST", body: "{}" });
}

export function changePassword(currentPassword: string, newPassword: string, confirmPassword: string) {
  return request<{ ok: boolean }>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
  });
}

export interface ProfilePatch {
  username?: string;
  country?: string;
  phone?: string;
  accountType?: "individual" | "business";
  gstin?: string;
}

export async function updateProfile(patch: ProfilePatch): Promise<User> {
  const res = await request<{ user: User }>("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return res.user;
}

export interface CountryOption {
  iso2: string;
  name: string;
  currency: string;
  symbol: string;
}

export async function getCountries(): Promise<CountryOption[]> {
  const res = await request<{ countries: CountryOption[] }>("/api/countries", { method: "GET" });
  return res.countries;
}

export async function twoFactorSetup() {
  return request<{ secret: string; otpauthUrl: string; qrDataUrl: string }>("/api/auth/2fa/setup", {
    method: "POST",
  });
}

export function twoFactorEnable(code: string) {
  return request<{ ok: boolean }>("/api/auth/2fa/enable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function twoFactorDisable(code: string) {
  return request<{ ok: boolean }>("/api/auth/2fa/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/* -------------------------------- Projects -------------------------------- */

export async function listProjects(): Promise<Project[]> {
  const res = await request<{ projects: Project[] }>("/api/projects", { method: "GET" });
  return res.projects;
}

export function createProject(name: string, projectType: string = "house") {
  return request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, projectType }),
  });
}

export function duplicateProject(id: string, name: string): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}/duplicate`, {
    method: "POST", body: JSON.stringify({ name }),
  });
}

export async function getProject(id: string, expectedAccountId: string, signal?: AbortSignal): Promise<ProjectDetail> {
  if (!expectedAccountId) throw new ApiError(401, "Sign in before opening a project.");
  const result = await request<(ProjectDetail & { accountId: string }) | null>(`/api/projects/${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: { "x-groundwork-account": expectedAccountId },
    signal,
  });
  if (result?.accountId !== expectedAccountId) {
    throw new ApiError(409, "The project account could not be verified. Reload Groundwork to refresh your session.", undefined, "ACCOUNT_CHANGED");
  }
  const { accountId: _accountId, ...project } = result;
  return project;
}

export function patchProject(
  id: string,
  patch: { name?: string; projectType?: string; widthMm?: number; depthMm?: number; designData?: string; baseRevision?: number; folder?: string; archived?: boolean; isTemplate?: boolean; expectedAccountId?: string },
) {
  return request<{ ok: boolean; revision: number }>(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface CollaborationEvent {
  id: number;
  projectId: string;
  type: string;
  revision: number;
  createdAt: number;
  actorId?: string;
}

export function subscribeToProject(
  id: string,
  onEvent: (event: CollaborationEvent) => void,
  onStatus: (status: "connected" | "disconnected") => void,
  onPresence?: (presence: CollaborationPresence) => void,
) {
  const source = new EventSource(`/api/collaboration/${encodeURIComponent(id)}/events`);
  let lastEventId = 0;
  const distributedEvents = new Set<string>();
  source.addEventListener("ready", () => onStatus("connected"));
  source.addEventListener("collaboration", (event) => {
    const item = JSON.parse((event as MessageEvent).data) as CollaborationEvent;
    if (item.id <= lastEventId) return;
    lastEventId = item.id;
    onEvent(item);
  });
  source.addEventListener("presence", (event) => onPresence?.(JSON.parse((event as MessageEvent).data) as CollaborationPresence));
  source.addEventListener("distributed", (event) => {
    const item = JSON.parse((event as MessageEvent).data) as Omit<CollaborationEvent, "id"> & { eventId: string };
    if (distributedEvents.has(item.eventId)) return;
    distributedEvents.add(item.eventId);
    if (distributedEvents.size > 2000) distributedEvents.delete(distributedEvents.values().next().value!);
    onEvent({ ...item, id: 0 });
  });
  source.addEventListener("transport-status", () => onStatus("disconnected"));
  source.onerror = () => onStatus("disconnected");
  return () => source.close();
}

export async function listCollaborationItems(id: string): Promise<CollaborationItem[]> {
  return (await request<{ items: CollaborationItem[] }>(`/api/collaboration/${id}/items`, { method: "GET" })).items;
}

export function createCollaborationItem(id: string, kind: "comment" | "issue", body: string) {
  return request<CollaborationItem>(`/api/collaboration/${id}/items`, { method: "POST", body: JSON.stringify({ kind, body }) });
}

export function updateCollaborationItem(id: string, itemId: string, status: "open" | "resolved") {
  return request<{ ok: boolean; status: string; updatedAt: number }>(`/api/collaboration/${id}/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function listProjectMembers(id: string): Promise<{ members: ProjectMember[]; currentRole: ProjectMember["role"] }> {
  return request<{ members: ProjectMember[]; currentRole: ProjectMember["role"] }>(`/api/collaboration/${id}/members`, { method: "GET" });
}

export function addProjectMember(id: string, identifier: string, role: "editor" | "viewer") {
  return request<ProjectMember>(`/api/collaboration/${id}/members`, {
    method: "POST",
    body: JSON.stringify({ identifier, role }),
  });
}

export function updateProjectMember(id: string, userId: string, role: "editor" | "viewer") {
  return request<{ ok: boolean }>(`/api/collaboration/${id}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeProjectMember(id: string, userId: string) {
  return request<{ ok: boolean }>(`/api/collaboration/${id}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export async function listProjectLocks(id: string): Promise<ProjectObjectLock[]> {
  return (await request<{ locks: ProjectObjectLock[] }>(`/api/collaboration/${id}/locks`, { method: "GET" })).locks;
}

export function acquireProjectLock(id: string, objectId: string, ttlSeconds = 90) {
  return request<ProjectObjectLock>(`/api/collaboration/${id}/locks`, {
    method: "POST",
    body: JSON.stringify({ objectId, ttlSeconds }),
  });
}

export function releaseProjectLock(id: string, objectId: string) {
  return request<{ ok: boolean }>(`/api/collaboration/${id}/locks/${encodeURIComponent(objectId)}`, { method: "DELETE" });
}

export function submitProjectOperation(
  id: string,
  operation: { operationId: string; baseRevision: number; kind: "set" | "merge" | "delete"; path: string[]; value?: unknown },
) {
  return request<{ ok: boolean; revision: number; duplicate: boolean }>(`/api/collaboration/${id}/operations`, {
    method: "POST",
    body: JSON.stringify(operation),
  });
}

export async function uploadProjectPhoto(id: string, file: File) {
  const fd = new FormData();
  fd.append("photo", file);
  const res = await request<{ ok: boolean }>(`/api/projects/${id}/photo`, {
    method: "POST",
    body: fd,
  });
  return res;
}

export function deleteProject(id: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" });
}

export function recordExport(id: string, format: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/export`, {
    method: "POST",
    body: JSON.stringify({ format }),
  });
}

/* ---------------------------- History / sharing --------------------------- */

export async function listProjectRevisions(id: string): Promise<ProjectRevision[]> {
  return (await request<{ revisions: ProjectRevision[] }>(`/api/projects/${id}/revisions`, { method: "GET" })).revisions;
}

export function createProjectRevision(id: string, name: string, designData?: string) {
  return request<ProjectRevision>(`/api/projects/${id}/revisions`, { method: "POST", body: JSON.stringify({ name, designData }) });
}

export function restoreProjectRevision(id: string, revisionId: string, baseRevision: number) {
  return request<{ ok: boolean; revision: number; name: string; projectType: string; widthMm: number; depthMm: number; design: Design | null }>(
    `/api/projects/${id}/revisions/${revisionId}/restore`, { method: "POST", body: JSON.stringify({ baseRevision }) },
  );
}

export async function listProjectShareLinks(id: string): Promise<ProjectShareLink[]> {
  return (await request<{ links: ProjectShareLink[] }>(`/api/projects/${id}/share-links`, { method: "GET" })).links;
}

export function createProjectShareLink(id: string, expiresInHours = 24 * 7) {
  return request<{ id: string; token: string; expiresAt: number; url: string }>(`/api/projects/${id}/share-links`, {
    method: "POST", body: JSON.stringify({ expiresInHours }),
  });
}

export function revokeProjectShareLink(id: string, linkId: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/share-links/${linkId}`, { method: "DELETE" });
}

export function getSharedProject(token: string): Promise<SharedProject> {
  return request<SharedProject>(`/api/share/${encodeURIComponent(token)}`, { method: "GET" }, { skipCsrf: true });
}

/* ---------------------------------- Audit --------------------------------- */

export interface AuditQuery {
  limit?: number;
  action?: string;
  beforeId?: number;
  snapshotId?: number;
  from?: number;
  to?: number;
}

export interface AuditPage {
  events: AuditEvent[];
  snapshotId: number;
  nextBeforeId: number | null;
}

export function getAuditPage(query: AuditQuery = {}): Promise<AuditPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return request<AuditPage>(`/api/audit?${params.toString()}`, { method: "GET" });
}

export async function getAuditLog(limit = 100): Promise<AuditEvent[]> {
  const res = await request<{ events: AuditEvent[] }>(`/api/audit?limit=${limit}`, { method: "GET" });
  return res.events;
}

export async function getAuditStats(): Promise<AuditStats> {
  return request<AuditStats>("/api/audit/stats", { method: "GET" });
}

/* -------------------------------- Payments -------------------------------- */

export interface PlansResponse {
  plans: Plan[];
  free: Plan;
  isDemo: boolean;
  methods: PaymentMethodInfo[];
  country: { iso2: string; name: string; currency: string; symbol: string; digits: number };
}

export function getPlans(): Promise<PlansResponse> {
  return request<PlansResponse>("/api/payments/plans", { method: "GET" });
}

export function listPayments(): Promise<PaymentRecord[]> {
  return request<{ payments: PaymentRecord[] }>("/api/payments", { method: "GET" }).then(
    (r) => r.payments,
  );
}

export interface CreatePaymentResult {
  paymentId: string;
  provider: string;
  demo: boolean;
  checkoutUrl: string | null;
  method: string;
  providerOrderId: string;
}

export function createPayment(planId: string, method: string) {
  return request<CreatePaymentResult>("/api/payments/create", {
    method: "POST",
    body: JSON.stringify({ planId, method }),
  });
}

export function confirmDemoPayment(paymentId: string) {
  return request<{ ok: boolean }>("/api/payments/confirm-demo", {
    method: "POST",
    body: JSON.stringify({ paymentId }),
  });
}

export function getPayment(id: string): Promise<{ payment: PaymentRecord }> {
  return request<{ payment: PaymentRecord }>(`/api/payments/${id}`, { method: "GET" });
}
