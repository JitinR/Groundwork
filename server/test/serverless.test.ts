import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Request, Response } from "express";
import { bindServerlessCancellation, readServerlessMode, serverlessStreamDeadline, vercelRequestContext } from "../src/serverlessRuntime.js";
import { readFileSync } from "node:fs";

test("only collaboration events opt into cancellation and aborted streams release response listeners", () => {
  const configuration = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(configuration.functions['api/collaboration.mjs'].supportsCancellation, true);
  assert.notEqual(configuration.functions['api/index.mjs'].supportsCancellation, true);
  const route = configuration.routes.find((value: { dest?: string }) => value.dest === '/api/collaboration');
  assert(new RegExp(route.src).test('/api/v1/collaboration/project/events'));
  assert(!new RegExp(route.src).test('/api/collaboration/project/operations'));
  const request = Object.assign(new EventEmitter(), { aborted: false });
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, end() { this.writableEnded = true; this.emit('finish'); } });
  bindServerlessCancellation(request as unknown as import('node:http').IncomingMessage, response as unknown as Response);
  request.emit('error', new Error('aborted'));
  assert.equal(response.writableEnded, true);
  assert.equal(request.listenerCount('error'), 0); assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

const configuration = {
  GROUNDWORK_SERVERLESS: "vercel", VERCEL: "1", NODE_ENV: "production", DATABASE_PROVIDER: "supabase",
  GROUNDWORK_DATA_DIR: "/tmp/groundwork", PUBLIC_APP_ORIGIN: "https://groundwork.example.com",
  VERCEL_URL: "groundwork-fixture.vercel.app", NATIVE_WORKER_ENABLED: "false",
};

test("serverless mode requires explicit Vercel production and hosted database configuration", () => {
  assert.equal(readServerlessMode({}), false);
  assert.equal(readServerlessMode(configuration), true);
  for (const override of [
    { GROUNDWORK_SERVERLESS: "" }, { GROUNDWORK_SERVERLESS: "true" }, { VERCEL: "" },
    { NODE_ENV: "development" }, { DATABASE_PROVIDER: "sqlite" },
    { DATABASE_ADMIN_URL: "synthetic-admin-value" }, { NATIVE_WORKER_ENABLED: "true" },
    { GROUNDWORK_SERVER_ROLE: "secondary" }, { GROUNDWORK_AUTHORITY_GATEWAY_MODE: "required" },
    { GROUNDWORK_DATA_DIR: "/persistent" }, { GROUNDWORK_DATA_DIR: "/tmp/../private" },
    { PUBLIC_APP_ORIGIN: "http://groundwork.example.com" }, { PUBLIC_APP_ORIGIN: "https://groundwork.example.com/path" },
  ]) assert.throws(() => readServerlessMode({ ...configuration, ...override }));
});

function request(headers: Record<string, string>, method = "GET", pathname = "/health") {
  const req = { headers: { ...headers }, method, path: pathname, get(name: string) { return this.headers[name.toLowerCase()]; } } as unknown as Request;
  let status = 200, nextCalled = false;
  let body: Record<string, unknown> | undefined;
  const res = { status(value: number) { status = value; return this; }, json(value: Record<string, unknown>) { body = value; return this; } } as unknown as Response;
  vercelRequestContext(configuration)(req, res, () => { nextCalled = true; });
  return { req, status, body, nextCalled };
}

test("Vercel identity rejects missing and chained identities and ignores spoofed generic forwarding", () => {
  assert.equal(request({ "x-forwarded-for": "203.0.113.99" }).status, 400);
  assert.equal(request({ "x-vercel-forwarded-for": "203.0.113.1, 203.0.113.2" }).status, 400);
  const valid = request({ "x-vercel-forwarded-for": "203.0.113.8", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" });
  assert.equal(valid.nextCalled, true);
  assert.equal(valid.req.ip, "203.0.113.8");
  assert.equal(valid.req.headers["x-forwarded-for"], "203.0.113.8");
  assert.equal(valid.req.headers["x-forwarded-proto"], "https");
  assert.equal(request({ "x-vercel-forwarded-for": "::ffff:203.0.113.9" }).req.ip, "203.0.113.9");
});

test("serverless browser mutations require the configured origin or trusted deployment URL", () => {
  const headers = { "x-vercel-forwarded-for": "203.0.113.8" };
  assert.equal(request(headers, "POST", "/auth/login").status, 403);
  assert.equal(request({ ...headers, origin: "https://attacker.example.com" }, "POST", "/auth/login").status, 403);
  assert.equal(request({ ...headers, origin: configuration.PUBLIC_APP_ORIGIN }, "POST", "/auth/login").nextCalled, true);
  assert.equal(request({ ...headers, origin: `https://${configuration.VERCEL_URL}` }, "POST", "/auth/login").nextCalled, true);
  assert.equal(request({ ...headers, referer: `${configuration.PUBLIC_APP_ORIGIN}/settings` }, "POST", "/auth/logout").nextCalled, true);
  assert.equal(request(headers, "POST", "/payments/webhook").nextCalled, true);
  assert.equal(request({ ...headers, origin: "https://attacker.example.com" }, "POST", "/payments/webhook").status, 403);
});

test("native machine origin exceptions cover only exact versioned POST actions", () => {
  const headers = { "x-vercel-forwarded-for": "203.0.113.8" }, job = "a".repeat(32);
  for (const suffix of ["claim", ...["renew", "input", "output", "complete", "fail"].map(action => `jobs/${job}/${action}`)]) {
    assert.equal(request(headers, "POST", `/native-worker/v1/${suffix}`).nextCalled, true);
  }
  for (const pathname of ["/native-worker/v1/claim/extra", "/native-worker/v1//claim", `/native-worker/v1/jobs/${job}/delete`, "/native-worker/v2/claim", "/projects"]) {
    assert.equal(request(headers, "POST", pathname).status, 403);
  }
  assert.equal(request(headers, "DELETE", `/native-worker/v1/jobs/${job}/complete`).status, 403);
});

class StreamResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  endings = 0;
  end() { this.endings++; this.writableEnded = true; this.emit("finish"); return this; }
}

test("serverless SSE ends before the platform deadline and removes timeout listeners", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const response = new StreamResponse();
  serverlessStreamDeadline(response as unknown as Response);
  context.mock.timers.tick(239_999);
  assert.equal(response.endings, 0);
  context.mock.timers.tick(1);
  assert.equal(response.endings, 1);
  assert.equal(response.listenerCount("finish"), 0);
  assert.equal(response.listenerCount("close"), 0);
  context.mock.timers.tick(300_000);
  assert.equal(response.endings, 1);
});

test("closing an SSE connection early cancels the serverless deadline", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const response = new StreamResponse();
  serverlessStreamDeadline(response as unknown as Response);
  response.emit("close");
  context.mock.timers.tick(300_000);
  assert.equal(response.endings, 0);
  assert.equal(response.listenerCount("finish"), 0);
});
