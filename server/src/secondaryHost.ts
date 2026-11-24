import path from "node:path";
import { fileURLToPath } from "node:url";
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import { Transform, type TransformCallback } from "node:stream";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { browserHostMatches, browserMutationAllowed, normalizeIp, requireSecondaryConfiguration } from "./topology.js";
import { mountPublicSite } from "./publicSite.js";

const configuration = requireSecondaryConfiguration();
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", (address: string) => configuration.trustedProxyIps.includes(normalizeIp(address)));
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'", "ws:", "wss:"], fontSrc: ["'self'", "data:"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"] } }, referrerPolicy: { policy: "no-referrer" } }));
const agent = new https.Agent({ keepAlive: true, maxSockets: configuration.maximumInflight, maxTotalSockets: configuration.maximumInflight, maxFreeSockets: 8 });
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);
const methods = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
let inflight = 0;
const active = new Set<http.ClientRequest>();

function filteredHeaders(headers: IncomingHttpHeaders, request: boolean): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connectionNames = new Set((headers.connection || "").split(",").map((name) => name.trim().toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || hopHeaders.has(lower) || connectionNames.has(lower)) continue;
    if (lower.startsWith("x-groundwork-") &&
        lower !== (request ? "x-groundwork-account" : "x-groundwork-authority-id")) continue;
    if (request && (lower === "host" || lower === "forwarded" || lower.startsWith("x-forwarded-") || ["x-real-ip", "true-client-ip", "cf-connecting-ip"].includes(lower))) continue;
    result[name] = value;
  }
  return result;
}
class LimitedStream extends Transform {
  private bytes = 0;
  constructor(private limit: number) { super({ highWaterMark: 16 * 1024 }); }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) callback(new Error("STREAM_LIMIT"));
    else callback(null, chunk);
  }
}
function proxyApi(req: Request, res: Response): void {
  const reject = (status: number, error: string) => {
    // Do not drain a rejected/oversized upload on a reusable connection.
    res.setHeader("Connection", "close");
    res.once("finish", () => { if (!req.complete) req.destroy(); });
    res.status(status).json({ error });
  };
  if (!methods.has(req.method)) { res.setHeader("Allow", [...methods].join(", ")); reject(405, "HTTP method is not supported by the gateway"); return; }
  if (!browserHostMatches(req.get("Host"), configuration.publicOrigin)) { reject(421, "Use the canonical application host"); return; }
  if (!browserMutationAllowed(req, configuration.publicOrigin)) { reject(403, "Request must originate from the canonical application origin"); return; }
  const targetPath = req.originalUrl;
  if (targetPath.length > 8192 || !/^\/api(?:\/|\?|$)/.test(targetPath) || /[\x00-\x20\x7f\\#]/.test(targetPath)) { reject(400, "Invalid API target"); return; }
  const length = req.get("Content-Length");
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { reject(400, "Invalid request length"); return; }
  if (length !== undefined && Number(length) > configuration.maximumRequestBytes) { reject(413, "Request exceeds the gateway transfer budget"); return; }
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) && ((length !== undefined && Number(length) > 0) || req.get("Transfer-Encoding"))) { reject(400, "This method cannot carry a gateway request body"); return; }
  if (inflight >= configuration.maximumInflight) { res.setHeader("Retry-After", "5"); reject(503, "Gateway capacity is busy"); return; }
  // Concatenation to a validated origin keeps // and absolute-looking paths from
  // becoming alternate hosts. The gateway never follows upstream redirects.
  const target = new URL(`${configuration.authorityUrl}${targetPath}`);
  if (target.origin !== configuration.authorityUrl || !/^\/api(?:\/|$)/.test(target.pathname)) { reject(400, "Invalid authority target"); return; }
  const headers = filteredHeaders(req.headers, true);
  headers.host = target.host;
  headers["x-groundwork-gateway-secret"] = configuration.gatewaySecret;
  headers["x-groundwork-authority-id"] = configuration.authorityId;
  headers["x-groundwork-public-origin"] = configuration.publicOrigin;
  headers["x-forwarded-host"] = new URL(configuration.publicOrigin).host;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-for"] = normalizeIp(req.ip || req.socket.remoteAddress || "");
  inflight += 1;
  let released = false, failed = false;
  const requestLimit = new LimitedStream(configuration.maximumRequestBytes);
  let responseLimit: LimitedStream | null = null;
  let upstreamResponse: http.IncomingMessage | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let connectDeadline: ReturnType<typeof setTimeout> | null = null;
  let sseDeadline: ReturnType<typeof setTimeout> | null = null;
  const upstream = https.request(target, { method: req.method, headers, agent, rejectUnauthorized: true, maxHeaderSize: 16 * 1024 });
  active.add(upstream);
  const release = () => {
    if (released) return;
    released = true; inflight -= 1; active.delete(upstream);
    if (deadline) clearTimeout(deadline); if (connectDeadline) clearTimeout(connectDeadline); if (sseDeadline) clearTimeout(sseDeadline);
  };
  const disposeStreams = (cancelUpstream: boolean) => {
    req.unpipe(requestLimit); requestLimit.unpipe(upstream);
    upstreamResponse?.unpipe(responseLimit || res); responseLimit?.unpipe(res);
    requestLimit.destroy(); responseLimit?.destroy();
    if (cancelUpstream) { upstream.destroy(); upstreamResponse?.destroy(); }
  };
  const fail = (status: number, message: string) => {
    if (failed || released) return;
    failed = true; disposeStreams(true);
    if (!req.complete) res.once("finish", () => req.destroy());
    if (!res.headersSent) {
      res.removeHeader("Content-Length"); res.removeHeader("Content-Encoding"); res.removeHeader("Content-Disposition");
      res.setHeader("Connection", "close"); res.status(status).json({ error: message });
    } else res.destroy();
    release();
  };
  deadline = setTimeout(() => fail(504, "Authority request exceeded its deadline"), configuration.requestDeadlineMs);
  connectDeadline = setTimeout(() => fail(504, "Authority TLS connection could not be established"), configuration.connectDeadlineMs);
  upstream.setTimeout(configuration.idleTimeoutMs, () => fail(504, "Authority connection became inactive"));
  upstream.on("socket", (socket) => {
    const connected = () => { if (connectDeadline) clearTimeout(connectDeadline); connectDeadline = null; };
    if (socket.connecting) socket.once("secureConnect", connected); else connected();
  });
  upstream.on("error", () => fail(502, "The central API authority is unavailable"));
  upstream.on("upgrade", (_response, socket) => { socket.destroy(); fail(502, "Authority upgrades are unsupported by this gateway"); });
  upstream.on("response", (incoming) => {
    upstreamResponse = incoming;
    if (failed || released) { incoming.destroy(); return; }
    if (incoming.headers["x-groundwork-authority-id"] !== configuration.authorityId) { fail(502, "Authority identity did not match the configured gateway"); return; }
    const status = incoming.statusCode || 502;
    if (status < 200 || status > 599) { fail(502, "Authority returned an unsupported status"); return; }
    const sse = (incoming.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "text/event-stream";
    const declaredLength = incoming.headers["content-length"];
    if (!sse && declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > configuration.maximumResponseBytes)) { fail(502, "Authority response exceeds the gateway transfer budget"); return; }
    const outgoing = filteredHeaders(incoming.headers, false);
    outgoing["cache-control"] = "private, no-store";
    const location = incoming.headers.location;
    if (location) {
      // Preserve browser redirects (including configured OIDC authorization).
      // An absolute redirect to the private authority returns to the public host.
      try { const parsed = new URL(location, target); if (parsed.origin === configuration.authorityUrl) outgoing.location = `${configuration.publicOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`; } catch { fail(502, "Authority redirect is invalid"); return; }
    }
    res.status(status); for (const [name, value] of Object.entries(outgoing)) if (value !== undefined) res.setHeader(name, value);
    incoming.on("aborted", () => fail(502, "Authority response was interrupted"));
    incoming.on("error", () => fail(502, "Authority response failed"));
    if (sse) {
      if (deadline) clearTimeout(deadline); deadline = null;
      sseDeadline = setTimeout(() => fail(504, "Gateway event stream lifetime reached"), configuration.maximumSseLifetimeMs);
      res.flushHeaders(); incoming.pipe(res);
    } else {
      responseLimit = new LimitedStream(configuration.maximumResponseBytes);
      responseLimit.on("error", () => fail(502, "Authority response exceeds the gateway transfer budget"));
      incoming.pipe(responseLimit).pipe(res);
    }
  });
  requestLimit.on("error", () => fail(413, "Request exceeds the gateway transfer budget"));
  req.on("aborted", () => { release(); disposeStreams(true); res.destroy(); });
  req.on("error", () => { release(); disposeStreams(true); res.destroy(); });
  res.on("finish", () => {
    // Complete transfers may return their TLS socket to the agent. Abort only
    // unfinished uploads/responses; completion cleanup must not cancel reuse.
    release(); disposeStreams(!(req.complete && upstream.writableFinished && upstreamResponse?.complete));
    if (!req.complete) req.destroy();
  });
  res.on("close", () => {
    release(); disposeStreams(!(res.writableFinished && req.complete && upstream.writableFinished && upstreamResponse?.complete));
    if (!req.complete) req.destroy();
  });
  // No JSON/cookie/multipart parser runs on this host. Raw bytes and backpressure
  // are preserved through the bounded transforms, including webhook signatures.
  req.pipe(requestLimit).pipe(upstream);
}
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
}, proxyApi);
app.use("/api", (_req, res) => { res.status(502).json({ error: "Central API routing failed" }); });
mountPublicSite(app, clientDist);
app.use((_req, res) => { res.status(404).json({ error: "Secondary host asset not found" }); });
app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("[groundwork] Secondary gateway request failed", error instanceof Error ? error.name : "UnknownError");
  if (res.headersSent) res.destroy(); else res.status(502).json({ error: "Secondary gateway request failed" });
});
const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10000, requestTimeout: configuration.requestDeadlineMs }, app);
server.maxHeadersCount = 100; server.maxConnections = configuration.maximumInflight * 2; server.maxRequestsPerSocket = 100;
server.on("upgrade", (_req, socket) => {
  socket.once("error", () => socket.destroy());
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
});
server.on("connect", (_req, socket) => { socket.once("error", () => socket.destroy()); socket.destroy(); });
server.listen(configuration.port, configuration.bindHost, () => { console.log(`[groundwork] Secondary gateway for authority ${configuration.authorityId} is listening on port ${configuration.port}`); });
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true; server.close(); for (const request of active) request.destroy(); agent.destroy(); server.closeAllConnections();
}
process.once("SIGTERM", stop); process.once("SIGINT", stop);

