import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { completePayPalPayment, confirmDemoPayment, getPayment } from "../api";
import { useAuth } from "../auth";
import { Button, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { activePersonalPlan, pendingPayPalOrder } from "../lib/billing";
import { formatDate, formatMoney } from "../lib/format";
import type { PaymentRecord } from "../types";
import "./checkout.css";

type CheckoutStep = "details" | "review" | "done";
type CheckoutState = { id: string; payment: PaymentRecord | null; error: string; loading: boolean };
const steps: { id: CheckoutStep; label: string }[] = [{ id: "details", label: "Plan details" }, { id: "review", label: "Review" }, { id: "done", label: "Complete" }];
const methodLabels: Record<string, string> = { upi: "UPI", card: "Card", paypal: "PayPal" };
export function Checkout() {
  const { paymentId = "" } = useParams<{ paymentId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh, user } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<CheckoutState>({ id: "", payment: null, error: "", loading: true });
  const [stepState, setStepState] = useState<{ id: string; step: CheckoutStep }>({ id: "", step: "details" });
  const [payingId, setPayingId] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState("");
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const scopeRef = useRef(paymentId);
  const payingRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  scopeRef.current = paymentId;
  const payment = state.id === paymentId ? state.payment : null;
  const error = state.id === paymentId ? state.error : "";
  const loading = state.id !== paymentId || state.loading;
  const step = stepState.id === paymentId ? stepState.step : "details";
  const paying = payingId === paymentId;
  const isDemo = payment?.provider === "demo";
  const canConfirm = isDemo && payment?.status === "pending";
  const paypalOrder = pendingPayPalOrder(payment, searchParams);
  const planActive = activePersonalPlan(user) === payment?.plan;
  let checkoutInstructions = "This payment uses an external provider. Complete it through the provider checkout from your billing page.";
  if (canConfirm) checkoutInstructions = "Review the plan details before activating your demo plan.";
  if (payment?.status !== "pending") checkoutInstructions = "Return to billing to view this payment or start a new checkout.";
  if (payment?.provider === "paypal" && payment.status === "pending") {
    if (searchParams.get("paypal") === "cancelled") checkoutInstructions = "PayPal checkout was cancelled. Return to billing to start again.";
    else if (paypalOrder) checkoutInstructions = "If you approved this order in PayPal, complete your payment below.";
    else checkoutInstructions = "This PayPal return could not be matched to this payment. Open the payment from billing to resume.";
  }
  const stepIndex = steps.findIndex((item) => item.id === step);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setState({ id: paymentId, payment: null, error: "", loading: true });
    setStepState({ id: paymentId, step: "details" });
    setConfirmationError("");
    const current = () => mountedRef.current && request === requestRef.current && scopeRef.current === paymentId;
    if (!paymentId) { setState({ id: paymentId, payment: null, error: "This checkout is missing its payment reference.", loading: false }); return; }
    try {
      const response = await getPayment(paymentId);
      if (!current()) return;
      setState({ id: paymentId, payment: response.payment, error: "", loading: false });
      setStepState({ id: paymentId, step: response.payment.status === "paid" ? "done" : "details" });
    } catch (err) {
      if (current()) setState({ id: paymentId, payment: null, error: err instanceof Error ? err.message : "This checkout could not be loaded.", loading: false });
    }
  }, [paymentId]);

  useEffect(() => {
    mountedRef.current = true;
    payingRef.current = null;
    setPayingId(null);
    void load();
    return () => { mountedRef.current = false; requestRef.current++; };
  }, [load]);

  const changeStep = (next: CheckoutStep) => {
    if (paying) return;
    setConfirmationError("");
    setStepState({ id: paymentId, step: next });
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const pay = async () => {
    if (!paymentId || !payment || payingRef.current || (!canConfirm && !paypalOrder)) return;
    const id = paymentId;
    const savedPayment = payment;
    const current = () => mountedRef.current && scopeRef.current === id;
    payingRef.current = id;
    setPayingId(id);
    setConfirmationError("");
    try {
      const result = paypalOrder ? await completePayPalPayment(id, paypalOrder) : await confirmDemoPayment(id);
      if (!result.ok) throw new Error("The payment was not confirmed. Please try again.");
      if (!current()) return;
      // A confirmed payment stays complete even if the optional receipt refresh is unavailable.
      const receipt = await getPayment(id).then((response) => response.payment).catch(() => null);
      if (!current()) return;
      setState({ id, payment: receipt?.status === "paid" ? receipt : { ...savedPayment, status: "paid", completed_at: Math.floor(Date.now() / 1000) }, error: "", loading: false });
      setStepState({ id, step: "done" });
      toast.push(isDemo
        ? { title: "Demo plan activated", description: "Your plan is active. No real payment was charged.", tone: "success" }
        : { title: "Payment complete", description: "Your PayPal payment has been recorded.", tone: "success" });
      void refresh().catch(() => undefined);
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch (err) {
      if (current()) setConfirmationError(err instanceof Error ? err.message : "The payment could not be completed. Please try again.");
    } finally {
      if (current()) { payingRef.current = null; setPayingId(null); }
    }
  };

  return <div className="gw-checkout">
    <Link to="/billing" className="gw-checkout__back"><span aria-hidden="true">←</span> Back to billing</Link>
    <div className="gw-checkout__intro"><p className="gw-kicker">A little more room to create</p><h1>Make your next move.</h1><p>{payment && !isDemo ? "Review your plan and payment record." : "Review your plan and complete the demo activation."}</p></div>
    {loading ? <section className="gw-checkout__loading" aria-busy="true"><Spinner className="h-7 w-7" /><p>Preparing your checkout…</p></section>
      : error || !payment ? <section className="gw-checkout__unavailable"><ReceiptIcon /><h2>Checkout unavailable</h2><p role="alert">{error || "This payment record could not be found."}</p><div><Button variant="secondary" onClick={() => void load()}>Try again</Button><Link to="/billing" className="gw-link-button gw-button-outline">Return to billing</Link></div></section>
      : <>
        <ol className="gw-checkout__steps" aria-label="Checkout progress">{steps.map((item, index) => <li key={item.id} className={`${index <= stepIndex ? "is-active" : ""} ${index < stepIndex ? "is-complete" : ""}`} aria-current={item.id === step ? "step" : undefined}><span>{index < stepIndex ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 3 3 5-6" /></svg> : index + 1}</span><p>{item.label}</p>{index < steps.length - 1 && <i aria-hidden="true" />}</li>)}</ol>
        <div className="gw-checkout__layout">
          <section className="gw-checkout__flow" aria-labelledby="checkout-step-heading" aria-busy={paying || undefined}>
            <div className="gw-checkout__flow-heading"><p className="gw-kicker">{step === "details" ? "01 / Your workspace" : step === "review" ? "02 / One last look" : "03 / Ready to create"}</p><h2 id="checkout-step-heading" ref={headingRef} tabIndex={-1}>{step === "details" ? "The plan, at a glance." : step === "review" ? "Everything look right?" : isDemo ? "Your next chapter starts here." : "Payment complete."}</h2></div>
            {isDemo && <div className="gw-checkout__demo"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 7 4v8l-7 4-7-4V6l7-4Zm0 4v5m0 3h.01" /></svg><div><strong>Demo checkout · no real charge</strong><p>No card, UPI, or other payment information is needed.</p></div></div>}
            {step === "details" && <>
              <p className="gw-checkout__copy">{checkoutInstructions}</p>
              <dl className="gw-checkout__summary"><div><dt>Selected plan</dt><dd>Groundwork <span className="gw-checkout__capitalize">{payment.plan}</span></dd></div><div><dt>Plan price</dt><dd>{formatMoney(payment.amount, payment.currency, payment.digits)}</dd></div><div><dt>{isDemo ? "Simulated method" : "Payment method"}</dt><dd>{methodLabels[payment.method] ?? payment.method}</dd></div><div><dt>Status</dt><dd className="gw-checkout__capitalize">{payment.status}</dd></div><div><dt>Created</dt><dd>{formatDate(payment.created_at)}</dd></div>{isDemo && <div className="gw-checkout__total"><dt>Amount charged today</dt><dd>{formatMoney(0, payment.currency, payment.digits)}</dd></div>}</dl>
              {paypalOrder && confirmationError && <div className="gw-checkout__error" role="alert"><strong>Payment could not be completed</strong><p>{confirmationError}</p></div>}
              {canConfirm && <Button className="gw-checkout__continue" onClick={() => changeStep("review")}>Continue to review <span aria-hidden="true">↗</span></Button>}
              {paypalOrder && <Button className="gw-checkout__continue" loading={paying} onClick={() => void pay()}>Complete PayPal payment</Button>}
              {!canConfirm && !paypalOrder && <Link to="/billing" className="gw-link-button gw-button-secondary">Return to billing <span aria-hidden="true">↗</span></Link>}
            </>}
            {step === "review" && <>
              <p className="gw-checkout__copy">Confirming will activate the <span className="gw-checkout__capitalize">{payment.plan}</span> plan on your account through the demo payment system.</p>
              <dl className="gw-checkout__summary"><div><dt>Your plan</dt><dd>Groundwork <span className="gw-checkout__capitalize">{payment.plan}</span></dd></div><div><dt>Listed plan price</dt><dd>{formatMoney(payment.amount, payment.currency, payment.digits)}</dd></div><div><dt>Checkout mode</dt><dd>Demo simulation</dd></div><div className="gw-checkout__total"><dt>Actual amount charged</dt><dd>{formatMoney(0, payment.currency, payment.digits)}</dd></div></dl>
              {confirmationError && <div className="gw-checkout__error" role="alert"><strong>Activation could not be completed</strong><p>{confirmationError}</p></div>}
              <div className="gw-checkout__actions"><Button variant="secondary" disabled={paying} onClick={() => changeStep("details")}>Back</Button><Button className="gw-checkout__confirm" loading={paying} disabled={!canConfirm} onClick={() => void pay()}>{confirmationError ? "Try demo activation again" : "Activate demo plan"}<span aria-hidden="true">↗</span></Button></div>
              <p className="gw-checkout__footnote">{paying ? "Confirming your demo activation…" : "No real payment will be collected."}</p>
            </>}
            {step === "done" && <div className="gw-checkout__success" role="status"><div className="gw-checkout__success-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m9 16 5 5 10-11" /></svg></div><h3>Groundwork <span className="gw-checkout__capitalize">{payment.plan}</span> {planActive ? "is active." : "checkout is complete."}</h3><p>{isDemo ? "Your demo activation is complete. No real payment was charged." : "Your payment has been recorded."} {planActive ? "Your workspace is ready for your next idea." : "View your current plan and payment history in billing."}</p><dl className="gw-checkout__summary"><div><dt>{isDemo ? "Demo status" : "Payment status"}</dt><dd>Complete</dd></div>{payment.completed_at && <div><dt>Completed</dt><dd>{formatDate(payment.completed_at)}</dd></div>}{isDemo && <div><dt>Actual amount charged</dt><dd>{formatMoney(0, payment.currency, payment.digits)}</dd></div>}</dl><Button className="gw-checkout__continue" onClick={() => navigate("/dashboard")}>Go to your workspace <span aria-hidden="true">↗</span></Button><Link to="/billing" className="gw-checkout__receipt-link">View billing history</Link></div>}
          </section>
          <aside className={`gw-checkout__order ${step === "done" ? "is-done" : ""}`} aria-label="Order summary">
            <div className="gw-checkout__art" aria-hidden="true"><div className="gw-checkout__art-grid" /><div className="gw-checkout__floating-card gw-checkout__floating-card--back" /><div className="gw-checkout__floating-card"><div className="gw-checkout__card-logo"><svg viewBox="0 0 24 28"><path d="m12 2 10 6v12l-10 6-10-6V8l10-6Zm0 0v12m10-6L12 14 2 8m10 6v12" /></svg><span>Groundwork.</span></div><div className="gw-checkout__card-chip"><i /><i /><i /></div><p>SPACE FOR WHAT’S NEXT</p><div className="gw-checkout__card-bottom"><span>{payment.plan}</span><svg viewBox="0 0 32 32"><path d={step === "done" ? "m8 16 6 6 11-13" : "M16 3v26M3 16h26"} /></svg></div></div><span className="gw-checkout__art-caption">A WORKSPACE WITH PERSPECTIVE</span></div>
            <div className="gw-checkout__order-details"><p className="gw-kicker">{step === "done" ? "Activation complete" : "Your selection"}</p><h2>Groundwork <span className="gw-checkout__capitalize">{payment.plan}</span></h2><p className="gw-checkout__order-price">{formatMoney(payment.amount, payment.currency, payment.digits)}<span>listed plan price</span></p><div className="gw-checkout__order-mode"><span>{isDemo ? "Demo mode" : "Provider payment"}</span><span>{step === "done" ? "Complete" : isDemo ? "No real charge" : payment.status}</span></div><p className="gw-checkout__reference">Reference <span>{payment.id}</span></p></div>
          </aside>
        </div>
      </>}
  </div>;
}

function ReceiptIcon() {
  return <svg viewBox="0 0 40 48" width="40" height="48" fill="none" aria-hidden="true"><path d="M7 3h26v40l-4-3-5 3-4-3-4 3-5-3-4 3V3Zm7 11h12m-12 8h12m-12 8h8" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
