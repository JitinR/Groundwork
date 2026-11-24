import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { SplashScreen } from "./components/SplashScreen";
import { Button, Spinner } from "./components/ui";
import { AppErrorBoundary } from "./components/AppErrorBoundary";

const Layout = lazy(() => import("./components/Layout").then((m) => ({ default: m.Layout })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Signup = lazy(() => import("./pages/Signup").then((m) => ({ default: m.Signup })));
const VerifyTwoFactor = lazy(() => import("./pages/VerifyTwoFactor").then((m) => ({ default: m.VerifyTwoFactor })));
const AuthComplete = lazy(() => import("./pages/AuthComplete").then((m) => ({ default: m.AuthComplete })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Editor = lazy(() => import("./pages/Editor").then((m) => ({ default: m.Editor })));
const Audit = lazy(() => import("./pages/Audit").then((m) => ({ default: m.Audit })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Billing = lazy(() => import("./pages/Billing").then((m) => ({ default: m.Billing })));
const Checkout = lazy(() => import("./pages/Checkout").then((m) => ({ default: m.Checkout })));
const SharedProject = lazy(() => import("./pages/SharedProject").then((m) => ({ default: m.SharedProject })));
const GeometryWorkbench = lazy(() => import("./pages/GeometryWorkbench").then((m) => ({ default: m.GeometryWorkbench })));
const EngineeringWorkbench = lazy(() => import("./pages/EngineeringWorkbench"));
const ExchangeWorkbench = lazy(() => import("./pages/ExchangeWorkbench").then((m) => ({ default: m.ExchangeWorkbench })));
const OrganizationWorkspace = lazy(() => import("./pages/OrganizationWorkspace").then((m) => ({ default: m.OrganizationWorkspace })));

function FullScreenLoading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <Spinner className="h-7 w-7 text-emerald-400" />
      <p className="gw-kicker">Opening your workspace</p>
    </div>
  );
}

function AuthenticationUnavailable() {
  const { authError, refresh } = useAuth();
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold text-slate-100">Session check unavailable</h1>
        <p role="alert" className="text-sm text-slate-300">{authError}</p>
        <Button onClick={() => void refresh()}>Retry session check</Button>
        <a className="block text-sm underline" href="/">Return to the studio website</a>
      </div>
    </main>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  if (!user) {
    if (status === "checking") return <FullScreenLoading />;
    if (status === "unavailable") return <AuthenticationUnavailable />;
    return <Navigate to="/login" replace />;
  }
  // Retain mounted editor state during a failed refresh without exposing private interaction.
  return <>
    <div key={user.id} style={status === "authenticated" ? undefined : { display: "none" }} aria-hidden={status !== "authenticated" || undefined}>{children}</div>
    {status === "unavailable" && <AuthenticationUnavailable />}
    {status === "checking" && <FullScreenLoading />}
  </>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  if (status === "checking") return <FullScreenLoading />;
  if (status === "unavailable") return <AuthenticationUnavailable />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function StudioHome() {
  useEffect(() => { window.location.replace("/"); }, []);
  return <FullScreenLoading />;
}

export default function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = { "/": "A place for your ideas", "/login": "Welcome back", "/signup": "Create your studio", "/verify-2fa": "Verify your account", "/auth/complete": "Completing sign in", "/dashboard": "Your studio", "/geometry": "Geometry & rendering", "/engineering": "Engineering", "/exchange": "BIM & civil exchange", "/organizations": "Your team", "/settings": "Settings", "/billing": "Plans & billing", "/audit": "Activity & audit" };
    document.title = `${titles[pathname] ?? (pathname.startsWith("/editor/") ? "Design workspace" : pathname.startsWith("/share/") ? "Shared design" : pathname.startsWith("/billing/checkout/") ? "Checkout" : "Design studio")} · Groundwork`;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);
  return (
    <>
      <SplashScreen />
      <AppErrorBoundary resetKey={pathname}>
      <Suspense fallback={<FullScreenLoading />}>
      <Routes>
      <Route path="/" element={<StudioHome />} />
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />
      <Route path="/verify-2fa" element={<PublicOnly><VerifyTwoFactor /></PublicOnly>} />
      <Route path="/auth/complete" element={<AuthComplete />} />
      <Route path="/share/:token" element={<SharedProject />} />

      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/geometry" element={<GeometryWorkbench />} />
        <Route path="/engineering" element={<EngineeringWorkbench />} />
        <Route path="/exchange" element={<ExchangeWorkbench />} />
        <Route path="/organizations" element={<OrganizationWorkspace />} />
        <Route path="/editor/:id" element={<Editor />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/billing/checkout/:paymentId" element={<Checkout />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      </AppErrorBoundary>
    </>
  );
}
