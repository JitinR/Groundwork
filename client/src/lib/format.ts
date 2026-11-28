export function formatMoney(minorUnits: number, currency: string, digits?: number): string {
  const precision = digits ?? new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = minorUnits / 10 ** precision;
  if (currency === "INR") {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(
      value,
    );
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: precision, maximumFractionDigits: precision }).format(value);
}

export function formatDate(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function timeAgo(unix: number | null | undefined): string {
  if (!unix) return "—";
  const seconds = Math.floor(Date.now() / 1000) - unix;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return formatDate(unix);
}

export function initials(email: string): string {
  return email
    .split("@")[0]
    .slice(0, 2)
    .toUpperCase();
}

export const ACTION_LABELS: Record<string, string> = {
  "auth.signup": "Account created",
  "auth.login": "Login",
  "auth.login_failed": "Failed login",
  "auth.logout": "Logout",
  "auth.2fa_verified": "2FA verified",
  "auth.2fa_failed": "Invalid 2FA code",
  "auth.2fa_enabled": "2FA enabled",
  "auth.2fa_disabled": "2FA disabled",
  "auth.2fa_setup_started": "2FA setup started",
  "auth.2fa_enable_failed": "2FA enable failed",
  "auth.2fa_disable_failed": "2FA disable failed",
  "auth.password_changed": "Password changed",
  "auth.password_change_failed": "Password change failed",
  "auth.session_revoked": "Session revoked",
  "auth.sessions_revoked_others": "Revoked other sessions",
  "project.created": "Project created",
  "project.updated": "Design saved",
  "project.deleted": "Project deleted",
  "project.photo_uploaded": "Photo uploaded",
  "project.exported": "Exported",
  "payment.created": "Payment started",
  "payment.completed": "Payment completed",
  "payment.create_failed": "Checkout failed",
  "payment.capture_failed": "Payment capture failed",
  "secret.created": "Secret stored",
  "secret.viewed": "Secret revealed",
  "secret.deleted": "Secret deleted",
};

export function actionTone(action: string): "slate" | "emerald" | "rose" | "cyan" | "amber" {
  if (action.includes("failed") || action.includes("_failed") || action.includes("deleted")) return "rose";
  if (action.includes("completed") || action.includes("login") && !action.includes("failed") || action.includes("verified")) return "emerald";
  if (action.includes("exported") || action.includes("photo") || action.includes("created")) return "cyan";
  if (action.includes("password")) return "amber";
  return "slate";
}
