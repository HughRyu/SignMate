import test from "node:test";
import assert from "node:assert/strict";
import FengDriver, { classifyFengApiResponse } from "../src/drivers/feng.js";

test("Feng API classification distinguishes expired credentials from HTML and upstream failures", () => {
  assert.equal(classifyFengApiResponse({ ok: true, status: 200, data: { status: { code: "0", message: "success" } } }), "verified");
  assert.equal(classifyFengApiResponse({ ok: true, status: 200, contentType: "text/html", text: "<html><body>temporary response</body></html>" }), "unconfirmed");
  assert.equal(classifyFengApiResponse({ ok: false, status: 401, data: {} }), "auth_expired");
  assert.equal(classifyFengApiResponse({ ok: false, status: 403, data: {} }), "challenge");
  assert.equal(classifyFengApiResponse({ ok: false, status: 429, data: {} }), "challenge");
  assert.equal(classifyFengApiResponse({ ok: false, status: 503, data: {} }), "unconfirmed");
  assert.equal(classifyFengApiResponse({ ok: true, status: 200, data: { status: { code: "401", message: "请先登录" } } }), "auth_expired");
  assert.equal(classifyFengApiResponse({ ok: true, status: 200, data: { status: { code: 401, message: "" } } }), "auth_expired");
});

test("Feng Cookie verification checks account status without submitting sign-in", async () => {
  const driver = new FengDriver({ key: "feng-com" }, { "feng-com": { cookie: `userInfo=${encodeURIComponent(JSON.stringify({ accessToken: "fixture-token", userInfo: { userId: "123" } }))}` } });
  const calls = [];
  driver.api = async path => {
    calls.push(path);
    return { ok: true, status: 200, data: { status: { code: "0", message: "success" }, data: { userName: "fixture", isSignedIn: true } } };
  };
  assert.equal((await driver.verifySession()).success, true);
  assert.deepEqual(calls, ["/v1/user/experience"]);
});

test("Feng transient HTML is not reported as an expired Cookie and is not retried as signin", async () => {
  const driver = new FengDriver({ key: "feng-com" }, { "feng-com": { cookie: `userInfo=${encodeURIComponent(JSON.stringify({ accessToken: "fixture-token" }))}` } });
  let calls = 0;
  driver.api = async path => {
    calls++;
    assert.equal(path, "/v1/user/experience");
    return { ok: true, status: 200, contentType: "text/html", text: "<html>temporary gateway response</html>", data: null };
  };
  const result = await driver.signIn();
  assert.equal(result.success, false);
  assert.equal(result.details.failureType, "unconfirmed");
  assert.match(result.message, /网页而非 JSON/);
  assert.doesNotMatch(JSON.stringify(result), /temporary gateway response|fixture-token/);
  assert.equal(calls, 1);
});
