import { randomInt } from "node:crypto";
import { MAIL } from "./config.js";
import { db, now, withTransaction } from "./db.js";
import { sendMail, type MailResult } from "./mailer.js";
import { withoutTelemetry, type RequestTelemetry } from "./telemetry.js";
export { drainTelemetry, scheduleTelemetryWork as scheduleOperationalWork } from "./telemetry.js";

export const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000] as const;
const RETENTION_SECONDS = 7 * 86400;
interface MetricRow { bucket_start: number; route: string; method: string; status_group: number; request_count: number; duration_sum_ms: number; duration_max_ms: number; histogram_json: string; }
interface Aggregate { count: number; errors: number; durationSumMs: number; maximumMs: number; histogram: number[]; }
function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
function histogram(json?: string): number[] {
  if (!json) return LATENCY_BUCKETS_MS.map(() => 0);
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length !== LATENCY_BUCKETS_MS.length || value.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error("Operational histogram is invalid");
  return value as number[];
}
export function latencyPercentile(counts: readonly number[], quantile: number, maximumMs: number): number | null {
  const count = counts.reduce((total, value) => total + value, 0);
  if (!count) return null;
  const rank = Math.ceil(count * quantile);
  let running = 0;
  for (let index = 0; index < counts.length; index += 1) {
    running += counts[index];
    if (running >= rank) return Math.min(index === counts.length - 1 ? maximumMs : LATENCY_BUCKETS_MS[index], maximumMs);
  }
  return maximumMs;
}
export async function persistRequestTelemetry(record: RequestTelemetry): Promise<void> {
  await withoutTelemetry(() => withTransaction(async () => {
    // Defend this internal boundary as well as the middleware: telemetry never
    // stores raw URLs, queries, headers, exception messages or user identifiers.
    if (!/^[a-f0-9]{32}$/.test(record.requestId) || !/^[a-f0-9]{32}$/.test(record.traceId)
      || !/^(?:unmatched|\/[A-Za-z0-9_:/-]{0,159})$/.test(record.route) || !/^[A-Z]{1,8}$/.test(record.method)
      || !Number.isFinite(record.durationMs) || record.durationMs < 0 || record.durationMs > 86400000
      || !Number.isInteger(record.status) || record.status < 100 || record.status > 599) throw new Error("Invalid operational record");
    const timestamp = now(), bucket = Math.floor(timestamp / 60) * 60, group = Math.floor(record.status / 100);
    const existing = await db.prepare("SELECT request_count,duration_sum_ms,duration_max_ms,histogram_json FROM runtime_request_metrics WHERE bucket_start=? AND route=? AND method=? AND status_group=?")
      .get(bucket, record.route, record.method, group) as Pick<MetricRow, "request_count" | "duration_sum_ms" | "duration_max_ms" | "histogram_json"> | undefined;
    const buckets = histogram(existing?.histogram_json);
    const index = LATENCY_BUCKETS_MS.findIndex((bound) => record.durationMs <= bound);
    buckets[index < 0 ? buckets.length - 1 : index] += 1;
    await db.prepare("INSERT INTO runtime_request_metrics(bucket_start,route,method,status_group,request_count,duration_sum_ms,duration_max_ms,histogram_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(bucket_start,route,method,status_group) DO UPDATE SET request_count=excluded.request_count,duration_sum_ms=excluded.duration_sum_ms,duration_max_ms=excluded.duration_max_ms,histogram_json=excluded.histogram_json")
      .run(bucket, record.route, record.method, group, (existing?.request_count ?? 0) + 1, (existing?.duration_sum_ms ?? 0) + record.durationMs, Math.max(existing?.duration_max_ms ?? 0, record.durationMs), JSON.stringify(buckets));
    const sampled = record.status >= 500 || record.durationMs >= 1000 || randomInt(10000) < setting("TRACE_SAMPLE_PERCENT", 1, 0, 100) * 100;
    if (sampled) {
      const spans = record.spans.slice(0, 64).filter((span) => /^[a-z][a-z0-9_.:-]{0,63}$/.test(span.name) && Number.isFinite(span.durationMs) && span.durationMs >= 0)
        .map((span) => ({ name: span.name, durationMs: Math.min(span.durationMs, 86400000), failed: span.failed === true,
          ...(/^[a-f0-9]{16}$/.test(span.spanId || "") ? { spanId: span.spanId } : {}),
          ...(/^[a-f0-9]{16}$/.test(span.parentSpanId || "") ? { parentSpanId: span.parentSpanId } : {}) }));
      await db.prepare("INSERT INTO runtime_traces(request_id,trace_id,route,method,status,duration_ms,spans_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING")
        .run(record.requestId, record.traceId, record.route, record.method, record.status, record.durationMs, JSON.stringify({ spans, droppedSpans: Math.min(1000000, Math.max(0, record.droppedSpans || 0)),
          ...(Number.isFinite(record.streamDurationMs) && record.streamDurationMs! >= 0 ? { latencyBasis: "headers", streamDurationMs: Math.min(record.streamDurationMs!, 86400000) } : {}) }), timestamp);
    }
    const pruned = await db.prepare("SELECT value FROM operational_state WHERE key='telemetry.pruned_at'").get() as { value: string } | undefined;
    if (!pruned || Number(pruned.value) < bucket) {
      await db.prepare("DELETE FROM runtime_request_metrics WHERE bucket_start<?").run(timestamp - RETENTION_SECONDS);
      await db.prepare("DELETE FROM runtime_traces WHERE created_at<?").run(timestamp - RETENTION_SECONDS);
      await db.prepare("DELETE FROM runtime_traces WHERE request_id IN (SELECT request_id FROM runtime_traces ORDER BY created_at DESC,request_id DESC LIMIT 2147483647 OFFSET 20000)").run();
      await db.prepare("INSERT INTO operational_state(key,value,updated_at) VALUES('telemetry.pruned_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(bucket), timestamp);
    }
  }));
}
function aggregate(): Aggregate { return { count: 0, errors: 0, durationSumMs: 0, maximumMs: 0, histogram: histogram() }; }
function add(target: Aggregate, row: MetricRow): void {
  target.count += row.request_count;
  target.errors += row.status_group >= 5 ? row.request_count : 0;
  target.durationSumMs += row.duration_sum_ms;
  target.maximumMs = Math.max(target.maximumMs, row.duration_max_ms);
  histogram(row.histogram_json).forEach((value, index) => { target.histogram[index] += value; });
}
function summary(total: Aggregate) {
  return { count: total.count, errors: total.errors, errorRate: total.count ? total.errors / total.count : 0,
    averageMs: total.count ? total.durationSumMs / total.count : null, maximumMs: total.maximumMs,
    p95Ms: latencyPercentile(total.histogram, .95, total.maximumMs), p99Ms: latencyPercentile(total.histogram, .99, total.maximumMs), histogram: total.histogram };
}
export async function operationalMetrics(minutes = 60) {
  const windowMinutes = Math.max(5, Math.min(1440, Math.floor(Number.isFinite(minutes) ? minutes : 60)));
  return await withoutTelemetry(async () => {
    const rows = await db.prepare("SELECT bucket_start,route,method,status_group,request_count,duration_sum_ms,duration_max_ms,histogram_json FROM runtime_request_metrics WHERE bucket_start>=? ORDER BY bucket_start DESC LIMIT 20001")
      .all(now() - windowMinutes * 60) as MetricRow[];
    const total = aggregate(), routes = new Map<string, Aggregate>();
    for (const row of rows.slice(0, 20000)) {
      if (row.route.startsWith("/api/ops")) continue;
      add(total, row);
      const key = `${row.method} ${row.route}`;
      const group = routes.get(key) ?? aggregate();
      add(group, row); routes.set(key, group);
    }
    const availability = setting("SLO_AVAILABILITY_PERCENT", 99.9, 90, 99.999);
    const allowedErrors = total.count * (1 - availability / 100), remainingErrors = allowedErrors - total.errors;
    return { windowMinutes, generatedAt: now(), truncated: rows.length > 20000, totals: summary(total), latencyBucketUpperBoundsMs: LATENCY_BUCKETS_MS,
      percentileMethod: "histogram upper bound" as const,
      slo: { availabilityTargetPercent: availability, availabilityPercent: total.count ? (1 - total.errors / total.count) * 100 : null,
        p95TargetMs: setting("SLO_P95_MS", 750, 25, 300000), allowedErrors, remainingErrors,
        budgetRemainingPercent: allowedErrors ? Math.max(0, Math.min(100, remainingErrors / allowedErrors * 100)) : null,
        burnRate: allowedErrors ? total.errors / allowedErrors : 0 },
      routes: [...routes].sort((left, right) => right[1].count - left[1].count).slice(0, 200).map(([route, value]) => ({ route, ...summary(value) })) };
  });
}
export interface BackupReport { backupId: string; status: "succeeded" | "failed"; encrypted: boolean; checksum?: string; bytes?: number; completedAt: number; }
export async function recentOperationalTraces(limit = 20) {
  const rows = await db.prepare("SELECT request_id,trace_id,route,method,status,duration_ms,spans_json,created_at FROM runtime_traces ORDER BY created_at DESC,request_id DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as { request_id: string; trace_id: string; route: string; method: string; status: number; duration_ms: number; spans_json: string; created_at: number }[];
  return rows.map((row) => ({ requestId: row.request_id, traceId: row.trace_id, route: row.route, method: row.method, status: row.status, durationMs: row.duration_ms, createdAt: row.created_at, ...JSON.parse(row.spans_json) as { spans: unknown[]; droppedSpans: number } }));
}
export async function recordBackupReport(report: BackupReport): Promise<void> {
  await withTransaction(async () => {
    const previous = await db.prepare("SELECT value FROM operational_state WHERE key='backup.last_report'").get() as { value: string } | undefined;
    if (previous && (JSON.parse(previous.value) as BackupReport).completedAt > report.completedAt) throw Object.assign(new Error("A newer backup report is already recorded"), { status: 409, code: "BACKUP_REPORT_STALE" });
    await db.prepare("INSERT INTO operational_state(key,value,updated_at) VALUES('backup.last_report',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(report), now());
    if (report.status === "succeeded") await db.prepare("INSERT INTO operational_state(key,value,updated_at) VALUES('backup.last_success',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(report), now());
  });
}
type AlertSender = (recipient: string, subject: string, text: string) => Promise<MailResult>;
const ALERT_RETRY_SECONDS = 600;
const ALERT_REPEAT_SECONDS = 6 * 3600;
let outageAlert: { recipient: string; attemptedAt: number; sentAt?: number } | undefined;

export async function operationalCheck(options: { send?: AlertSender } = {}) {
  const reasons: string[] = [];
  let metrics: Awaited<ReturnType<typeof operationalMetrics>> | null = null;
  let lastBackup: BackupReport | null = null;
  try {
    await db.prepare("SELECT 1 AS ok").get();
    metrics = await operationalMetrics(60);
    const row = await db.prepare("SELECT value FROM operational_state WHERE key='backup.last_success'").get() as { value: string } | undefined;
    lastBackup = row ? JSON.parse(row.value) as BackupReport : null;
    const latestReport = await db.prepare("SELECT value FROM operational_state WHERE key='backup.last_report'").get() as { value: string } | undefined;
    if (latestReport && (JSON.parse(latestReport.value) as BackupReport).status === "failed") reasons.push("backup_failed");
    if (metrics.truncated) reasons.push("metrics_capacity");
    if (metrics.totals.count >= setting("SLO_MIN_REQUESTS", 20, 1, 1000000) && metrics.slo.remainingErrors < 0) reasons.push("availability_budget_exhausted");
    if (metrics.totals.count >= setting("SLO_MIN_REQUESTS", 20, 1, 1000000) && (metrics.totals.p95Ms ?? 0) > metrics.slo.p95TargetMs) reasons.push("latency_slo_breached");
    if (!lastBackup || !lastBackup.encrypted || now() - lastBackup.completedAt > setting("BACKUP_MAX_AGE_HOURS", 30, 1, 168) * 3600) reasons.push("backup_stale_or_missing");
  } catch { reasons.push("database_unavailable"); }
  const databaseUnavailable = reasons.includes("database_unavailable");
  if (!databaseUnavailable) outageAlert = undefined;
  const recipient = process.env.ALERT_TO || "";
  let notification: "unconfigured" | "throttled" | "sent" | "failed" = "unconfigured";
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient) && (options.send || MAIL.provider === "smtp")) {
    const fingerprint = reasons.join(",") || "healthy";
    const send = () => (options.send || sendMail)(recipient, reasons.length ? "Groundwork operational alert" : "Groundwork operational recovery",
      `Status: ${reasons.length ? "attention required" : "healthy"}\nChecks: ${reasons.join(", ") || "all clear"}\nRequests in last hour: ${metrics?.totals.count ?? "unavailable"}\nService errors: ${metrics?.totals.errors ?? "unavailable"}\nP95 latency ms: ${metrics?.totals.p95Ms ?? "unavailable"}\nLast encrypted backup timestamp: ${lastBackup?.completedAt ?? "unavailable"}`);
    try {
      notification = "throttled";
      if (databaseUnavailable) {
        // Reserve locally before awaiting SMTP. No database read or write is
        // required to notify about the outage itself.
        const attemptedAt = now();
        const previous = outageAlert?.recipient === recipient ? outageAlert : undefined;
        if (!previous || (attemptedAt - previous.attemptedAt >= ALERT_RETRY_SECONDS
          && (previous.sentAt === undefined || attemptedAt - previous.sentAt >= ALERT_REPEAT_SECONDS))) {
          const attempt: NonNullable<typeof outageAlert> = { recipient, attemptedAt };
          outageAlert = attempt;
          const result = await send();
          if (result.delivered) attempt.sentAt = now();
          notification = result.delivered ? "sent" : "failed";
        }
      } else {
        const claimed = await withTransaction(async () => {
          const row = await db.prepare("SELECT value FROM operational_state WHERE key='alerts.runtime'").get() as { value: string } | undefined;
          const state = row ? JSON.parse(row.value) as { lastSentFingerprint?: string; lastNotifiedAt?: number; lastAttemptAt?: number; lastAttemptFingerprint?: string } : {};
          const actionable = reasons.length > 0 || Boolean(state.lastSentFingerprint && state.lastSentFingerprint !== "healthy");
          if (!actionable || (state.lastAttemptFingerprint === fingerprint && state.lastAttemptAt && now() - state.lastAttemptAt < ALERT_RETRY_SECONDS)
            || (state.lastSentFingerprint === fingerprint && now() - (state.lastNotifiedAt || 0) < ALERT_REPEAT_SECONDS)) return false;
          await db.prepare("INSERT INTO operational_state(key,value,updated_at) VALUES('alerts.runtime',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify({ ...state, lastAttemptAt: now(), lastAttemptFingerprint: fingerprint }), now());
          return true;
        });
        if (claimed) {
          const result = await send();
          notification = result.delivered ? "sent" : "failed";
          if (result.delivered) await db.prepare("UPDATE operational_state SET value=?,updated_at=? WHERE key='alerts.runtime'")
            .run(JSON.stringify({ lastSentFingerprint: fingerprint, lastNotifiedAt: now(), lastAttemptAt: now(), lastAttemptFingerprint: fingerprint }), now());
        }
      }
    } catch { notification = "failed"; }
  }
  return { healthy: reasons.length === 0, checkedAt: now(), reasons, notification, metrics, backup: lastBackup ? { status: lastBackup.status, encrypted: lastBackup.encrypted, completedAt: lastBackup.completedAt } : null };
}
