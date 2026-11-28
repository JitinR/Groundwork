import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// Never select a remote database inherited from a developer environment.
process.env.DATABASE_PROVIDER = "sqlite";
process.env.DATABASE_URL = "";
const testDataDir = mkdtempSync(join(tmpdir(), "secure-nexus-test-"));
process.env.NODE_ENV = "development";
process.env.GROUNDWORK_DATA_DIR = testDataDir;
process.env.MASTER_KEY = randomBytes(32).toString("base64");
process.env.GROUNDWORK_DEV_OTP = "1";
process.env.MAIL_PROVIDER = "console";
process.env.PAYMENTS_MODE = "demo";
process.env.ORGANIZATION_MAX_SEATS = "5";
delete process.env.DB_PATH;
delete process.env.PREVIOUS_MASTER_KEY;
const { app } = await import("../src/index.js");
const { db } = await import("../src/db.js");
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
    async request(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        if (this.cookies.size > 0) {
            headers.set("cookie", [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "));
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
        return { response, body };
    }
}
function jsonInit(method: string, body: unknown, csrfToken?: string): RequestInit {
    return {
        method,
        headers: {
            "content-type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify(body),
    };
}
test("invalid decoded route IDs reach the application's safe 400 error handler", async () => {
    const response = await fetch(`${baseUrl}/api/share/secret%00suffix`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid route parameter", code: "INVALID_ROUTE_PARAMETER" });
});

test("workspace multipart uploads accept exactly a file and kind", async (t) => {
    const client = new CookieClient();
    const email = `workspace-${randomBytes(6).toString("hex")}@example.test`;
    const password = "WorkspaceTest123";
    const signup = await client.json<{
        devOtp: string;
    }>("/api/auth/signup", jsonInit("POST", { email, password, confirmPassword: password }));
    assert.equal(signup.response.status, 201);
    const verified = await client.json<{
        csrfToken: string;
    }>("/api/auth/verify-email", jsonInit("POST", { email, code: signup.body.devOtp }));
    assert.equal(verified.response.status, 200);
    const csrfToken = verified.body.csrfToken;
    const project = await client.json<{
        id: string;
    }>("/api/projects", jsonInit("POST", { name: "Multipart regression", projectType: "house" }, csrfToken));
    assert.equal(project.response.status, 201);
    const url = `/api/projects/${project.body.id}/workspaces/artifacts`;
    const payload = '{"meshes":[]}';
    const upload = (body: FormData) => client.json<{
        artifact: {
            id: string;
            kind: string;
            name: string;
        };
        code?: string;
    }>(url, {
        method: "POST", headers: { "x-csrf-token": csrfToken }, body,
    });
    const validBody = (fileFirst = false) => {
        const body = new FormData();
        if (!fileFirst)
            body.append("kind", "geometry");
        body.append("file", new Blob([payload], { type: "application/json" }), "scene.json");
        if (fileFirst)
            body.append("kind", "geometry");
        return body;
    };
    for (const fileFirst of [false, true]) {
        await t.test(`accepts valid parts with ${fileFirst ? "file" : "kind"} first and returns intact data`, async () => {
            const created = await upload(validBody(fileFirst));
            assert.equal(created.response.status, 201);
            assert.equal(created.body.artifact.kind, "geometry");
            assert.equal(created.body.artifact.name, "scene.json");
            const read = await client.request(`${url}/${created.body.artifact.id}`);
            assert.equal(read.status, 200);
            assert.equal(await read.text(), payload);
        });
    }
    for (const extra of ["file", "field", "duplicate kind", "missing file", "invalid kind"]) {
        await t.test(`rejects ${extra}`, async () => {
            const body = validBody();
            if (extra === "file")
                body.append("file", new Blob([payload]), "extra.json");
            if (extra === "field")
                body.append("unexpected", "value");
            if (extra === "duplicate kind")
                body.append("kind", "geometry");
            if (extra === "missing file")
                body.delete("file");
            if (extra === "invalid kind")
                body.set("kind", "unknown");
            const rejected = await upload(body);
            assert.equal(rejected.response.status, 400);
            assert.equal(rejected.body.code, "INVALID_MULTIPART");
        });
    }
    const inventory = await client.json<{
        artifacts: unknown[];
    }>(url);
    assert.equal(inventory.response.status, 200);
    assert.equal(inventory.body.artifacts.length, 2);
});
after(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.close();
    rmSync(testDataDir, { recursive: true, force: true });
});
test("roadmap API integration slice", async (t) => {
    const client = new CookieClient();
    await t.test("reports health", async () => {
        const { response, body } = await client.json<{
            ok: boolean;
            uptime: number;
        }>("/api/health");
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(body.ok, true);
        assert.equal(typeof body.uptime, "number");
    });
    await t.test("unhealthy database checks return uncached HTTP 503 without internal details", async (healthTest) => {
        const prepare = db.prepare.bind(db);
        let checks = 0;
        healthTest.mock.method(db, "prepare", (sql: string) => {
            if (sql !== "SELECT 1 AS ok") return prepare(sql);
            return { get() {
                checks += 1;
                if (checks === 1) return undefined;
                if (checks === 2) return { ok: 0 };
                throw new Error("private fixture database error");
            } };
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const { response, body } = await client.json<{ ok: boolean; uptime: number }>("/api/health");
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.deepEqual(Object.keys(body).sort(), ["ok", "uptime"]);
            assert.equal(body.ok, false);
            assert.equal(typeof body.uptime, "number");
        }
        assert.equal(checks, 3);
    });
    let csrfToken = "";
    await t.test("bootstraps auth CSRF state", async () => {
        const { response, body } = await client.json<{
            csrfToken: string;
        }>("/api/auth/bootstrap");
        assert.equal(response.status, 200);
        assert.match(body.csrfToken, /^[a-f0-9]{48}$/);
        csrfToken = body.csrfToken;
        assert.match(response.headers.get("set-cookie") || "", /csrf=/);
    });
    const email = `test-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
    const password = "TestPassword123";
    let projectId = "";
    await t.test("signs up with a development OTP, verifies email, and logs in", async () => {
        const signup = await client.json<{
            needsEmailVerification: boolean;
            devOtp?: string;
        }>("/api/auth/signup", jsonInit("POST", { email, password, confirmPassword: password }));
        assert.equal(signup.response.status, 201);
        assert.equal(signup.body.needsEmailVerification, true);
        assert.match(signup.body.devOtp || "", /^\d{6}$/);
        const verification = await client.json<{
            user: {
                emailVerified: boolean;
            };
            csrfToken: string;
        }>("/api/auth/verify-email", jsonInit("POST", { email, code: signup.body.devOtp }));
        assert.equal(verification.response.status, 200);
        assert.equal(verification.body.user.emailVerified, true);
        assert.match(verification.body.csrfToken, /^[a-f0-9]{48}$/);
        csrfToken = verification.body.csrfToken;
        const login = await client.json<{
            user: {
                email: string;
            };
            csrfToken: string;
            needsTwoFactor: boolean;
        }>("/api/auth/login", jsonInit("POST", { email, password }));
        assert.equal(login.response.status, 200);
        assert.equal(login.body.user.email, email);
        assert.equal(login.body.needsTwoFactor, false);
        assert.match(login.body.csrfToken, /^[a-f0-9]{48}$/);
        csrfToken = login.body.csrfToken;
    });
    await t.test("rejects a protected mutation without CSRF", async () => {
        const { response, body } = await client.json<{
            error: string;
        }>("/api/projects", jsonInit("POST", { name: "Blocked project" }));
        assert.equal(response.status, 403);
        assert.equal(body.error, "Invalid CSRF token");
    });
    await t.test("creates, encrypts, and reads a project", async () => {
        const created = await client.json<{
            id: string;
            name: string;
            projectType: string;
            revision: number;
        }>("/api/projects", jsonInit("POST", { name: "Encrypted studio", projectType: "villa-community" }, csrfToken));
        assert.equal(created.response.status, 201);
        assert.match(created.body.id, /^[a-f0-9]{32}$/);
        assert.equal(created.body.name, "Encrypted studio");
        assert.equal(created.body.projectType, "villa-community");
        assert.equal(created.body.revision, 0);
        projectId = created.body.id;
        const design = JSON.stringify({ walls: [{ x: 12, y: 8 }], note: "confidential design" });
        const saved = await client.json<{
            ok: boolean;
            revision: number;
        }>(`/api/projects/${projectId}`, jsonInit("PATCH", { designData: design, baseRevision: 0 }, csrfToken));
        assert.equal(saved.response.status, 200);
        assert.equal(saved.body.ok, true);
        assert.equal(saved.body.revision, 1);
        const stored = await db.prepare("SELECT design_data FROM projects WHERE id = ?").get(projectId) as {
            design_data: string;
        };
        assert.notEqual(stored.design_data, design);
        assert.equal(stored.design_data.includes("confidential design"), false);
        const encrypted = JSON.parse(stored.design_data) as {
            iv: unknown;
            tag: unknown;
            data: unknown;
        };
        assert.equal(typeof encrypted.iv, "string");
        assert.equal(typeof encrypted.tag, "string");
        assert.equal(typeof encrypted.data, "string");
        const read = await client.json<{
            id: string;
            design: {
                walls: Array<{
                    x: number;
                    y: number;
                }>;
                note: string;
            };
            revision: number;
        }>(`/api/projects/${projectId}`);
        assert.equal(read.response.status, 200);
        assert.deepEqual(read.body.design, JSON.parse(design));
        assert.equal(read.body.revision, 1);
    });
    await t.test("reports a project revision conflict", async () => {
        const conflict = await client.json<{
            error: string;
            code: string;
            currentRevision: number;
        }>(`/api/projects/${projectId}`, jsonInit("PATCH", { designData: JSON.stringify({ walls: [] }), baseRevision: 0 }, csrfToken));
        assert.equal(conflict.response.status, 409);
        assert.equal(conflict.body.code, "REVISION_CONFLICT");
        assert.equal(conflict.body.currentRevision, 1);
    });
    let snapshotId = "";
    await t.test("creates, lists, and restores an encrypted project snapshot", async () => {
        const snapshot = await client.json<{
            id: string;
            name: string;
            projectType: string;
            widthMm: number;
            depthMm: number;
            createdAt: number;
        }>(`/api/projects/${projectId}/revisions`, jsonInit("POST", { name: "Initial concept" }, csrfToken));
        assert.equal(snapshot.response.status, 201);
        assert.match(snapshot.body.id, /^[a-f0-9]{32}$/);
        assert.equal(snapshot.body.name, "Initial concept");
        assert.equal(snapshot.body.projectType, "villa-community");
        snapshotId = snapshot.body.id;
        const listed = await client.json<{
            revisions: Array<{
                id: string;
                name: string;
                projectType: string;
                widthMm: number;
                depthMm: number;
                createdAt: number;
            }>;
        }>(`/api/projects/${projectId}/revisions`);
        assert.equal(listed.response.status, 200);
        assert.equal(listed.body.revisions.length, 1);
        assert.deepEqual(listed.body.revisions[0], snapshot.body);
        const changed = await client.json<{
            ok: boolean;
            revision: number;
        }>(`/api/projects/${projectId}`, jsonInit("PATCH", { designData: JSON.stringify({ walls: [{ x: 99, y: 99 }], note: "temporary design" }), baseRevision: 1 }, csrfToken));
        assert.equal(changed.response.status, 200);
        assert.equal(changed.body.revision, 2);
        const restored = await client.json<{
            ok: boolean;
            revision: number;
            name: string;
            projectType: string;
            widthMm: number;
            depthMm: number;
            design: {
                walls: Array<{
                    x: number;
                    y: number;
                }>;
                note: string;
            };
        }>(`/api/projects/${projectId}/revisions/${snapshotId}/restore`, jsonInit("POST", { baseRevision: 2 }, csrfToken));
        assert.equal(restored.response.status, 200);
        assert.equal(restored.body.ok, true);
        assert.equal(restored.body.revision, 3);
        assert.equal(restored.body.name, "Initial concept");
        assert.equal(restored.body.projectType, "villa-community");
        assert.deepEqual(restored.body.design, { walls: [{ x: 12, y: 8 }], note: "confidential design" });
        const read = await client.json<{
            design: unknown;
            revision: number;
        }>(`/api/projects/${projectId}`);
        assert.equal(read.response.status, 200);
        assert.equal(read.body.revision, 3);
        assert.deepEqual(read.body.design, { walls: [{ x: 12, y: 8 }], note: "confidential design" });
    });
    let shareLinkId = "";
    await t.test("creates, reads, and revokes a project share link", async () => {
        const created = await client.json<{
            id: string;
            token: string;
            expiresAt: number;
            url: string;
        }>(`/api/projects/${projectId}/share-links`, jsonInit("POST", { expiresInHours: 1 }, csrfToken));
        assert.equal(created.response.status, 201);
        assert.match(created.body.id, /^[a-f0-9]{32}$/);
        assert.match(created.body.token, /^[a-f0-9]{64}$/);
        assert.equal(created.body.url, `/share/${created.body.token}`);
        shareLinkId = created.body.id;
        const shared = await client.json<{
            id: string;
            name: string;
            projectType: string;
            design: {
                walls: Array<{
                    x: number;
                    y: number;
                }>;
                note: string;
            };
            readOnly: boolean;
            expiresAt: number;
            revision: number;
            hasPhoto: boolean;
        }>(`/api/share/${created.body.token}`);
        assert.equal(shared.response.status, 200);
        assert.equal(shared.body.id, projectId);
        assert.equal(shared.body.name, "Encrypted studio");
        assert.equal(shared.body.projectType, "villa-community");
        assert.deepEqual(shared.body.design, { walls: [{ x: 12, y: 8 }], note: "confidential design" });
        assert.equal(shared.body.readOnly, true);
        assert.equal(shared.body.expiresAt, created.body.expiresAt);
        assert.equal(shared.body.revision, 3);
        assert.equal(shared.body.hasPhoto, false);
        const links = await client.json<{
            links: Array<{
                id: string;
                expiresAt: number;
                revokedAt: number | null;
                createdAt: number;
                active: boolean;
            }>;
        }>(`/api/projects/${projectId}/share-links`);
        assert.equal(links.response.status, 200);
        assert.equal(links.body.links.length, 1);
        assert.equal(links.body.links[0]?.id, shareLinkId);
        assert.equal(links.body.links[0]?.active, true);
        assert.equal(links.body.links[0]?.revokedAt, null);
        const revoked = await client.json<{
            ok: boolean;
        }>(`/api/projects/${projectId}/share-links/${shareLinkId}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
        assert.equal(revoked.response.status, 200);
        assert.equal(revoked.body.ok, true);
        const invalid = await client.json<{
            error: string;
        }>(`/api/share/${created.body.token}`);
        assert.equal(invalid.response.status, 404);
        assert.equal(invalid.body.error, "Share link is invalid or expired");
        const revokedLinks = await client.json<{
            links: Array<{
                id: string;
                revokedAt: number | null;
                active: boolean;
            }>;
        }>(`/api/projects/${projectId}/share-links`);
        assert.equal(revokedLinks.response.status, 200);
        assert.equal(revokedLinks.body.links[0]?.id, shareLinkId);
        assert.equal(typeof revokedLinks.body.links[0]?.revokedAt, "number");
        assert.equal(revokedLinks.body.links[0]?.active, false);
    });
    await t.test("creates and lists collaboration items with CSRF protection", async () => {
        const blocked = await client.json<{
            error: string;
        }>(`/api/collaboration/${projectId}/items`, jsonInit("POST", { kind: "comment", body: "Blocked item" }));
        assert.equal(blocked.response.status, 403);
        assert.equal(blocked.body.error, "Invalid CSRF token");
        const created = await client.json<{
            id: string;
            kind: string;
            status: string;
            createdAt: number;
            updatedAt: number;
        }>(`/api/collaboration/${projectId}/items`, jsonInit("POST", { kind: "comment", body: "Review the entryway" }, csrfToken));
        assert.equal(created.response.status, 201);
        assert.match(created.body.id, /^[a-f0-9]{32}$/);
        assert.equal(created.body.kind, "comment");
        assert.equal(created.body.status, "open");
        assert.equal(typeof created.body.createdAt, "number");
        assert.equal(created.body.updatedAt, created.body.createdAt);
        const listed = await client.json<{
            items: Array<{
                id: string;
                kind: string;
                status: string;
                createdAt: number;
                updatedAt: number;
            }>;
        }>(`/api/collaboration/${projectId}/items`);
        assert.equal(listed.response.status, 200);
        assert.equal(listed.body.items.length, 1);
        assert.equal(listed.body.items[0].id, created.body.id);
        assert.equal(listed.body.items[0].kind, "comment");
        assert.equal(listed.body.items[0].status, "open");
        assert.equal(listed.body.items[0].createdAt, created.body.createdAt);
        assert.equal(listed.body.items[0].updatedAt, created.body.updatedAt);
    });
    await t.test("creates and confirms a demo payment without provider calls", async () => {
        const plans = await client.json<{
            isDemo: boolean;
            methods: Array<{
                method: string;
                provider: string;
            }>;
        }>("/api/payments/plans");
        assert.equal(plans.response.status, 200);
        assert.equal(plans.body.isDemo, true);
        assert.equal(plans.body.methods.some((method) => method.method === "card" && method.provider === "demo"), true);
        const created = await client.json<{
            paymentId: string;
            provider: string;
            demo: boolean;
            checkoutUrl: string | null;
            method: string;
            providerOrderId: string;
        }>("/api/payments/create", jsonInit("POST", { planId: "pro", method: "card" }, csrfToken));
        assert.equal(created.response.status, 201);
        assert.match(created.body.paymentId, /^[a-f0-9]{32}$/);
        assert.equal(created.body.provider, "demo");
        assert.equal(created.body.demo, true);
        assert.equal(created.body.checkoutUrl, null);
        assert.equal(created.body.method, "card");
        assert.equal(created.body.providerOrderId, `demo_${created.body.paymentId}`);
        const confirmed = await client.json<{
            ok: boolean;
        }>("/api/payments/confirm-demo", jsonInit("POST", { paymentId: created.body.paymentId }, csrfToken));
        assert.equal(confirmed.response.status, 200);
        assert.equal(confirmed.body.ok, true);
        const payment = await client.json<{
            payment: {
                id: string;
                provider: string;
                plan: string;
                status: string;
            };
        }>(`/api/payments/${created.body.paymentId}`);
        assert.equal(payment.response.status, 200);
        assert.equal(payment.body.payment.id, created.body.paymentId);
        assert.equal(payment.body.payment.provider, "demo");
        assert.equal(payment.body.payment.plan, "pro");
        assert.equal(payment.body.payment.status, "paid");
    });
    await t.test("validates, reads, and removes a project photo", async () => {
        const invalidForm = new FormData();
        invalidForm.set("photo", new Blob([Buffer.from("not an image")], { type: "image/png" }), "not-image.png");
        const invalid = await client.request(`/api/projects/${projectId}/photo`, {
            method: "POST",
            headers: { "x-csrf-token": csrfToken },
            body: invalidForm,
        });
        const invalidBody = (await invalid.json()) as {
            error: string;
        };
        assert.equal(invalid.status, 415);
        assert.equal(invalidBody.error, "Unsupported file type. Use PNG, JPEG, WebP or GIF.");
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        const form = new FormData();
        form.set("photo", new Blob([png], { type: "image/png" }), "site.png");
        const uploaded = await client.json<{
            ok: boolean;
            fileId: string;
        }>(`/api/projects/${projectId}/photo`, {
            method: "POST",
            headers: { "x-csrf-token": csrfToken },
            body: form,
        });
        assert.equal(uploaded.response.status, 200);
        assert.equal(uploaded.body.ok, true);
        assert.match(uploaded.body.fileId, /^[a-f0-9]{32}$/);
        const photo = await client.request(`/api/projects/${projectId}/photo`);
        assert.equal(photo.status, 200);
        assert.equal(photo.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
        const deleted = await client.json<{
            ok: boolean;
        }>(`/api/projects/${projectId}`, {
            method: "DELETE",
            headers: { "x-csrf-token": csrfToken },
        });
        assert.equal(deleted.response.status, 200);
        assert.equal(deleted.body.ok, true);
        const missingPhoto = await client.json<{
            error: string;
        }>(`/api/projects/${projectId}/photo`);
        assert.equal(missingPhoto.response.status, 404);
        assert.ok(missingPhoto.body.error === "No photo" || missingPhoto.body.error === "Project not found");
    });
    await t.test("preserves tenant base seats and rejects unverified commercial grants", async () => {
        // 1. Create organization
        const orgRes = await client.json<{
            id: string;
        }>("/api/organizations", jsonInit("POST", { name: "Nexus Engineering Corp" }, csrfToken));
        assert.equal(orgRes.response.status, 201);
        const orgId = orgRes.body.id;
        // 2. Query default entitlement and billing info
        const initialBilling = await client.json<{
            entitlement: {
                plan: string;
                status: string;
                baseSeats: number;
                paidSeats: number;
                totalSeats: number;
                seatsUsed: number;
                seatsAvailable: number;
                canAddMember: boolean;
                isDelinquent: boolean;
            };
            subscription: {
                plan: string;
                status: string;
                totalSeats: number;
            };
            transitions: Array<{
                idempotencyKey: string;
                action: string;
            }>;
        }>(`/api/organizations/${orgId}/billing`);
        assert.equal(initialBilling.response.status, 200);
        assert.equal(initialBilling.body.entitlement.plan, "standard");
        assert.equal(initialBilling.body.entitlement.status, "active");
        assert.equal(initialBilling.body.entitlement.baseSeats, 5);
        assert.equal(initialBilling.body.entitlement.paidSeats, 0);
        assert.equal(initialBilling.body.entitlement.totalSeats, 5);
        assert.equal(initialBilling.body.entitlement.seatsUsed, 1); // Owner
        assert.equal(initialBilling.body.entitlement.seatsAvailable, 4);
        assert.equal(initialBilling.body.entitlement.canAddMember, true);
        assert.equal(initialBilling.body.entitlement.isDelinquent, false);
        // A count alone cannot grant capacity or silently accept replacement terms.
        const seatRes = await client.json<{
            error: string;
        }>(`/api/organizations/${orgId}/billing/seats`, jsonInit("POST", { idempotencyKey: "test_idem_seats_001", targetPaidSeats: 10 }, csrfToken));
        assert.equal(seatRes.response.status, 400);
        // Demo mode supplies no real tenant product, including repeated requests.
        for (let attempt = 0; attempt < 2; attempt++) {
            const unavailable = await client.json<{
                code: string;
            }>(`/api/organizations/${orgId}/billing/seats`, jsonInit("POST", { idempotencyKey: "test_idem_seats_001", targetPaidSeats: 10, acceptTermReplacement: true }, csrfToken));
            assert.equal(unavailable.response.status, 503);
            assert.equal(unavailable.body.code, "billing_unconfigured");
        }
        const subRes = await client.json<{
            code: string;
        }>(`/api/organizations/${orgId}/billing/subscribe`, jsonInit("POST", { idempotencyKey: "test_idem_sub_001", plan: "enterprise" }, csrfToken));
        assert.equal(subRes.response.status, 409);
        assert.equal(subRes.body.code, "payment_required");
        // Personal demo payments cannot be repurposed to activate tenant seats.
        const orgPayment = await client.json<{
            code: string;
        }>("/api/payments/create", jsonInit("POST", { planId: "studio", method: "card", organizationId: orgId }, csrfToken));
        assert.equal(orgPayment.response.status, 409);
        assert.equal(orgPayment.body.code, "tenant_checkout_required");
        for (const action of ["cancel", "reactivate"]) {
            const closed = await client.json<{
                code: string;
            }>(`/api/organizations/${orgId}/billing/${action}`, jsonInit("POST", { idempotencyKey: `unverified_${action}` }, csrfToken));
            assert.equal(closed.response.status, 409);
            assert.equal(closed.body.code, "verified_term_required");
        }
        // All rejected requests leave capacity and receipt/transition history intact.
        const updatedBilling = await client.json<{
            entitlement: {
                paidSeats: number;
                effectivePaidSeats: number;
                totalSeats: number;
                hasVerifiedPayment: boolean;
            };
            orders: unknown[];
            transitions: unknown[];
        }>(`/api/organizations/${orgId}/billing`);
        assert.equal(updatedBilling.response.status, 200);
        assert.equal(updatedBilling.body.entitlement.paidSeats, 0);
        assert.equal(updatedBilling.body.entitlement.effectivePaidSeats, 0);
        assert.equal(updatedBilling.body.entitlement.totalSeats, 5);
        assert.equal(updatedBilling.body.entitlement.hasVerifiedPayment, false);
        assert.equal(updatedBilling.body.orders.length, 0);
        assert.equal(updatedBilling.body.transitions.length, 0);
    });
    await t.test("organization projects leave the personal free-plan slot available", async () => {
        const { body: { user } } = await client.json<{ user: { id: string } }>("/api/auth/me");
        await db.prepare("UPDATE users SET plan='free',plan_expires_at=NULL WHERE id=?").run(user.id);
        const newProject = () => client.json<{ id: string }>("/api/projects", jsonInit("POST", { name: "Plan quota fixture" }, csrfToken));
        const shared = await newProject();
        assert.equal(shared.response.status, 201);
        const tenant = await client.json<{ id: string }>("/api/organizations", jsonInit("POST", { name: "Design practice" }, csrfToken));
        assert.equal(tenant.response.status, 201);
        const bound = await client.request(`/api/organizations/${tenant.body.id}/projects`, jsonInit("POST", { projectId: shared.body.id }, csrfToken));
        assert.equal(bound.status, 200);
        assert.equal((await newProject()).response.status, 201);
        assert.equal((await newProject()).response.status, 403);
        for (const archived of [true, false]) {
            const patch = await client.json(`/api/projects/${shared.body.id}`, jsonInit("PATCH", { archived }, csrfToken));
            assert.equal(patch.response.status, 200, JSON.stringify(patch.body));
        }
    });
});
