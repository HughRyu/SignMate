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
      { key: "denied", driver: "fixture", proxy_mode: "auto", proxy_last_mode: "offline", direct: { ok: false, reachable: true, status: 403 } },
      { key: "success", driver: "fixture", proxy_mode: "off" },
    ]) {
      const result = await runSingle(site, {}, { source: "manual-batch" });
      assert.equal(result.success, ["success", "denied"].includes(site.key));
      assert.equal(result.details.source, "manual-batch");
      assert.ok(result.details.runId);
      assert.ok(result.details.endedAt);
      assert.ok(result.details.durationMs >= 0);
    }
    let release;
    registerDriver("waiting", class {
      async runWithRetry() { await new Promise(resolve => { release = resolve; }); return { success: true }; }
      formatResult() { return "done"; }
    });
    const waitSite = { key: "wait", driver: "waiting", proxy_mode: "off" };
    const first = runSingle(waitSite, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await runSingle(waitSite, {})).skipped, true);
    release(); await first;
    const { runtimeState } = await import("../src/utils/runtime-state.js");
    const before = JSON.stringify(runtimeState.read().runs.success);
    await runSingle({ key: "success", driver: "fixture", proxy_mode: "off" }, {}, { diagnostic: true });
    assert.equal(JSON.stringify(runtimeState.read().runs.success), before);
  } finally { rmSync(dir, { recursive: true }); }
});
