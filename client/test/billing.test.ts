import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRecord } from "../src/types.ts";
import { activePersonalPlan, pendingPayPalOrder } from "../src/lib/billing.ts";
import { formatMoney } from "../src/lib/format.ts";

test("an expired subscription uses the Free plan even with a stored paid plan", () => {
  assert.equal(activePersonalPlan({ plan: "pro", planExpiresAt: 100 }, 100), "free");
  assert.equal(activePersonalPlan({ plan: "studio", planExpiresAt: 101 }, 100), "studio");
  assert.equal(activePersonalPlan({ plan: "pro", planExpiresAt: null }, 100), "pro");
});

test("payment history uses the actual currency minor units", () => {
  assert.equal(formatMoney(3636, "JPY"), "¥3,636");
  assert.match(formatMoney(929, "OMR"), /0\.929$/);
  assert.match(formatMoney(384616, "IDR", 0), /384,616$/);
  assert.equal(formatMoney(1999, "USD"), "$19.99");
});

test("PayPal completion binds an approval return to the saved pending order", () => {
  const payment: PaymentRecord = {
    id: "payment", provider: "paypal", method: "paypal", plan: "pro", amount: 3900, currency: "USD",
    status: "pending", provider_order_id: "order", completed_at: null, created_at: 1,
  };
  assert.equal(pendingPayPalOrder(payment, new URLSearchParams("paypal=approved&token=order")), "order");
  assert.equal(pendingPayPalOrder(payment, new URLSearchParams("paypal=approved&token=other")), null);
  assert.equal(pendingPayPalOrder(payment, new URLSearchParams("paypal=cancelled&token=order")), null);
  assert.equal(pendingPayPalOrder(payment, new URLSearchParams()), "order");
  assert.equal(pendingPayPalOrder({ ...payment, status: "paid" }, new URLSearchParams()), null);
});
