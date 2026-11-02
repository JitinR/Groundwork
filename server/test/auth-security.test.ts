import { strict as assert } from "node:assert";
import { randomBytes, hkdfSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { Request } from "express";
import dotenv from "dotenv";
import { encryptAesGcm, hashPassword, randomToken, sha256Hex } from "../src/crypto.js";
import { generateTotpSecret, totpCode, matchingTotpStep } from "../src/totp.js";
// No real .env, DB, mail or payment provider is used by this suite or its children.
dotenv.config = () => ({ parsed: {} });
// Never select a remote database inherited from a developer environment.
process.env.DATABASE_PROVIDER = "sqlite";
process.env.DATABASE_URL = "";
const fixtureDir = mkdtempSync(join(tmpdir(), "groundwork-auth-security-"));
const currentKey = randomBytes(32), oldKey = randomBytes(32);
Object.assign(process.env, {
    NODE_ENV: "test", BIND_HOST: "127.0.0.1", GROUNDWORK_DATA_DIR: fixtureDir, DB_PATH: "",
    MASTER_KEY: currentKey.toString("base64"), PREVIOUS_MASTER_KEY: oldKey.toString("base64"),
    PAYMENTS_MODE: "demo", GROUNDWORK_DEV_OTP: "1", MAIL_PROVIDER: "console",
});
for (const name of ["MAIL_HOST", "MAIL_USER", "MAIL_PASS", "RESEND_API_KEY", "AI_API_KEY", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_ACCOUNT_ID", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_ID"])
    process.env[name] = "";
const legacySecret = generateTotpSecret(), rotatedSecret = generateTotpSecret();
const legacyDatabase = new DatabaseSync(join(fixtureDir, "groundwork.db"));
legacyDatabase.exec(`CREATE TABLE users (
  id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,email_verified INTEGER NOT NULL DEFAULT 1,
  username TEXT,otp_code_hash TEXT,otp_expires_at INTEGER,otp_attempts INTEGER NOT NULL DEFAULT 0,
  password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,totp_secret TEXT,totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,locked_until INTEGER,last_login_at INTEGER,
  password_changed_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,status TEXT NOT NULL,user_agent TEXT,ip TEXT,created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);`);
const legacyHash = hashPassword("SyntheticLegacyPassword123!");
const previousMfaKey = Buffer.from(hkdfSync("sha256", oldKey, Buffer.from("groundwork-mfa"), Buffer.from("totp-seed-v1"), 32));
const oldEnvelope = "mfa:v1:" + JSON.stringify(encryptAesGcm(rotatedSecret, previousMfaKey, "groundwork:mfa:v1:rotated-user"));
for (const [id, seed] of [["legacy-user", legacySecret], ["rotated-user", oldEnvelope]]) {
    legacyDatabase.prepare("INSERT INTO users (id,email,password_salt,password_hash,totp_secret,totp_enabled,password_changed_at,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)")
        .run(id, `${id}@example.invalid`, legacyHash.salt, legacyHash.hash, seed, 1, 1, 1);
}
legacyDatabase.prepare("INSERT INTO sessions (id,user_id,token_hash,csrf_token,status,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("legacy-challenge", "legacy-user", sha256Hex(randomToken()), randomToken(), "pending_2fa", 1, 1, Math.floor(Date.now() / 1000) + 300);
legacyDatabase.close();
const [{ default: express }, { default: cookieParser }, { default: authRoutes }, { default: paymentRoutes }, { db, now }, { csrfProtection, apiLimiter, allowDevelopmentOtp }, { openTotpSecret, sealTotpSecret }] = await Promise.all([
    import("express"), import("cookie-parser"), import("../src/routes/auth.js"), import("../src/routes/payments.js"),
    import("../src/db.js"), import("../src/security.js"), import("../src/mfa.js"),
]);
const app = express();
app.use(cookieParser(), express.json());
app.use("/api", apiLimiter, csrfProtection);
app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const address = server.address();
if (!address || typeof address === "string")
    throw new Error("Fixture server failed to bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
class Client {
    sid: string;
    csrf: string;
    constructor(sid: string, csrf: string) { this.sid = sid; this.csrf = csrf; }
    async request(method: string, path: string, body?: unknown, sendCsrf = true, extraHeaders: Record<string, string> = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { "content-type": "application/json", cookie: `sid=${this.sid}; csrf=${this.csrf}`,
                ...(sendCsrf ? { "x-csrf-token": this.csrf } : {}), ...extraHeaders },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        for (const cookie of response.headers.getSetCookie()) {
            const [name, value] = cookie.split(";", 1)[0].split("=");
            if (name === "sid")
                this.sid = value;
            if (name === "csrf")
                this.csrf = value;
        }
        const json = response.headers.get("content-type")?.includes("application/json") ? await response.json() as Record<string, unknown> : {};
        if (typeof json.csrfToken === "string")
            this.csrf = json.csrfToken;
        return { status: response.status, body: json };
    }
}
const password = "SyntheticSecurityPassword123!";
async function user(enabled = true) {
    const id = randomToken(16), secret = generateTotpSecret(), hashed = hashPassword(password);
    await db.prepare(`INSERT INTO users (id,email,email_verified,password_salt,password_hash,totp_secret,totp_enabled,
    password_changed_at,created_at,updated_at,country) VALUES (?,?,1,?,?,?,?,?,?,?,'IN')`)
        .run(id, `${id}@example.invalid`, hashed.salt, hashed.hash, enabled ? sealTotpSecret(secret, id) : null, enabled ? 1 : 0, now(), now(), now());
    return { id, secret, email: `${id}@example.invalid` };
}
async function session(userId: string, pending = false) {
    const id = randomToken(16), sid = randomToken(32), csrf = randomToken(24);
    const account = await db.prepare("SELECT credential_version FROM users WHERE id=?").get(userId) as {
        credential_version: number;
    };
    await db.prepare(`INSERT INTO sessions (id,user_id,token_hash,csrf_token,status,created_at,last_seen_at,expires_at,credential_version)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, userId, sha256Hex(sid), csrf, pending ? "pending_2fa" : "active", now(), now(), now() + (pending ? 300 : 604800), account.credential_version);
    return { id, client: new Client(sid, csrf) };
}
const seedRow = async (id: string) => await db.prepare("SELECT totp_secret FROM users WHERE id=?").get(id) as {
    totp_secret: string | null;
};
test("session listing excludes expired, revoked, stale-epoch, pending and other-account records", async () => {
    const account = await user(), otherAccount = await user();
    const owner = await session(account.id), valid = await session(account.id);
    const expired = await session(account.id), boundary = await session(account.id);
    const revoked = await session(account.id), markedRevoked = await session(account.id);
    const stale = await session(account.id), pending = await session(account.id, true);
    const foreign = await session(otherAccount.id);
    await db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(now() - 1, expired.id);
    await db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(now(), boundary.id);
    await db.prepare("UPDATE sessions SET status='revoked',revoked_at=? WHERE id=?").run(now(), revoked.id);
    await db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), markedRevoked.id);
    await db.prepare("UPDATE sessions SET credential_version=credential_version-1 WHERE id=?").run(stale.id);
    const before = now(), result = await owner.client.request("GET", "/api/auth/sessions");
    assert.equal(result.status, 200);
    assert.ok(Number(result.body.checkedAt) >= before && Number(result.body.checkedAt) <= now());
    const rows = result.body.sessions as { id: string; current: boolean; expires_at: number }[];
    assert.deepEqual(new Set(rows.map(row => row.id)), new Set([owner.id, valid.id]));
    assert.equal(rows.find(row => row.id === owner.id)?.current, true);
    assert.equal(rows.find(row => row.id === valid.id)?.current, false);
    assert.ok(rows.every(row => row.expires_at > Number(result.body.checkedAt)));
    assert.ok(!rows.some(row => row.id === foreign.id));
    assert.equal((await pending.client.request("GET", "/api/auth/sessions")).status, 401);
    assert.equal((await expired.client.request("GET", "/api/auth/sessions")).status, 401);
    assert.equal((await markedRevoked.client.request("GET", "/api/auth/sessions")).status, 401);
    assert.equal((await markedRevoked.client.request("GET", "/api/auth/me")).status, 401);
    assert.equal((await new Client("", "").request("GET", "/api/auth/sessions")).status, 401);
});
test("legacy seeds migrate and previous-key seeds reseal without disabling MFA", async () => {
    const migrated = (await seedRow("legacy-user")).totp_secret!;
    const rotated = (await seedRow("rotated-user")).totp_secret!;
    assert.ok(migrated.startsWith("mfa:v1:") && !migrated.includes(legacySecret));
    assert.ok(openTotpSecret(migrated, "legacy-user").secret === legacySecret);
    assert.ok(openTotpSecret(rotated, "rotated-user").secret === rotatedSecret);
    assert.equal(openTotpSecret(rotated, "rotated-user").needsReseal, false);
    assert.equal((await db.prepare("SELECT status FROM sessions WHERE id='legacy-challenge'").get() as {
        status: string;
    }).status, "revoked");
    assert.throws(() => openTotpSecret(migrated, "different-user"), /unavailable/);
    assert.throws(() => openTotpSecret("mfa:v1:invalid", "legacy-user"), /unavailable/);
});
test("password change invalidates active/pending sessions and outstanding email codes", async () => {
    const account = await user(), owner = await session(account.id), other = await session(account.id), pending = await session(account.id, true);
    await db.prepare("UPDATE users SET otp_code_hash=?,otp_expires_at=? WHERE id=?").run(sha256Hex("synthetic-otp"), now() + 600, account.id);
    assert.equal((await pending.client.request("POST", "/api/auth/revoke-others", {})).status, 401);
    assert.equal((await owner.client.request("POST", "/api/auth/password", { currentPassword: password, newPassword: "ReplacementPassword456!", confirmPassword: "ReplacementPassword456!" })).status, 200);
    assert.equal((await other.client.request("GET", "/api/auth/me")).status, 401);
    assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 401);
    assert.equal((await owner.client.request("GET", "/api/auth/me")).status, 200);
    const row = await db.prepare("SELECT credential_version,otp_code_hash FROM users WHERE id=?").get(account.id) as {
        credential_version: number;
        otp_code_hash: string | null;
    };
    assert.equal(row.credential_version, 1);
    assert.equal(row.otp_code_hash, null);
});
test("revoke-others invalidates pending challenges and email codes, and epochs reject stale records", async () => {
    const account = await user(), owner = await session(account.id), pending = await session(account.id, true);
    const emailCode = "654321";
    await db.prepare("UPDATE users SET otp_code_hash=?,otp_expires_at=? WHERE id=?")
        .run(sha256Hex(`${account.id}:${emailCode}`), now() + 600, account.id);
    assert.equal((await owner.client.request("POST", "/api/auth/revoke-others", {})).status, 200);
    assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 401);
    assert.equal((await new Client("", "").request("POST", "/api/auth/otp/verify", { email: account.email, code: emailCode })).status, 400);
    assert.equal((await owner.client.request("GET", "/api/auth/me")).status, 200);
    const stale = await session(account.id, true);
    await db.prepare("UPDATE sessions SET credential_version=credential_version-1 WHERE id=?").run(stale.id);
    assert.equal((await stale.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 401);
    assert.equal((await db.prepare("SELECT status FROM sessions WHERE id=?").get(stale.id) as {
        status: string;
    }).status, "pending_2fa");
});
test("TOTP account limits survive new password-derived challenges and reset only after cooldown", async () => {
    const account = await user();
    const validCodes = new Set([-1, 0, 1].map((offset) => totpCode(account.secret, Date.now() + offset * 30000)));
    let wrong = "000000";
    while (validCodes.has(wrong))
        wrong = String(Number(wrong) + 1).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
        const pending = await session(account.id, true);
        assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: wrong })).status, i === 4 ? 429 : 401);
    }
    const freshLogin = new Client("", "");
    assert.equal((await freshLogin.request("POST", "/api/auth/login", { email: account.email, password })).status, 200);
    assert.equal((await freshLogin.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 429);
    await db.prepare("UPDATE users SET totp_locked_until=?,totp_attempt_window_start=? WHERE id=?").run(now() - 1, now() - 901, account.id);
    const recovered = await session(account.id, true);
    assert.equal((await recovered.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 200);
});
test("one challenge closes after five failures even when its account window subsequently resets", async () => {
    const account = await user(), pending = await session(account.id, true);
    const validCodes = new Set([-1, 0, 1].map((offset) => totpCode(account.secret, Date.now() + offset * 30000)));
    let wrong = "000000";
    while (validCodes.has(wrong))
        wrong = String(Number(wrong) + 1).padStart(6, "0");
    for (let i = 0; i < 5; i++)
        assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: wrong })).status, i === 4 ? 429 : 401);
    await db.prepare("UPDATE users SET totp_locked_until=NULL,totp_failed_attempts=0,totp_attempt_window_start=NULL WHERE id=?").run(account.id);
    assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(account.secret) })).status, 401);
});
test("TOTP consumption is single-use across simultaneous challenges and rotates the upgraded cookie", async () => {
    const account = await user(), first = await session(account.id, true), second = await session(account.id, true);
    const oldToken = first.client.sid, oldCsrf = first.client.csrf;
    const code = totpCode(account.secret);
    const results = await Promise.all([first.client.request("POST", "/api/auth/verify-2fa", { code }), second.client.request("POST", "/api/auth/verify-2fa", { code })]);
    assert.deepEqual(results.map((value) => value.status).sort(), [200, 401]);
    const winner = results[0].status === 200 ? first : second;
    assert.equal((await winner.client.request("GET", "/api/auth/me")).status, 200);
    if (winner === first) {
        assert.ok(first.client.sid !== oldToken);
        assert.equal((await new Client(oldToken, oldCsrf).request("GET", "/api/auth/me")).status, 401);
    }
});
test("enrollment requires CSRF-protected POST and stores only an encrypted user-bound seed", async () => {
    const account = await user(false), owner = await session(account.id), other = await session(account.id);
    assert.equal((await owner.client.request("GET", "/api/auth/2fa/setup")).status, 404);
    assert.equal((await seedRow(account.id)).totp_secret, null);
    assert.equal((await owner.client.request("POST", "/api/auth/2fa/setup", {}, false)).status, 403);
    assert.equal((await seedRow(account.id)).totp_secret, null);
    const setup = await owner.client.request("POST", "/api/auth/2fa/setup", {});
    assert.equal(setup.status, 200);
    assert.ok(typeof setup.body.secret === "string");
    const secret = setup.body.secret as string, stored = (await seedRow(account.id)).totp_secret!;
    assert.ok(stored.startsWith("mfa:v1:") && !stored.includes(secret));
    assert.ok(openTotpSecret(stored, account.id).secret === secret);
    assert.equal((await owner.client.request("POST", "/api/auth/2fa/enable", { code: totpCode(secret) })).status, 200);
    assert.equal((await other.client.request("GET", "/api/auth/me")).status, 401);
    assert.equal((await owner.client.request("POST", "/api/auth/2fa/setup", {})).status, 400);
    assert.equal((await owner.client.request("POST", "/api/auth/2fa/disable", { code: totpCode(secret) })).status, 401);
    const pending = await session(account.id, true);
    assert.equal((await owner.client.request("POST", "/api/auth/2fa/disable", { code: totpCode(secret, Date.now() + 30000) })).status, 200);
    assert.equal((await seedRow(account.id)).totp_secret, null);
    assert.equal((await owner.client.request("GET", "/api/auth/me")).status, 200);
    assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(secret) })).status, 401);
});
test("tampered or transplanted seeds fail closed without disabling MFA", async () => {
    const source = await user(), target = await user(), pending = await session(target.id, true);
    await db.prepare("UPDATE users SET totp_secret=? WHERE id=?").run((await seedRow(source.id)).totp_secret, target.id);
    assert.equal((await pending.client.request("POST", "/api/auth/verify-2fa", { code: totpCode(source.secret) })).status, 503);
    assert.equal((await db.prepare("SELECT totp_enabled FROM users WHERE id=?").get(target.id) as {
        totp_enabled: number;
    }).totp_enabled, 1);
});
test("developer code disclosure requires loopback peer, effective IP, host and origin", async () => {
    const makeRequest = (peer: string, ip: string, host: string, origin?: string) => ({
        socket: { remoteAddress: peer }, ip, get: (name: string) => name === "host" ? host : name === "origin" ? origin : undefined,
    }) as unknown as Request;
    assert.equal(allowDevelopmentOtp(makeRequest("127.0.0.1", "127.0.0.1", "localhost:4000")), true);
    assert.equal(allowDevelopmentOtp(makeRequest("::1", "::1", "[::1]:4000", "http://[::1]:5173")), true);
    for (const request of [makeRequest("192.0.2.1", "127.0.0.1", "localhost"), makeRequest("127.0.0.1", "192.0.2.1", "localhost"),
        makeRequest("127.0.0.1", "127.0.0.1", "public.example.invalid"), makeRequest("127.0.0.1", "127.0.0.1", "localhost", "https://public.example.invalid")]) {
        assert.equal(allowDevelopmentOtp(request), false);
    }
    const account = await user(false), client = new Client("", "");
    const requested = await client.request("POST", "/api/auth/otp/request", { email: account.email });
    assert.equal(requested.status, 200);
    assert.ok(typeof requested.body.devOtp === "string");
    await db.prepare("UPDATE users SET otp_expires_at=NULL WHERE id=?").run(account.id);
    const externalOrigin = await client.request("POST", "/api/auth/otp/request", { email: account.email }, true, { origin: "https://public.example.invalid" });
    assert.equal(externalOrigin.status, 200);
    assert.ok(externalOrigin.body.devOtp === undefined);
});
test("demo entitlement remains available only in the explicit local development fixture", async () => {
    const account = await user(false), owner = await session(account.id);
    const created = await owner.client.request("POST", "/api/payments/create", { planId: "studio", method: "card" });
    assert.equal(created.status, 201);
    assert.equal(created.body.provider, "demo");
    assert.equal((await owner.client.request("POST", "/api/payments/confirm-demo", { paymentId: created.body.paymentId })).status, 200);
    assert.equal((await db.prepare("SELECT plan FROM users WHERE id=?").get(account.id) as {
        plan: string;
    }).plan, "studio");
});
test("startup rejects ambiguous environment, public development binding and production demo/default modes", () => {
    const serverRoot = fileURLToPath(new URL("../", import.meta.url));
    const child = (overrides: Record<string, string>, code = "await import('./src/config.ts');") => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", `import dotenv from 'dotenv';dotenv.config=()=>({parsed:{}});${code}`], { cwd: serverRoot, env: { ...process.env, ...overrides }, encoding: "utf8", timeout: 15000 });
    for (const overrides of [{ NODE_ENV: "prod" }, { NODE_ENV: "development", BIND_HOST: "0.0.0.0" },
        { NODE_ENV: "test", BIND_HOST: "::" }, ...["", "invalid", "demo"].map((mode) => ({ NODE_ENV: "production", PAYMENTS_MODE: mode }))]) {
        const result = child(overrides);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /NODE_ENV must|BIND_HOST must|PAYMENTS_MODE must/);
    }
    const production = child({ NODE_ENV: "production", PAYMENTS_MODE: "live", MAIL_PROVIDER: "console", GROUNDWORK_DEV_OTP: "1" }, `const config=await import('./src/config.ts');const providers=await import('./src/payments/providers.ts');const mail=await import('./src/mailer.ts');
    let logged=false;console.log=()=>{logged=true};console.warn=()=>{logged=true};console.error=()=>{logged=true};
    const result=await mail.sendOtpEmail('synthetic@example.invalid','482736');
    process.stdout.write(JSON.stringify({demo:providers.isDemoMode(),dev:config.MAIL.devOtp,via:result.via,hasCode:result.devCode!==undefined,logged}));`);
    assert.equal(production.status, 0);
    assert.deepEqual(JSON.parse(production.stdout), { demo: false, dev: false, via: "error", hasCode: false, logged: false });
    const noOptIn = child({ NODE_ENV: "test", GROUNDWORK_DEV_OTP: "" }, `const mail=await import('./src/mailer.ts');const result=await mail.sendOtpEmail('synthetic@example.invalid','482736');process.stdout.write(JSON.stringify({via:result.via,hasCode:result.devCode!==undefined}));`);
    assert.equal(noOptIn.status, 0);
    assert.deepEqual(JSON.parse(noOptIn.stdout), { via: "error", hasCode: false });
});
test("TOTP step matching uses a bounded window", () => {
    const seed = generateTotpSecret(), clock = 1800000000000;
    assert.equal(matchingTotpStep(seed, totpCode(seed, clock), clock), Math.floor(clock / 30000));
    assert.equal(matchingTotpStep(seed, totpCode(seed, clock - 60000), clock), null);
});
test("corrupt legacy migration fails startup and rolls back earlier seed changes", () => {
    const serverRoot = fileURLToPath(new URL("../", import.meta.url));
    const code = `import dotenv from 'dotenv';dotenv.config=()=>({parsed:{}});
    const {DatabaseSync}=await import('node:sqlite');const {generateTotpSecret}=await import('./src/totp.ts');
    const {db}=await import('./src/db.ts');const seed=generateTotpSecret();
    for(const [id,value] of [['first',seed],['corrupt','invalid-seed']])await db.prepare("INSERT INTO users (id,email,password_salt,password_hash,totp_secret,totp_enabled,password_changed_at,created_at,updated_at) VALUES (?,?,?,?,?,1,1,1,1)").run(id,id+'@example.invalid','fixture','fixture',value);
    await db.close();
    const {spawnSync}=await import('node:child_process');
    const startup=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--import','tsx','--input-type=module','-e',"import dotenv from 'dotenv';dotenv.config=()=>({parsed:{}});await import('./src/db.ts');"],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:10000});
    const rejected=startup.status!==0;
    const verify=new DatabaseSync(process.env.GROUNDWORK_DATA_DIR+'/groundwork.db');
    const rows=verify.prepare('SELECT id,totp_secret,totp_enabled FROM users ORDER BY id').all();verify.close();
    process.stdout.write(JSON.stringify({rejected,allEnabled:rows.every(row=>row.totp_enabled===1),rolledBack:rows.find(row=>row.id==='first').totp_secret===seed}));`;
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", code], {
        cwd: serverRoot, env: { ...process.env, GROUNDWORK_DATA_DIR: join(fixtureDir, "corrupt-migration") }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { rejected: true, allEnabled: true, rolledBack: true });
});
after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
    const safePath = resolve(fixtureDir);
    if (!safePath.startsWith(resolve(tmpdir()) + sep) || !safePath.split(sep).at(-1)?.startsWith("groundwork-auth-security-"))
        throw new Error("Unsafe fixture cleanup");
    rmSync(safePath, { recursive: true, force: true });
});
