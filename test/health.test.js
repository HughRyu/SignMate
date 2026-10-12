import test from "node:test";
import assert from "node:assert/strict";
import { healthReport } from "../src/utils/operations.js";
import { createBrowserHealthCheck } from "../src/utils/browser-health.js";
test("busy and stuck jobs do not cause restart loops; readiness failures do", () => {
  const ready = { configOk: true, diskOk: true, browserOk: true };
  const busy = healthReport({ ...ready, batch: { active: true }, active: [{ stuck: true, cookie: "private" }] });
  assert.equal(busy.ok, true);
  assert.equal(busy.batchActive, true);
  assert.equal(busy.stuckCount, 1);
  assert.ok(!JSON.stringify(busy).includes("private"));
  for (const field of Object.keys(ready)) assert.equal(healthReport({ ...ready, [field]: false }).ok, false);
});
test("browser readiness launches once, closes and caches both success and failure", async () => {
  let calls = 0, closed = 0, now = 1000;
  const check = createBrowserHealthCheck(async () => {
    calls++;
    if (calls > 1) throw new Error("browser failed");
    return { close: async () => closed++ };
  }, () => now);
  assert.deepEqual(await Promise.all([check(), check()]), [true, true]);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  now += 300001;
  assert.equal(await check(), false);
  assert.equal(await check(), false);
  assert.equal(calls, 2);
});
