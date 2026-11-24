import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// Never select a remote database inherited from a developer environment.
process.env.DATABASE_PROVIDER = "sqlite";
process.env.DATABASE_URL = "";
const testDataDir = mkdtempSync(join(tmpdir(), "secure-nexus-render-test-"));
process.env.NODE_ENV = "test";
process.env.GROUNDWORK_DATA_DIR = testDataDir;
process.env.MASTER_KEY = randomBytes(32).toString("base64");
process.env.GROUNDWORK_DEV_OTP = "1";
process.env.MAIL_PROVIDER = "console";
process.env.PAYMENTS_MODE = "demo";
process.env.RENDER_PROVIDER = "demo";
delete process.env.DB_PATH;
delete process.env.PREVIOUS_MASTER_KEY;
const { app } = await import("../src/index.js");
const { db } = await import("../src/db.js");
const { DemoRenderProvider, UnconfiguredRenderProvider, setRenderProviderForTesting, generatePurePng, } = await import("../src/renderProvider.js");
const { deleteWorkspaceArtifact, readWorkspaceArtifact, } = await import("../src/workspaces.js");
type WorkspaceActor = import("../src/workspaces.js").WorkspaceActor;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
});
const address = server.address();
if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
}
const baseUrl = `http://127.0.0.1:${address.port}`;
class CookieClient {
    private readonly cookies = new Map<string, string>();
    public csrfToken = "";
    async request(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        if (this.cookies.size > 0) {
            headers.set("cookie", [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "));
        }
        if (this.csrfToken && !headers.has("x-csrf-token") && !["GET", "HEAD", "OPTIONS"].includes(init.method || "GET")) {
            headers.set("x-csrf-token", this.csrfToken);
        }
        const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
        const getSetCookie = (response.headers as Headers & {
            getSetCookie?: () => string[];
        }).getSetCookie;
        const setCookies = getSetCookie
            ? getSetCookie.call(response.headers)
            : response.headers.get("set-cookie")?.split(/, (?=[^;]+=)/g) || [];
        for (const setCookie of setCookies) {
            const pair = setCookie.split(";", 1)[0];
            const separator = pair.indexOf("=");
            if (separator < 1)
                continue;
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (value)
                this.cookies.set(name, value);
            else
                this.cookies.delete(name);
        }
        return response;
    }
    async json<T>(path: string, init: RequestInit = {}): Promise<{
        response: Response;
        body: T;
    }> {
        const response = await this.request(path, init);
        const body = (await response.json()) as T;
        if (body && typeof body === "object" && "csrfToken" in body && typeof (body as Record<string, unknown>).csrfToken === "string") {
            this.csrfToken = (body as Record<string, unknown>).csrfToken as string;
        }
        return { response, body };
    }
}
after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    setRenderProviderForTesting(null);
    await db.close();
    rmSync(testDataDir, { recursive: true, force: true });
});
async function loginUser(client: CookieClient, email: string): Promise<string> {
    const boot = await client.json<{
        csrfToken: string;
    }>("/api/auth/bootstrap");
    client.csrfToken = boot.body.csrfToken;
    const password = "RenderTestPassword123!";
    const signup = await client.json<{
        devOtp?: string;
    }>("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, confirmPassword: password }),
    });
    const otp = signup.body.devOtp || "123456";
    await client.json("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp }),
    });
    const login = await client.json<{
        user: {
            id: string;
        };
    }>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    return login.body.user.id;
}
test("Phase 9 AI photorealistic rendering suite", async (t) => {
    const client = new CookieClient();
    const userId = await loginUser(client, `architect-${Date.now()}@example.com`);
    // Create a test project
    const createProjRes = await client.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Sunset Residence", projectType: "house" }),
    });
    assert.equal(createProjRes.status, 201);
    const { id: projectId } = (await createProjRes.json()) as {
        id: string;
    };
    // Sample base64 image (valid pure PNG 32x32)
    const samplePngBuffer = generatePurePng(32, 32, () => [220, 230, 240, 255]);
    const sampleBase64 = `data:image/png;base64,${samplePngBuffer.toString("base64")}`;
    let unconfiguredAttempt: { id: string; sourceImageArtifactId: string };
    await t.test("capabilities endpoint reflects current render provider and style presets", async () => {
        const res = await client.request(`/api/projects/${projectId}/renders/capabilities`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as {
            configured: boolean;
            provider: string;
            model: string;
            presets: Array<{
                id: string;
                name: string;
            }>;
        };
        assert.equal(data.configured, true);
        assert.equal(data.provider, "demo-architectural");
        assert.ok(data.presets.length >= 5);
        assert.ok(data.presets.some((p) => p.id === "dusk-architectural"));
    });
    await t.test("configuration gating handles unconfigured provider gracefully", async () => {
        // Override provider to unconfigured
        setRenderProviderForTesting(new UnconfiguredRenderProvider());
        const submitRes = await client.request(`/api/projects/${projectId}/renders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: "Photorealistic glass villa overlooking the valley",
                stylePreset: "golden-hour",
                sourceRevision: 0,
                sourceImageBase64: sampleBase64,
            }),
        });
        assert.equal(submitRes.status, 201);
        const { job } = (await submitRes.json()) as {
            job: {
                id: string;
                status: string;
                errorCode: string;
                errorMessage: string;
                sourceImageArtifactId: string;
            };
        };
        assert.equal(job.status, "unconfigured");
        assert.equal(job.errorCode, "PROVIDER_UNCONFIGURED");
        assert.ok(job.errorMessage.includes("AI photorealistic rendering requires"));
        assert.ok(job.sourceImageArtifactId);
        unconfiguredAttempt = job;
        for (let i = 0; i < 3; i += 1) {
            const additional = await client.request(`/api/projects/${projectId}/renders`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "Material study", sourceRevision: 0, sourceImageArtifactId: job.sourceImageArtifactId }),
            });
            assert.equal(additional.status, 201);
        }
        const blocked = await client.json<{ code: string }>(`/api/projects/${projectId}/renders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "Daylight study", sourceRevision: 0, sourceImageBase64: sampleBase64 }),
        });
        assert.equal(blocked.response.status, 503);
        assert.equal(blocked.body.code, "PROVIDER_UNCONFIGURED");
        const storage = await db.prepare("SELECT COUNT(*) AS count FROM project_workspace_artifacts WHERE project_id=?").get(projectId) as { count: number };
        assert.equal(storage.count, 1, "unavailable submissions must leave existing project files unchanged");
        setRenderProviderForTesting(new DemoRenderProvider());
    });
    let succeededJobId = "";
    let sourceArtifactId = "";
    let outputArtifactId = "";
    await t.test("submits durable async render job and generates versioned output artifact", async () => {
        const submitRes = await client.request(`/api/projects/${projectId}/renders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: "Modern architectural villa at dusk with warm interior lighting",
                negativePrompt: "blurry, low quality",
                stylePreset: "dusk-architectural",
                sourceRevision: 0,
                sourceImageBase64: sampleBase64,
            }),
        });
        assert.equal(submitRes.status, 201);
        const { job } = (await submitRes.json()) as {
            job: {
                id: string;
                status: string;
                sourceRevision: number;
                sourceImageArtifactId: string;
            };
        };
        succeededJobId = job.id;
        sourceArtifactId = job.sourceImageArtifactId;
        assert.ok(["queued", "running", "succeeded"].includes(job.status));
        // Wait briefly for demo async execution to finish
        let pollCount = 0;
        let finalJob: {
            status: string;
            outputArtifactId: string;
            outputSha256: string;
        } | null = null;
        while (pollCount < 20) {
            const getRes = await client.request(`/api/projects/${projectId}/renders/${job.id}`);
            assert.equal(getRes.status, 200);
            const pollData = (await getRes.json()) as {
                job: typeof finalJob;
            };
            if (pollData.job?.status === "succeeded") {
                finalJob = pollData.job;
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
            pollCount++;
        }
        assert.ok(finalJob, "Job should have completed");
        assert.equal(finalJob.status, "succeeded");
        assert.ok(finalJob.outputArtifactId);
        assert.ok(finalJob.outputSha256);
        outputArtifactId = finalJob.outputArtifactId;
    });
    await t.test("streams output and source images directly with correct MIME and headers", async () => {
        // 1. Output image
        const outputRes = await client.request(`/api/projects/${projectId}/renders/${succeededJobId}/image`);
        assert.equal(outputRes.status, 200);
        assert.equal(outputRes.headers.get("content-type"), "image/png");
        const outputBytes = Buffer.from(await outputRes.arrayBuffer());
        assert.ok(outputBytes.length > 100);
        // Verify PNG magic bytes
        assert.equal(outputBytes[0], 0x89);
        assert.equal(outputBytes[1], 0x50); // 'P'
        assert.equal(outputBytes[2], 0x4e); // 'N'
        assert.equal(outputBytes[3], 0x47); // 'G'
        // 2. Source image
        const sourceRes = await client.request(`/api/projects/${projectId}/renders/${succeededJobId}/image?type=source`);
        assert.equal(sourceRes.status, 200);
        assert.equal(sourceRes.headers.get("content-type"), "image/png");
        const sourceBytes = Buffer.from(await sourceRes.arrayBuffer());
        assert.ok(sourceBytes.length > 50);
    });
    await t.test("detects stale renders when project revision advances", async () => {
        // Currently project revision is 0, job is at revision 0
        const listRes1 = await client.request(`/api/projects/${projectId}/renders`);
        assert.equal(listRes1.status, 200);
        const data1 = (await listRes1.json()) as {
            jobs: Array<{
                id: string;
                isRevisionCurrent: boolean;
                revisionMismatch: boolean;
                sourceRevision: number;
                currentProjectRevision: number;
            }>;
        };
        const targetJob1 = data1.jobs.find((j) => j.id === succeededJobId);
        assert.ok(targetJob1);
        assert.equal(targetJob1.isRevisionCurrent, true);
        assert.equal(targetJob1.revisionMismatch, false);
        // Bump project revision in database
        await db.prepare("UPDATE projects SET revision=3 WHERE id=?").run(projectId);
        // Re-check jobs
        const listRes2 = await client.request(`/api/projects/${projectId}/renders`);
        assert.equal(listRes2.status, 200);
        const data2 = (await listRes2.json()) as {
            jobs: Array<{
                id: string;
                isRevisionCurrent: boolean;
                revisionMismatch: boolean;
                sourceRevision: number;
                currentProjectRevision: number;
            }>;
        };
        const targetJob2 = data2.jobs.find((j) => j.id === succeededJobId);
        assert.ok(targetJob2);
        assert.equal(targetJob2.isRevisionCurrent, false);
        assert.equal(targetJob2.revisionMismatch, true);
        assert.equal(targetJob2.sourceRevision, 0);
        assert.equal(targetJob2.currentProjectRevision, 3);
    });
    await t.test("retries render job immutably without corrupting previous job or outputs", async () => {
        const retryRes = await client.request(`/api/projects/${projectId}/renders/${succeededJobId}/retry`, {
            method: "POST",
        });
        assert.equal(retryRes.status, 201);
        const { job: retriedJob } = (await retryRes.json()) as {
            job: {
                id: string;
                status: string;
                parameters: {
                    retriedFromJobId: string;
                };
            };
        };
        // Brand-new job ID
        assert.notEqual(retriedJob.id, succeededJobId);
        assert.equal(retriedJob.parameters.retriedFromJobId, succeededJobId);
        // Original job remains intact and succeeded
        const origRes = await client.request(`/api/projects/${projectId}/renders/${succeededJobId}`);
        assert.equal(origRes.status, 200);
        const { job: origJob } = (await origRes.json()) as {
            job: {
                status: string;
                outputArtifactId: string;
            };
        };
        assert.equal(origJob.status, "succeeded");
        assert.equal(origJob.outputArtifactId, outputArtifactId);
    });
    await t.test("protects source and output artifacts from premature deletion", async () => {
        const sessionRow = await db.prepare("SELECT id FROM sessions WHERE user_id=? AND status='active'").get(userId) as {
            id: string;
        };
        const actor: WorkspaceActor = { userId, sessionId: sessionRow.id };
        // Try deleting output artifact while referenced by render job
        await assert.rejects(async () => {
            await deleteWorkspaceArtifact(projectId, outputArtifactId, actor);
        }, (err: Error) => {
            return err.message.includes("referenced by saved workspace history, a native job, or a render job");
        });
        // Try deleting source artifact
        await assert.rejects(async () => {
            await deleteWorkspaceArtifact(projectId, sourceArtifactId, actor);
        }, (err: Error) => {
            return err.message.includes("referenced by saved workspace history, a native job, or a render job");
        });
        // Verify artifact is still safely readable
        const read = await readWorkspaceArtifact(projectId, outputArtifactId, actor);
        assert.ok(read.bytes.length > 0);
    });
    await t.test("project owner can remove an unsuccessful attempt while preserving project images and successful history", async () => {
        const retained = await client.request(`/api/projects/${projectId}/renders/${succeededJobId}`, { method: "DELETE" });
        assert.equal(retained.status, 409);
        const remove = await client.request(`/api/projects/${projectId}/renders/${unconfiguredAttempt.id}`, { method: "DELETE" });
        assert.equal(remove.status, 204);
        const removed = await client.request(`/api/projects/${projectId}/renders/${unconfiguredAttempt.id}`);
        assert.equal(removed.status, 404);
        const sessionRow = await db.prepare("SELECT id FROM sessions WHERE user_id=? AND status='active'").get(userId) as { id: string };
        const actor = { userId, sessionId: sessionRow.id };
        assert.deepEqual((await readWorkspaceArtifact(projectId, unconfiguredAttempt.sourceImageArtifactId, actor)).bytes, samplePngBuffer);
        assert.ok((await readWorkspaceArtifact(projectId, outputArtifactId, actor)).bytes.length > 0);
    });
});
