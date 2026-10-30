import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeState } from "../src/utils/runtime-state.js";
import { createFailurePolicy, confirmedAuthFailure } from "../src/utils/failure-policy.js";
const expired = { success: false, details: { failureType: "auth_expired" } };
const site = { key: "fixture", base_url: "https://fixture.invalid" };
const credential = { cookie: "local-fixture" };
const proxy = { urls: ["http://proxy.invalid"], testUrls: ["https://control.invalid"] };
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "signmate-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-20T04:00:00Z"), calls = 0;
  const state = createRuntimeState(dir);
  const deps = { state, now: () => now, direct: async () => { calls++; return { ok: false }; }, proxied: async () => { calls++; return { ok: false }; }, pool: async () => ({ ok: true, usableUrls: proxy.urls }), ...overrides };
  const policy = createFailurePolicy(deps);
  return { state, deps, policy, calls: () => calls, advance: (days = 1) => { now += days * 86400000; } };
}
test("three confirmed failures persist across restart; changed credential and successful manual recovery clear pause", t => {
  const f = fixture(t), p = f.policy;
  for (let i = 0; i < 3; i++) { assert.equal(p.gate(site.key, credential, true), ""); p.start(site.key, credential, true); p.record(site.key, credential, expired); }
  assert.match(p.gate(site.key, credential, true), /更新 Cookie/);
  assert.equal(p.gate(site.key, credential, false), "");
  f.advance();
  assert.equal(createFailurePolicy(f.deps).status(site.key, credential).authPaused, true);
  assert.equal(p.gate(site.key, { cookie: "new" }, true), "");
  p.record(site.key, credential, { success: true });
  assert.equal(p.gate(site.key, credential, true), "");
});
test("ambiguous login, challenges, missing credentials and HTTP errors cannot confirm expiry", t => {
  const { policy: p } = fixture(t);
  for (const message of ["Cookie 可能已过期", "Cookie 未配置", "HTTP 403 未登录", "安全验证 请重新登录", "Cookie 不完整"]) assert.equal(confirmedAuthFailure({ message }), false);
  p.record(site.key, credential, expired); p.record(site.key, credential, { message: "HTTP 503" }); p.record(site.key, credential, expired);
  assert.equal(p.status(site.key, credential).authFailures, 1);
  assert.equal(confirmedAuthFailure({ success: true, details: { failureType: "auth_expired" } }), false);
});
test("daily automatic budget resets by local day, not restart; manual calls do not consume it", t => {
  const f = fixture(t), p = f.policy;
  for (let i = 0; i < 3; i++) p.start(site.key, credential, true);
  assert.match(createFailurePolicy(f.deps).gate(site.key, credential, true), /明日/);
  p.start(site.key, credential, false);
  assert.equal(p.status(site.key, credential).dailyRuns, 3);
  f.advance(); assert.equal(p.gate(site.key, credential, true), "");
});
test("offline requires three consecutive days of three complete dual-route rounds, once per day", async t => {
  const f = fixture(t), p = f.policy;
  for (let day = 1; day <= 3; day++) {
    await p.checkOffline(site, credential, proxy); await p.checkOffline(site, credential, proxy);
    assert.equal(f.calls(), day * 6);
    assert.equal(p.status(site.key, credential).offlineDays, day);
    assert.equal(p.status(site.key, credential).autoDisabled, day === 3);
    if (day < 3) f.advance();
  }
  assert.match(p.gate(site.key, { cookie: "new" }, false), /自动禁用/);
  p.enable(site.key); assert.equal(p.status(site.key, credential).autoDisabled, false);
});
test("missing day, healthy HTTP errors, proxy outage and incomplete rounds break offline sequence", async t => {
  const f = fixture(t), p = f.policy;
  await p.checkOffline(site, credential, proxy); f.advance(2);
  await p.checkOffline(site, credential, proxy);
  assert.equal(p.status(site.key, credential).offlineDays, 1);
  f.advance();
  const http = createFailurePolicy({ ...f.deps, proxied: async () => ({ ok: false, status: 403, reachable: true }) });
  await http.checkOffline(site, credential, proxy);
  assert.equal(http.status(site.key, credential).offlineDays, 0);
  f.advance(); await p.checkOffline(site, credential, proxy); f.advance();
  let checks = 0;
  const broken = createFailurePolicy({ ...f.deps, pool: async () => ++checks === 1 ? { ok: true, usableUrls: proxy.urls } : { ok: false } });
  await broken.checkOffline(site, credential, proxy);
  assert.equal(broken.status(site.key, credential).offlineDays, 0);
  assert.equal(broken.status(site.key, credential).offlineOutcome, "inconclusive");
});
test("in-progress checks survive restart without double-counting; success clears offline evidence", async t => {
  const f = fixture(t); let release;
  const pending = new Promise(r => { release = r; });
  const p = createFailurePolicy({ ...f.deps, pool: async () => { await pending; return { ok: true, usableUrls: proxy.urls }; } });
  const work = p.checkOffline(site, credential, proxy);
  await createFailurePolicy(f.deps).checkOffline(site, credential, proxy);
  assert.equal(f.calls(), 0);
  release(); await work;
  assert.equal(f.calls(), 6);
  p.record(site.key, credential, { success: true });
  assert.equal(p.status(site.key, credential).offlineDays, 0);
  await p.checkOffline(site, credential, proxy);
  assert.equal(f.calls(), 6);
});

test("changing target URL starts new offline evidence rather than disabling a different site", async t => {
  const f = fixture(t);
  await f.policy.checkOffline(site, credential, proxy); f.advance();
  await f.policy.checkOffline(site, credential, proxy); f.advance();
  await f.policy.checkOffline({ ...site, base_url: "https://replacement.invalid" }, credential, proxy);
  assert.equal(f.policy.status(site.key, credential).offlineDays, 1);
  assert.equal(f.policy.status(site.key, credential).autoDisabled, false);
});
