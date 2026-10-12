import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeState, fresh } from "../src/utils/runtime-state.js";
import { createOperations } from "../src/utils/operations.js";
import BaseDriver from "../src/drivers/base.js";
test("durable metadata tracks failures, recovery and stuck activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "signmate-test-"));
  try {
    let now = Date.now();
    const state = createRuntimeState(dir), ops = createOperations(state, () => now);
    for (let i = 0; i < 3; i++) {
      const run = ops.begin({ key: "test" }, "schedule"); now += 2000000;
      assert.equal(ops.active()[0].stuck, true);
      const result = ops.finish(run, { success: false, details: { retries: 2 } });
      assert.equal(result.details.durationMs, 2000000);
      assert.equal(result.details.source, "schedule");
    }
    assert.equal(state.read().runs.test.consecutiveFailures, 3);
    ops.finish(ops.begin({ key: "test" }), { success: true });
    assert.equal(createRuntimeState(dir).read().runs.test.consecutiveFailures, 0);
    assert.equal(ops.active().length, 0);
    assert.ok(state.read().runs.test.lastFailureAt);
    assert.ok(state.read().runs.test.lastSuccessAt);
  } finally { rmSync(dir, { recursive: true }); }
});
test("cache rejects invalid, future and expired timestamps", () => {
  assert.equal(fresh("invalid"), false);
  assert.equal(fresh(new Date(Date.now() + 60000).toISOString()), false);
  assert.equal(fresh(new Date(0).toISOString()), false);
  assert.equal(fresh(new Date().toISOString()), true);
});
test("retry count reports actual thrown attempts", async () => {
  class Flaky extends BaseDriver { async signIn() { if (!this.failed) { this.failed = true; throw new Error("fixture failure"); } return { success: true }; } }
  const result = await new Flaky({ retry: 2, retry_delay_ms: 0 }, {}).runWithRetry();
  assert.equal(result.details.retries, 1);
  assert.equal(result.details.attempts, 2);
});
