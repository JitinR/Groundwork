import { routeParam } from "../routeParams.js";
import { Router, type ErrorRequestHandler } from "express";
import crypto from "node:crypto";
import { logAudit } from "../audit.js";
import { db, now, withTransaction } from "../db.js";
import { asyncHandler, AuthedRequest, resolveSession } from "../security.js";
import {
  availableMethods,
  isDemoMode,
  planForId,
  PLANS,
  PLAN_LIST,
  providerFor,
  supportsMethod,
  type PaymentMethod,
  type Plan,
  type Provider,
} from "../payments/providers.js";
import { countryInfo, currencyDigits, localPriceMinor } from "../payments/pricing.js";
import { randomId } from "../crypto.js";
import { z } from "zod";
import { BillingError } from "../organization.js";
import { applyTenantReceipt, parseRazorpayPaidReceipt } from "../payments/tenantBilling.js";
import { outboundRequest } from "../outbound.js";

const router = Router();

router.use(asyncHandler(async (req: AuthedRequest, res, next) => {
  // Provider callbacks have no browser session; the handler verifies their signature.
  if (req.method === "POST" && req.path === "/webhook") { next(); return; }
  const session = (await resolveSession(req));
  if (!session || session.status !== "active") {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.user = { id: session.user_id, email: "" };
  req.session = session;
  next();
}));

router.get("/plans", asyncHandler(async (req: AuthedRequest, res) => {
  const userRow = (await db.prepare("SELECT country FROM users WHERE id = ?").get(req.user!.id)) as
    | { country?: string }
    | undefined;
  const country = userRow?.country ?? "IN";
  const info = countryInfo(country);
  const localized = (id: string) => ({
    price: localPriceMinor(country, id),
    currency: info.currency,
    symbol: info.symbol,
    digits: info.digits,
  });
  res.json({
    plans: PLAN_LIST.map((plan) => ({ ...plan, ...localized(plan.id) })),
    free: { ...PLANS.free, ...localized("free") },
    isDemo: isDemoMode(),
    methods: availableMethods(country),
    country: { iso2: country, name: info.name, currency: info.currency, symbol: info.symbol, digits: info.digits },
  });
}));

router.get("/", asyncHandler(async (req: AuthedRequest, res) => {
  const rows = (await db
    .prepare(
      "SELECT id, provider, method, plan, amount, currency, status, provider_order_id, completed_at, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .all(req.user!.id)) as Array<{ currency: string }>;
  res.json({ payments: rows.map(payment => ({ ...payment, digits: currencyDigits(payment.currency) })) });
}));

router.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = (await db
      .prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?")
      .get(routeParam(req, "id"), req.user!.id)) as { currency: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.json({ payment: { ...row, digits: currencyDigits(row.currency) } });
  }),
);

const createSchema = z.object({
  planId: z.enum(["pro", "studio"]),
  method: z.enum(["upi", "card", "paypal"]),
  organizationId: z.string().min(1).max(128).optional(),
});

router.post(
  "/create",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
      return;
    }
    const plan: Plan | undefined = planForId(parsed.data.planId);
    if (!plan) {
      res.status(400).json({ error: "Unknown plan" });
      return;
    }
    const organizationId: string | null = null;
    if (parsed.data.organizationId) {
      res.status(409).json({ error: "Organization capacity requires the separately configured prepaid seat checkout.", code: "tenant_checkout_required" }); return;
    }
    const method = parsed.data.method as PaymentMethod;
    const user = (await db.prepare("SELECT email, country FROM users WHERE id = ?").get(req.user!.id)) as {
      email: string;
      country?: string;
    };
    const country = user.country || "IN";
    if (!supportsMethod(method, country)) {
      res.status(isDemoMode() ? 400 : 503).json({ error: "This payment method is unavailable or its verified live provider is not configured.", code: "payment_unconfigured" });
      return;
    }

    const orderId = randomId();
    let provider: Provider;
    try { provider = providerFor(method, country); }
    catch { res.status(503).json({ error: "Payment provider is not configured for this method and currency.", code: "payment_unconfigured" }); return; }
    const info = countryInfo(country);
    const amount = localPriceMinor(country, plan.id);

    let created;
    try {
      created = await provider.createPayment({
        orderId,
        userId: req.user!.id,
        email: user.email,
        plan,
        method,
        country,
      });
    } catch (err) {
      (await logAudit(req.user!.id, "payment.create_failed", { method, message: String(err) }, req));
      res.status(502).json({ error: err instanceof Error ? err.message : "Payment provider error" });
      return;
    }

    (await db.prepare(
      `INSERT INTO payments (id, user_id, organization_id, provider, method, plan, amount, currency, status, provider_order_id, provider_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderId,
      req.user!.id,
      organizationId,
      created.provider,
      method,
      plan.id,
      amount,
      info.currency,
      "pending",
      created.providerOrderId,
      created.checkoutUrl,
      now(),
    ));

    (await logAudit(req.user!.id, "payment.created", { plan: plan.id, method, provider: created.provider, organizationId }, req));

    res.status(201).json({
      paymentId: orderId,
      provider: created.provider,
      demo: created.demo,
      checkoutUrl: created.checkoutUrl,
      method,
      providerOrderId: created.providerOrderId,
      organizationId,
    });
  }),
);

interface PersonalReceipt { provider: "razorpay" | "paypal"; receiptId: string; providerOrderId: string; merchantAccountId: string; amount: number; currency: string }
async function markPaid(userId: string, paymentId: string, receipt: PersonalReceipt | "demo", sessionId?: string) {
  const completed = (await withTransaction(async () => {
    const payment = (await db.prepare("SELECT plan, amount, currency, status, organization_id, provider, provider_order_id FROM payments WHERE id = ? AND user_id = ?")
      .get(paymentId, userId)) as { plan: string; amount: number; currency: string; status: string; organization_id: string | null; provider: string; provider_order_id: string } | undefined;
    if (!payment || payment.organization_id || !["pro", "studio"].includes(payment.plan)) throw new BillingError("Personal payment not found or tenant receipt unsupported", 409, "invalid_payment");
    if (sessionId && !(await db.prepare("SELECT id FROM sessions WHERE id=? AND user_id=? AND status='active' AND expires_at>?").get(sessionId, userId, now()))) throw new BillingError("Session changed during payment confirmation", 401, "session_changed");
    if (receipt === "demo") {
      if (!isDemoMode() || payment.provider !== "demo") throw new BillingError("Demo confirmation cannot confirm a provider or tenant payment", 403, "demo_only");
    } else {
      if (payment.provider !== receipt.provider || payment.provider_order_id !== receipt.providerOrderId || payment.amount !== receipt.amount || payment.currency !== receipt.currency) throw new BillingError("Receipt does not match the stored personal payment", 400, "invalid_receipt");
      const prior = (await db.prepare("SELECT payment_id,receipt_id,provider,amount,currency,provider_order_id,merchant_account_id FROM payment_receipts WHERE (provider=? AND receipt_id=?) OR payment_id=?")
        .get(receipt.provider, receipt.receiptId, paymentId)) as { payment_id: string; receipt_id: string; provider: string; amount: number; currency: string; provider_order_id: string; merchant_account_id: string } | undefined;
      if (prior && (prior.payment_id !== paymentId || prior.receipt_id !== receipt.receiptId || prior.provider !== receipt.provider || prior.amount !== receipt.amount || prior.currency !== receipt.currency || prior.provider_order_id !== receipt.providerOrderId || prior.merchant_account_id !== receipt.merchantAccountId)) throw new BillingError("Receipt already belongs to another payment", 409, "receipt_conflict");
      if (!prior) (await db.prepare(`INSERT INTO payment_receipts (provider,receipt_id,payment_id,provider_order_id,merchant_account_id,amount,currency,disposition,received_at) VALUES (?,?,?,?,?,?,?,'applied',?)`)
        .run(receipt.provider, receipt.receiptId, paymentId, receipt.providerOrderId, receipt.merchantAccountId, receipt.amount, receipt.currency, now()));
    }
    if (payment.status === "paid") return null;
    if (payment.status !== "pending") throw new BillingError("Payment is no longer pending", 409, "payment_closed");
    const plan = planForId(payment.plan);
    if (!plan || plan.id === "free") return null;
    const t = now();
    const result = (await db.prepare("UPDATE payments SET status = 'paid', completed_at = ? WHERE id = ? AND user_id = ? AND status != 'paid'")
      .run(t, paymentId, userId));
    if (!result.changes) return null;

    (await db.prepare("UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(plan.id, t + plan.periodDays * 86400, t, userId));
    return { plan: plan.id, amount: payment.amount / 10 ** (currencyDigits(payment.currency) ?? 2), currency: payment.currency, organizationId: payment.organization_id };
  }));
  if (completed) (await logAudit(userId, "payment.completed", completed, undefined));
}

/* POST /api/payments/confirm-demo — ONLY reachable in demo mode */
router.post(
  "/confirm-demo",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!isDemoMode()) {
      res.status(403).json({ error: "Demo confirmations are disabled in live mode" });
      return;
    }
    const parsed = z.object({ paymentId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const payment = (await db
      .prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?")
      .get(parsed.data.paymentId, req.user!.id)) as
      | { id: string; status: string; plan: string; provider: string; organization_id: string | null }
      | undefined;
    if (!payment) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    if (payment.organization_id || payment.provider !== "demo") { res.status(403).json({ error: "Demo confirmation is restricted to personal demo payments" }); return; }
    if (payment.status === "paid") {
      res.json({ ok: true });
      return;
    }
    (await markPaid(req.user!.id, payment.id, "demo", req.session!.id));
    res.json({ ok: true });
  }),
);

/* POST /api/payments/paypal-capture — completes a PayPal order in live mode */
router.post(
  "/paypal-capture",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (isDemoMode()) {
      res.status(403).json({ error: "Not available in demo mode" });
      return;
    }
    if (process.env.PAYPAL_MODE !== "live" || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_MERCHANT_ID) {
      res.status(503).json({ error: "Live PayPal capture requires complete credentials and configured merchant identity.", code: "payment_unconfigured" }); return;
    }
    const parsed = z
      .object({ paymentId: z.string().min(1), providerOrderId: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const payment = (await db
      .prepare("SELECT * FROM payments WHERE id = ? AND user_id = ? AND provider = 'paypal'")
      .get(parsed.data.paymentId, req.user!.id)) as
      | { id: string; status: string; provider_order_id: string; amount: number; currency: string; organization_id: string | null }
      | undefined;
    if (!payment || payment.organization_id || payment.provider_order_id !== parsed.data.providerOrderId) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    if (payment.status === "paid") {
      res.json({ ok: true });
      return;
    }
    if (payment.status !== "pending") {
      res.status(409).json({ error: "Payment is no longer pending", code: "payment_closed" });
      return;
    }

    const base = process.env.PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const clientId = process.env.PAYPAL_CLIENT_ID!;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET!;
    const authRes = await outboundRequest(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }, { service: "paypal-auth", allowedOrigins: [base], timeoutMs: 20_000, safeToRetry: true });
    const auth = JSON.parse(authRes.text) as { access_token?: string };
    if (!authRes.ok || !auth.access_token) {
      res.status(502).json({ error: "PayPal authentication failed" });
      return;
    }
    await outboundRequest(`${base}/v2/checkout/orders/${encodeURIComponent(payment.provider_order_id)}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.createHash("sha256").update(`paypal-capture:${payment.id}`).digest("hex").slice(0, 32),
        Prefer: "return=representation",
      },
    }, { service: "paypal-capture", allowedOrigins: [base], timeoutMs: 20_000, safeToRetry: false });
    // Capture representations may omit the original unit metadata. The full
    // authenticated order supplies references/payee plus captured payments;
    // it also reconciles a prior successful capture whose response was lost.
    const fetched = await outboundRequest(`${base}/v2/checkout/orders/${encodeURIComponent(payment.provider_order_id)}`, {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    }, { service: "paypal-orders", allowedOrigins: [base], timeoutMs: 20_000 });
    if (!fetched.ok) { res.status(502).json({ error: "PayPal capture could not be verified" }); return; }
    const captured: unknown = JSON.parse(fetched.text);
    const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const result = object(captured), units = result?.purchase_units;
    if (result?.id === payment.provider_order_id &&
        (result.status === "CREATED" || result.status === "PAYER_ACTION_REQUIRED" || result.status === "SAVED")) {
      res.status(409).json({ error: "Approve this order in PayPal before completing your payment.", code: "paypal_approval_required" });
      return;
    }
    const unit = Array.isArray(units) && units.length === 1 ? object(units[0]) : null;
    const captures = object(unit?.payments)?.captures;
    const capture = Array.isArray(captures) && captures.length === 1 ? object(captures[0]) : null;
    const amount = object(capture?.amount), unitAmount = object(unit?.amount), payee = object(unit?.payee);
    const digits = currencyDigits(payment.currency);
    const value = amount?.value;
    let amountMinor: number | null = null;
    if (typeof value === "string" && digits !== undefined && /^\d+(?:\.\d{1,3})?$/.test(value)) {
      const [whole, fraction = ""] = value.split(".");
      if (fraction.length <= digits) amountMinor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
    }
    if (!result || !unit || !capture || !amount || !unitAmount || !payee || result.id !== payment.provider_order_id || result.status !== "COMPLETED" || unit.reference_id !== payment.id || unit.custom_id !== req.user!.id ||
      payee.merchant_id !== process.env.PAYPAL_MERCHANT_ID || capture.status !== "COMPLETED" || capture.final_capture !== true ||
      typeof capture.id !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(capture.id) || amount?.currency_code !== payment.currency ||
      unitAmount?.currency_code !== payment.currency || unitAmount.value !== value || !Number.isSafeInteger(amountMinor) || amountMinor !== payment.amount) {
      res.status(502).json({ error: "PayPal receipt does not match the stored order, payer reference, merchant, capture, amount or currency.", code: "invalid_receipt" }); return;
    }
    (await markPaid(req.user!.id, payment.id, { provider: "paypal", receiptId: capture.id, providerOrderId: payment.provider_order_id,
      merchantAccountId: process.env.PAYPAL_MERCHANT_ID, amount: payment.amount, currency: payment.currency }, req.session!.id));
    res.json({ ok: true });
  }),
);

/* POST /api/payments/webhook — Razorpay webhook (live mode) */
router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.get("x-razorpay-signature");
    if (!secret || !signature) {
      res.status(400).json({ error: "Missing webhook signature" });
      return;
    }
    const raw = (req as AuthedRequest & { paymentWebhookBody?: Buffer }).paymentWebhookBody;
    if (!raw || !/^[0-9a-f]{64}$/i.test(signature)) {
      res.status(400).json({ error: "Missing webhook body or malformed signature" }); return;
    }
    const expected = crypto.createHmac("sha256", secret).update(raw).digest();
    const received = Buffer.from(signature, "hex");
    const sigOk = expected.length === received.length && crypto.timingSafeEqual(expected, received);
    if (!sigOk) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    try {
      const receipt = parseRazorpayPaidReceipt(req.body);
      if (!receipt) { res.json({ ok: true }); return; }
      const tenant = (await applyTenantReceipt(receipt));
      if (tenant.handled) { res.json({ ok: true, requiresReview: tenant.requiresReview ?? false }); return; }
      const payment = (await db.prepare("SELECT user_id,organization_id FROM payments WHERE id=? AND provider='razorpay'").get(receipt.referenceId)) as { user_id: string; organization_id: string | null } | undefined;
      if (payment?.organization_id) { res.status(409).json({ error: "Legacy tenant payment requires operator reconciliation; it cannot grant seats.", code: "legacy_tenant_payment" }); return; }
      if (payment) {
        if (!process.env.RAZORPAY_ACCOUNT_ID || receipt.merchantAccountId !== process.env.RAZORPAY_ACCOUNT_ID || !process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_")) {
          res.status(503).json({ error: "Razorpay merchant verification is not configured", code: "payment_unconfigured" }); return;
        }
        (await markPaid(payment.user_id, receipt.referenceId, { provider: "razorpay", receiptId: receipt.receiptId, providerOrderId: receipt.linkId,
          merchantAccountId: receipt.merchantAccountId, amount: receipt.amount, currency: receipt.currency }));
      }
    } catch (error) {
      if (error instanceof BillingError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      throw error;
    }
    res.json({ ok: true });
  }),
);

const billingErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (error instanceof BillingError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  next(error);
};
router.use(billingErrorHandler);
export default router;

