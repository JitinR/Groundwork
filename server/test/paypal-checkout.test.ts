import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import dotenv from "dotenv";

dotenv.config = () => ({ parsed: {} });
const dir = mkdtempSync(join(tmpdir(), "groundwork-paypal-"));
const appOrigin = "https://groundwork.example.invalid";
const merchant = "SYNTHETICMERCHANT";
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: "", SUPABASE_DB_URL: "", DB_PATH: "",
  GROUNDWORK_DATA_DIR: dir, MASTER_KEY: randomBytes(32).toString("base64"), MAIL_PROVIDER: "console",
  PAYMENTS_MODE: "live", PAYPAL_MODE: "live", PAYPAL_CLIENT_ID: "synthetic-client",
  PAYPAL_CLIENT_SECRET: "synthetic-secret", PAYPAL_MERCHANT_ID: merchant, PUBLIC_APP_ORIGIN: appOrigin,
  GROUNDWORK_SERVER_ROLE: "authority", GROUNDWORK_AUTHORITY_GATEWAY_MODE: "direct",
});
const [{ app }, { db, now }, { hashPassword }] = await Promise.all([
  import("../src/index.js"), import("../src/db.js"), import("../src/crypto.js"),
]);

test("PayPal approval returns to checkout and one verified capture activates the saved order", async t => {
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    rmSync(dir, { force: true, recursive: true });
  });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  const account = { id: "billing-fixture", email: "billing@example.invalid", password: "FixtureOnlyPassword12!" };
  const credentials = hashPassword(account.password);
  await db.prepare(`INSERT INTO users(id,email,email_verified,password_salt,password_hash,country,password_changed_at,created_at,updated_at)
    VALUES (?, ?, 1, ?, ?, 'US', ?, ?, ?)`).run(account.id, account.email, credentials.salt, credentials.hash, now(), now(), now());

  const orderId = "SYNTHETICORDER";
  const approvalUrl = `https://www.paypal.com/checkoutnow?token=${orderId}`;
  let savedUnit: { reference_id: string; custom_id: string; payee: { merchant_id: string }; amount: { value: string; currency_code: string } } | undefined;
  let approved = false;
  let captureCount = 0;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.origin === fixtureOrigin) return realFetch(url, init);
    assert.equal(url.origin, "https://api-m.paypal.com");
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "synthetic-access" });
    if (url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body));
      savedUnit = payload.purchase_units[0];
      assert(savedUnit);
      assert.equal(savedUnit.payee.merchant_id, merchant);
      assert.equal(payload.intent, "CAPTURE");
      const context = payload.payment_source.paypal.experience_context;
      assert.equal(context.user_action, "CONTINUE");
      const checkout = `${appOrigin}/billing/checkout/${savedUnit.reference_id}`;
      assert.equal(context.return_url, checkout + "?paypal=approved");
      assert.equal(context.cancel_url, checkout + "?paypal=cancelled");
      return Response.json({ id: orderId, links: [{ rel: "payer-action", href: approvalUrl }] }, { status: 201 });
    }
    if (url.pathname === `/v2/checkout/orders/${orderId}/capture` && init?.method === "POST") {
      assert(approved);
      assert(new Headers(init.headers).has("PayPal-Request-Id"));
      captureCount++;
      return Response.json({ id: orderId, status: "COMPLETED" }, { status: 201 });
    }
    assert.equal(url.pathname, `/v2/checkout/orders/${orderId}`);
    assert(savedUnit);
    return Response.json({ id: orderId, status: "COMPLETED", purchase_units: [{
      ...savedUnit, payments: { captures: [{ id: "SYNTHETICCAPTURE", status: "COMPLETED", final_capture: true, amount: savedUnit.amount }] },
    }] });
  });
  const response = await fetch(fixtureOrigin + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  assert.equal(response.status, 200);
  const { csrfToken } = await response.json();
  const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const request = (path: string, body?: unknown) => fetch(fixtureOrigin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await request("/api/payments/create", { planId: "pro", method: "paypal" });
  assert.equal(created.status, 201);
  const checkout = await created.json();
  assert.equal(checkout.checkoutUrl, approvalUrl);
  assert.equal(checkout.providerOrderId, orderId);
  approved = true;
  const body = { paymentId: checkout.paymentId, providerOrderId: orderId };
  const capture = await request("/api/payments/paypal-capture", body);
  assert.equal(capture.status, 200, await capture.text());
  assert.equal((await request("/api/payments/paypal-capture", body)).status, 200);
  assert.equal(captureCount, 1);
  const receipt = await (await request(`/api/payments/${checkout.paymentId}`)).json();
  assert.equal(receipt.payment.status, "paid");
  const session = await (await request("/api/auth/me")).json();
  assert.equal(session.user.plan, "pro");
});
