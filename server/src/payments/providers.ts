import { countryInfo, localPriceMinor } from "./pricing.js";
import { IS_PROD, PAYMENTS_MODE } from "../config.js";
import { outboundRequest } from "../outbound.js";

export interface Plan {
  id: string;
  name: string;
  /** base price in INR paise (all countries convert from this) */
  price: number;
  currency: string;
  periodDays: number;
  tagline: string;
}

export const PLANS: Record<string, Plan> = {
  free: { id: "free", name: "Free", price: 0, currency: "INR", periodDays: 0, tagline: "1 active project" },
  pro: { id: "pro", name: "Pro", price: 200000, currency: "INR", periodDays: 30, tagline: "Unlimited projects + exports" },
  studio: { id: "studio", name: "Studio", price: 400000, currency: "INR", periodDays: 30, tagline: "All Pro features + CAD connectors + priority support" },
};

export const PLAN_LIST: Plan[] = [PLANS.pro, PLANS.studio];

export function planForId(id: string): Plan | undefined {
  return PLANS[id];
}

export type PaymentMethod = "card" | "upi" | "paypal";

export interface CreatePaymentParams {
  orderId: string;
  userId: string;
  email: string;
  plan: Plan;
  method: PaymentMethod;
  /** ISO-2 country the price is denominated in */
  country: string;
}

export interface CreatedPayment {
  provider: string;
  providerOrderId: string;
  checkoutUrl: string | null;
  /** demo mode: the frontend shows its own checkout and confirms via confirm-demo */
  demo: boolean;
  method: PaymentMethod;
}

export interface Provider {
  id: string;
  supports: PaymentMethod[];
  createPayment(p: CreatePaymentParams): Promise<CreatedPayment>;
}

/* ----------------------------- Demo provider ----------------------------- */
/* Simulates the full payment flow locally / without merchant credentials.  */

const demoProvider: Provider = {
  id: "demo",
  supports: ["card", "upi", "paypal"],
  async createPayment(p) {
    return {
      provider: "demo",
      providerOrderId: `demo_${p.orderId}`,
      checkoutUrl: null,
      demo: true,
      method: p.method,
    };
  },
};

/* ------------------------- Razorpay (UPI + cards) ------------------------ */
/* INR only. Uses the Payment Links API via native fetch — no SDK dependency. */

const RAZORPAY_BASE = "https://api.razorpay.com/v1";
const RAZORPAY_BASE64 = (() => {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return key && secret ? Buffer.from(`${key}:${secret}`).toString("base64") : null;
})();

const razorpayProvider: Provider = {
  id: "razorpay",
  supports: ["card", "upi"],
  async createPayment(p) {
    if (!RAZORPAY_BASE64) throw new Error("Razorpay keys are not configured");
    const amount = localPriceMinor(p.country, p.plan.id);
    const resp = await outboundRequest(`${RAZORPAY_BASE}/payment_links`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${RAZORPAY_BASE64}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "INR",
        accept_partial: false,
        description: `Groundwork ${p.plan.name} plan`,
        customer: { email: p.email, contact: "" },
        notes: { order_id: p.orderId, user_id: p.userId },
        reference_id: p.orderId,
      }),
    }, { service: "razorpay", allowedOrigins: ["https://api.razorpay.com"], safeToRetry: false });
    // A reference_id alone does not establish durable provider idempotency.
    // Ambiguous creation failures must be reconciled instead of replayed.
    const body = JSON.parse(resp.text) as { id?: string; short_url?: string; error?: { description?: string } };
    if (!resp.ok || !body.id) {
      throw new Error(body.error?.description || "Razorpay order creation failed");
    }
    return {
      provider: "razorpay",
      providerOrderId: body.id,
      checkoutUrl: body.short_url ?? null,
      demo: false,
      method: p.method,
    };
  },
};

/* ------------------------------ PayPal ----------------------------------- */
/* Orders v2 via REST API. Sandbox mode when PAYPAL_MODE=sandbox.            */

const PAYPAL_BASE = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

function paypalCheckoutOrigin(value = process.env.PUBLIC_APP_ORIGIN): string | null {
  try {
    const url = new URL(value ?? "");
    if (url.protocol === "https:" && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch { /* Checkout is unavailable until a public origin is configured. */ }
  return null;
}

export function paypalExperienceContext(orderId: string, publicOrigin = process.env.PUBLIC_APP_ORIGIN) {
  const origin = paypalCheckoutOrigin(publicOrigin);
  if (!origin) throw new Error("PayPal checkout requires a fixed HTTPS application origin");
  const checkout = new URL(`/billing/checkout/${encodeURIComponent(orderId)}`, origin);
  const callback = (result: "approved" | "cancelled") => {
    checkout.searchParams.set("paypal", result);
    return checkout.href;
  };
  return {
    brand_name: "Groundwork",
    shipping_preference: "NO_SHIPPING",
    user_action: "CONTINUE",
    return_url: callback("approved"),
    cancel_url: callback("cancelled"),
  };
}

export function paypalApprovalUrl(links: { rel: string; href: string }[] = [], live = process.env.PAYPAL_MODE === "live"): string | null {
  const expectedOrigin = live ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  for (const link of links) {
    if (link.rel !== "payer-action" && link.rel !== "approve") continue;
    try {
      const url = new URL(link.href);
      if (url.origin === expectedOrigin && !url.username && !url.password) return url.href;
    } catch { /* A malformed HATEOAS link cannot be used for checkout. */ }
  }
  return null;
}

const paypalProvider: Provider = {
  id: "paypal",
  supports: ["paypal", "card"],
  async createPayment(p) {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("PayPal credentials are not configured");
    const experienceContext = paypalExperienceContext(p.orderId);

    const authRes = await outboundRequest(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }, { service: "paypal-auth", allowedOrigins: [PAYPAL_BASE], safeToRetry: true });
    const auth = JSON.parse(authRes.text) as { access_token?: string };
    if (!authRes.ok || !auth.access_token) throw new Error("PayPal authentication failed");

    const info = countryInfo(p.country);
    const amountMinor = localPriceMinor(p.country, p.plan.id);
    const value = (amountMinor / Math.pow(10, info.digits)).toFixed(info.digits);

    const res = await outboundRequest(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": p.orderId,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: p.orderId,
            custom_id: p.userId,
            ...(process.env.PAYPAL_MERCHANT_ID ? { payee: { merchant_id: process.env.PAYPAL_MERCHANT_ID } } : {}),
            amount: { currency_code: info.currency, value },
            description: `Groundwork ${p.plan.name} plan`,
          },
        ],
        payment_source: { paypal: { experience_context: experienceContext } },
      }),
    }, { service: "paypal-orders", allowedOrigins: [PAYPAL_BASE], safeToRetry: false });
    const order = JSON.parse(res.text) as { id?: string; links?: { rel: string; href: string }[] };
    if (!res.ok || !order.id) {
      throw new Error("PayPal order creation failed");
    }
    const approveLink = paypalApprovalUrl(order.links);
    if (!approveLink) throw new Error("PayPal did not provide an approval link");
    return {
      provider: "paypal",
      providerOrderId: order.id,
      checkoutUrl: approveLink,
      demo: false,
      method: p.method,
    };
  },
};

/* ------------------------------ Selection -------------------------------- */

function paymentMode(): "demo" | "live" {
  if (IS_PROD && PAYMENTS_MODE !== "live") throw new Error("Demo payments are disabled in production");
  return PAYMENTS_MODE === "live" ? "live" : "demo";
}

export function isDemoMode(): boolean {
  return paymentMode() === "demo";
}

export function isInrCountry(country: string | undefined | null): boolean {
  return countryInfo(country).currency === "INR";
}

export interface MethodOption {
  method: PaymentMethod;
  label: string;
  provider: string;
}

export function availableMethods(country: string | undefined | null): MethodOption[] {
  const inr = isInrCountry(country);
  if (isDemoMode()) {
    const out: MethodOption[] = [];
    if (inr) out.push({ method: "upi", label: "UPI", provider: "demo" });
    out.push({ method: "card", label: "Credit / Debit Card", provider: "demo" });
    out.push({ method: "paypal", label: "PayPal", provider: "demo" });
    return out;
  }
  const out: MethodOption[] = [];
  const raz = RAZORPAY_BASE64 && process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") && process.env.RAZORPAY_WEBHOOK_SECRET && process.env.RAZORPAY_ACCOUNT_ID;
  const pay = process.env.PAYPAL_MODE === "live" && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_MERCHANT_ID && paypalCheckoutOrigin();
  if (inr && raz) {
    out.push({ method: "upi", label: "UPI", provider: "razorpay" });
    out.push({ method: "card", label: "Credit / Debit Card", provider: "razorpay" });
  } else if (inr) {
    // INR but no Razorpay keys → PayPal fallback (handled by conversion below)
  }
  if (pay) out.push({ method: "paypal", label: "PayPal", provider: "paypal" });
  if (!inr && pay) out.push({ method: "card", label: "Credit / Debit Card", provider: "paypal" });
  return out;
}

export function providerFor(method: PaymentMethod, country: string | undefined | null): Provider {
  const inr = isInrCountry(country);
  if (isDemoMode()) return demoProvider;
  if (method === "paypal") return paypalProvider;
  if (method === "upi") {
    if (!inr) throw new Error("UPI is only available for India");
    if (!RAZORPAY_BASE64) throw new Error("Razorpay keys are not configured");
    return razorpayProvider;
  }
  // card
  if (inr && RAZORPAY_BASE64) return razorpayProvider;
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_MERCHANT_ID) return paypalProvider;
  throw new Error("Card payments are not configured for this country");
}

export function supportsMethod(method: PaymentMethod, country: string | undefined | null): boolean {
  return availableMethods(country).some((m) => m.method === method);
}

/** Separate priced tenant product; it never routes through the demo provider or personal plan prices. */
export async function createTenantSeatLink(p: { orderId: string; userId: string; organizationId: string; email: string; amount: number; expireBy: number }): Promise<CreatedPayment> {
  const key = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  if (process.env.PAYMENTS_MODE !== "live" || !key?.startsWith("rzp_live_") || !secret) throw new Error("Live tenant checkout is not configured");
  const response = await outboundRequest(`${RAZORPAY_BASE}/payment_links`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: p.amount, currency: "INR", accept_partial: false, reference_id: p.orderId, expire_by: p.expireBy,
      description: "Groundwork prepaid organization seat term", customer: { email: p.email },
      notes: { order_id: p.orderId, user_id: p.userId, organization_id: p.organizationId } }),
  }, { service: "razorpay", allowedOrigins: ["https://api.razorpay.com"], timeoutMs: 20_000, safeToRetry: false });
  const result = JSON.parse(response.text) as { id?: unknown; short_url?: unknown; amount?: unknown; currency?: unknown; reference_id?: unknown; accept_partial?: unknown };
  if (!response.ok || typeof result.id !== "string" || !/^plink_[A-Za-z0-9]+$/.test(result.id) || result.amount !== p.amount ||
    result.currency !== "INR" || result.reference_id !== p.orderId || result.accept_partial !== false || typeof result.short_url !== "string") {
    throw new Error("Provider checkout response does not match the priced intent");
  }
  const checkout = new URL(result.short_url);
  if (checkout.protocol !== "https:" || checkout.hostname !== "rzp.io" || checkout.username || checkout.password || checkout.port) throw new Error("Invalid provider checkout URL");
  return { provider: "razorpay", providerOrderId: result.id, checkoutUrl: checkout.href, demo: false, method: "card" };
}
