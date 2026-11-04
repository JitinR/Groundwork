import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import dotenv from "dotenv";

// The pure topology check may read deployment configuration; it must not
// initialize the database, workspace keys, routes or worker implementation.
dotenv.config = () => ({ parsed: {} });
const { requireAuthorityConfiguration } = await import("../src/topology.js");

test("HTTP authorities refuse native execution even when isolation is acknowledged", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      GROUNDWORK_SERVER_ROLE: "authority", GROUNDWORK_AUTHORITY_GATEWAY_MODE: "direct",
      GROUNDWORK_AUTHORITY_URL: "", NATIVE_ISOLATION_ACKNOWLEDGED: "true",
      GROUNDWORK_TRUSTED_PROXY_IPS: "",
    });
    for (const value of ["true", "1", "TRUE", "unexpected"]) {
      process.env.NATIVE_WORKER_ENABLED = value;
      assert.throws(() => requireAuthorityConfiguration(), /Native execution is disabled in HTTP authorities/);
    }
    process.env.NATIVE_WORKER_ENABLED = "false";
    assert.equal(requireAuthorityConfiguration().role, "authority");
    delete process.env.NATIVE_WORKER_ENABLED;
    assert.equal(requireAuthorityConfiguration().role, "authority");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("canonical API startup rejects native enablement before creating storage or loading key/database configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "groundwork-native-api-boundary-"));
  const storage = path.join(directory, "must-not-be-created");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      try { await import('./src/index.ts'); process.exitCode = 2; }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('Native execution is disabled in HTTP authorities')) process.exitCode = 78;
        else { console.error('Unexpected startup failure'); process.exitCode = 3; }
      }
    `], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 15_000,
      env: {
        ...process.env, NODE_OPTIONS: "", NODE_ENV: "production", GROUNDWORK_SERVER_ROLE: "authority",
        GROUNDWORK_AUTHORITY_GATEWAY_MODE: "direct", GROUNDWORK_AUTHORITY_URL: "", NATIVE_WORKER_ENABLED: "true",
        NATIVE_ISOLATION_ACKNOWLEDGED: "true", GROUNDWORK_DATA_DIR: storage,
        DATABASE_PROVIDER: "invalid-before-initialization", MASTER_KEY: "invalid-before-initialization",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 78, result.stderr);
    assert.equal(existsSync(storage), false, "API configuration must fail before filesystem/database initialization");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
