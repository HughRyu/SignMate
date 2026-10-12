import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationQueue, publicVerification, classifySessionResult } from "../src/utils/session-verification.js";
test("stale checks cannot overwrite newer cookies; unsupported drivers never execute", async () => {
  const data = {};
  const state = { read: () => data, update: (section, key, value) => { (data[section] ||= {})[key] = value; } };
  let calls = 0;
  const queue = createVerificationQueue({ state, probe: async () => { calls++; return "verified"; } });
  const site = { key: "forum", driver: "forum-visit" };
  queue.enqueue(site, { forum: { cookie: "old-secret" } });
  queue.enqueue(site, { forum: { cookie: "new-secret" } });
  await queue.drain();
  assert.equal(calls, 1);
  assert.equal(publicVerification(data.verification.forum, { cookie: "new-secret" }).status, "verified");
  assert.equal(publicVerification(data.verification.forum, { cookie: "old-secret" }).status, "unverified");
  assert.ok(!JSON.stringify(data).includes("new-secret"));
  await queue.enqueue({ key: "other", driver: "unknown" }, { other: { cookie: "secret" } });
  assert.equal(calls, 1);
  assert.equal(data.verification.other.status, "unsupported");
});
test("network/challenge failures do not invalidate cookies", () => {
  assert.equal(classifySessionResult({ message: "HTTP 503" }), "unconfirmed");
  assert.equal(classifySessionResult({ message: "安全验证" }), "challenge");
  assert.equal(classifySessionResult({ message: "Cookie 已失效" }), "invalid");
});
