import type { PaymentRecord, User } from "../types";

export function activePersonalPlan(user: Pick<User, "plan" | "planExpiresAt"> | null | undefined, timeSeconds = Math.floor(Date.now() / 1000)): string {
  return user && (user.planExpiresAt === null || user.planExpiresAt > timeSeconds) ? user.plan : "free";
}

export function pendingPayPalOrder(payment: PaymentRecord | null, params: URLSearchParams): string | null {
  if (payment?.provider !== "paypal" || payment.status !== "pending" || !payment.provider_order_id) return null;
  const state = params.get("paypal");
  if (state === null || state === "approved" && params.get("token") === payment.provider_order_id) return payment.provider_order_id;
  return null;
}
