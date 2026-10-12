import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "signmate-runner-"));
process.env.SIGNMATE_DATA_DIR = dir;
const { runSingle, registerDriver } = await import("../src/runner.js");
test("unknown drivers, offline exits and successful runs all retain operation metadata", async () => {
  try {
    registerDriver("fixture", class {
      async runWithRetry() { return { success: true, message: "fixture", details: { retries: 1 } }; }
      formatResult() { return "fixture"; }
    });
    for (const site of [
      { key: "unknown", driver: "missing" },
      { key: "offline", driver: "fixture", proxy_mode: "on", proxy_available: false },
      { key: "success", driver: "fixture", proxy_mode: "off" },
    ]) {
      const result = await runSingle(site, {}, { source: "schedule" });
      assert.equal(result.success, site.key === "success");
      assert.equal(result.details.source, "schedule");
      assert.ok(result.details.runId);
      assert.ok(result.details.endedAt);
      assert.ok(result.details.durationMs >= 0);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
