import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import "./public-experience.css";
import "./auth-experience.css";

function readMotionPreference(): boolean {
  try { return localStorage.getItem("groundwork-motion") !== "off"; }
  catch { return true; }
}

export function AuthShell({ children, stage = "login" }: { children: ReactNode; stage?: "login" | "signup" | "verify" }) {
  const [motionRequested, setMotionRequested] = useState(readMotionPreference);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const motionEnabled = motionRequested && !reducedMotion;
  const [Scene, setScene] = useState<ComponentType<{ motionEnabled: boolean }> | null>(null);
  useEffect(() => {
    if (!motionEnabled || !window.matchMedia("(min-width: 781px)").matches) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void import("../components/AuthCityScene").then(module => { if (!cancelled) setScene(() => module.AuthCityScene); }).catch(() => { /* Keep the account form usable if decorative assets fail. */ });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [motionEnabled]);

  useEffect(() => {
    document.documentElement.classList.add("studio-auth-open");
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateSystemPreference = () => setReducedMotion(preference.matches);
    const updateStoredPreference = (event: StorageEvent) => {
      if (event.key === "groundwork-motion" || event.key === null) setMotionRequested(readMotionPreference());
    };
    preference.addEventListener("change", updateSystemPreference);
    window.addEventListener("storage", updateStoredPreference);
    return () => {
      document.documentElement.classList.remove("studio-auth-open");
      preference.removeEventListener("change", updateSystemPreference);
      window.removeEventListener("storage", updateStoredPreference);
    };
  }, []);

  function toggleMotion() {
    const next = !motionRequested;
    setMotionRequested(next);
    try { localStorage.setItem("groundwork-motion", next ? "on" : "off"); } catch { /* Preference storage is optional. */ }
    window.dispatchEvent(new Event("groundwork:motionchange"));
  }

  return <div className="gw-public public-auth studio-auth" data-motion={motionEnabled ? "on" : "off"}>
    <a className="auth-skip-link" href="#auth-form">Skip to account form</a>
    <header className="public-auth-header">
      <Link to="/" aria-label="Groundwork home" className="studio-auth-brand">
        <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M39 9H9v30h30V24H24" stroke="currentColor" strokeWidth="5"/><path d="M39 9v8" stroke="var(--public-accent)" strokeWidth="5"/></svg>
        <span>groundwork<sup>®</sup></span>
      </Link>
      <div className="auth-header-actions">
        <button
          className="auth-motion-toggle"
          type="button"
          onClick={toggleMotion}
          aria-pressed={motionEnabled}
          disabled={reducedMotion}
          title={reducedMotion ? "Motion is paused to respect your system preference." : undefined}
        >
          <span className="motion-dot" aria-hidden="true" />
          <span>Motion <span aria-hidden="true">{motionEnabled ? "on" : "off"}</span></span>
        </button>
        <Link to="/" className="public-auth-back"><span aria-hidden="true">↖</span> Back to the studio</Link>
      </div>
    </header>
    <main className="public-auth-layout" id="auth-main" tabIndex={-1}>
      <aside className="public-auth-art" aria-hidden="true">
        {Scene ? <Scene motionEnabled={motionEnabled} /> : <div className="auth-city-scene"><div className="auth-city-fallback">{[0, 1, 2, 3].map(index => <i className="auth-city-fallback__building" key={index} />)}</div></div>}
        <div className="public-auth-art-copy">
          <p className="public-eyebrow"><span className="public-status-dot"/> CONSIDERED FROM THE GROUND UP.</p>
          <h2 id="auth-studio-heading">Shaping spaces<br/>that <em>endure.</em></h2>
          <p>Every place. A possibility.<br/>Your next chapter starts here.</p>
        </div>
        <div className="auth-perspective-card" aria-hidden="true"><span className="auth-perspective-cross">+</span><span className="auth-micro-label">A DIFFERENT PERSPECTIVE</span><p>Room for<br/><em>possibility.</em></p><small>X 028.6139&nbsp; Y 077.2090</small></div>
        <div className="public-auth-art-foot"><span>GROUNDWORK / POINT-SCAN STUDY</span><span>ARCHITECTURE + INTERIORS</span></div>
      </aside>
      <div id="auth-form" tabIndex={-1} className={`public-auth-content public-auth-content-${stage}`}><div className="public-auth-progress"><span className="public-status-dot"/><span>{stage === "login" ? "WELCOME TO YOUR WORKSPACE" : stage === "signup" ? "YOUR STUDIO STARTS HERE" : "ONE MORE STEP"}</span></div>{children}<p className="public-auth-footnote"><a href="/privacy.html">Privacy & local data</a> · <a href="/use-and-limitations.html">Use & output limits</a> · <a href="/workspace-guide.html">Explore the workspace</a></p></div>
    </main>
    <footer className="public-auth-footer"><span>© {new Date().getFullYear()} Groundwork. All considered.</span><span>ARCHITECTURE + INTERIORS</span></footer>
  </div>;
}
