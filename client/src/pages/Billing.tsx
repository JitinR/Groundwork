import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { createPayment, getPlans, listPayments } from "../api";
import type { PaymentMethodInfo, PaymentRecord, Plan } from "../types";
import { Badge, Button, Card, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { formatDate, formatMoney } from "../lib/format";
import { cn } from "../lib/cn";
import { PageIntro } from "../components/PageIntro";
import { activePersonalPlan } from "../lib/billing";

const METHOD_ICONS: Record<string, string> = {
  upi: "M11 2h2v5h-2V2zm0 15h2v5h-2v-5zM3 6h4v12H3zM17 6h4v12h-4z",
  card: "M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 12H4v-3h16v3zm0-6H4V6h16v4z",
  paypal: "M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zM8 16l2.5-8h4l-.4 1.2h-2.6l-.6 2h2.5l-.4 1.2h-2.5L9.8 16H8z",
};

const PLAN_FEATURES: Record<string, string[]> = {
  free: ["1 active project", "Photo upload", "PNG/PDF preview", "Community support"],
  pro: ["Unlimited projects", "DXF + OBJ + GLB exports", "Bill of materials CSV", "Email support"],
  studio: ["Everything in Pro", "CAD workflow support (check live availability)", "Client sharing links", "White-label exports", "Priority support"],
};

export function Billing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [methods, setMethods] = useState<PaymentMethodInfo[]>([]);
  const [isDemo, setIsDemo] = useState(true);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [selectedMethod, setSelectedMethod] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [p, recs] = await Promise.all([getPlans(), listPayments()]);
      setPlans(p.plans);
      setMethods(p.methods);
      setIsDemo(p.isDemo);
      setPayments(recs);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load billing.");
      toast.push({ title: "Could not load billing", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const startCheckout = async (plan: Plan) => {
    const method = selectedMethod[plan.id];
    if (!method) {
      toast.push({ title: "Choose a payment method", description: "Select UPI, card or PayPal first.", tone: "info" });
      return;
    }
    setBusy(plan.id);
    try {
      const result = await createPayment(plan.id, method);
      if (result.demo) {
        navigate(`/billing/checkout/${result.paymentId}`);
      } else if (result.provider === "paypal" && result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
      } else if (result.checkoutUrl) {
        window.open(result.checkoutUrl, "_blank", "noopener,noreferrer");
        toast.push({ title: "Checkout opened", description: "Complete the payment in the provider window.", tone: "info" });
        await load();
      }
    } catch (err) {
      toast.push({ title: "Checkout failed", description: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const currentPlan = activePersonalPlan(user);

  return (
    <div className="space-y-8">
      <PageIntro eyebrow="Room to grow" title="A plan for your next chapter." description="Choose the workspace that fits your practice. Manage your subscription and payment history in one place." actions={
        <>
        <Badge tone={currentPlan === "free" ? "slate" : currentPlan === "pro" ? "cyan" : "emerald"}>
          Current: {currentPlan}
        </Badge>
        {isDemo && <Badge tone="amber">Demo payments · no real charge</Badge>}
        </>
      } />

      <Card className="p-5"><h2 className="font-semibold">Know what your plan includes</h2><p className="mt-2 text-sm text-slate-300">Account security controls are in Settings. Native CAD conversion, solver execution and rendering depend on configured services; a subscription does not enable an unavailable worker. Check readiness in the relevant workbench.</p><a href="/workspace-guide.html#capabilities" className="mt-2 inline-block text-sm underline">Review supported workflows and output limits</a></Card>

      {loadError && <Card className="p-5"><p role="alert" className="text-sm text-rose-300">{loadError}</p><Button variant="secondary" className="mt-3" onClick={() => void load()}>Try again</Button></Card>}
      {loading ? (
        <div className="flex h-40 items-center justify-center"><Spinner className="h-6 w-6 text-emerald-400" /></div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            {plans.map((plan) => {
              const active = currentPlan === plan.id;
              return (
                <Card
                  key={plan.id}
                  className={cn(
                    "relative flex flex-col overflow-hidden p-6 transition",
                    active ? "border-emerald-500/50 ring-1 ring-emerald-500/30" : "hover:border-slate-700",
                  )}
                >
                  {active && (
                    <span className="absolute right-4 top-4">
                      <Badge tone="emerald">Your plan</Badge>
                    </span>
                  )}
                  <h2 className="text-lg font-bold text-slate-50">{plan.name}</h2>
                  <div className="mt-2 flex items-baseline gap-1.5">
                    <span className="text-3xl font-extrabold text-slate-50">
                      {formatMoney(plan.price, plan.currency, plan.digits)}
                    </span>
                    <span className="text-sm text-slate-400">/{plan.periodDays >= 365 ? "year" : "month"}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{plan.tagline}</p>

                  <ul className="mt-5 flex-1 space-y-2">
                    {(PLAN_FEATURES[plan.id] ?? []).map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>

                  {!active && (
                    <div className="mt-5 space-y-4">
                      <div className="flex flex-wrap gap-2">
                        {methods.map((m) => {
                          const activeMethod = selectedMethod[plan.id] === m.method;
                          return (
                            <button
                              key={`${plan.id}-${m.method}`}
                              onClick={() => setSelectedMethod({ ...selectedMethod, [plan.id]: m.method })}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition",
                                activeMethod
                                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200",
                              )}
                            >
                              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d={METHOD_ICONS[m.method]} /></svg>
                              {m.method === "upi" ? "UPI" : m.method === "card" ? "Card" : "PayPal"}
                              {m.provider === "demo" && <span className="rounded bg-slate-800 px-1 text-[9px] text-slate-400">demo</span>}
                            </button>
                          );
                        })}
                      </div>
                      <Button className="w-full" loading={busy === plan.id} onClick={() => void startCheckout(plan)}>
                        Choose {plan.name}
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          <Card className="p-6">
            <h2 className="font-semibold text-slate-100">Payment history</h2>
            {payments.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No payments yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                      <th className="pb-2 pr-4">Date</th>
                      <th className="pb-2 pr-4">Plan</th>
                      <th className="pb-2 pr-4">Method</th>
                      <th className="pb-2 pr-4">Amount</th>
                      <th className="pb-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2.5 pr-4 text-slate-300">{formatDate(p.created_at)}</td>
                        <td className="py-2.5 pr-4 capitalize text-slate-200">{p.plan}</td>
                        <td className="py-2.5 pr-4 uppercase text-slate-400">{p.method} · {p.provider}</td>
                        <td className="py-2.5 pr-4 text-slate-200">{formatMoney(p.amount, p.currency, p.digits)}</td>
                        <td className="py-2.5">
                          <Badge tone={p.status === "paid" ? "emerald" : p.status === "pending" ? "amber" : "rose"}>
                            {p.status}
                          </Badge>
                          {p.status === "pending" && p.provider === "paypal" && <Link to={`/billing/checkout/${encodeURIComponent(p.id)}`} className="ml-2 underline">Resume</Link>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
